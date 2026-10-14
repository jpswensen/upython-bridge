/**
 * What sync never touches: the default list plus `.mpyignore` at the workspace root (gitignore syntax, negation works)
 * and, as a fallback, the legacy old-extension ignore file (D-06, docs/analysis/03-fs-sync.md section 6.7).
 * Pure Node (no `vscode`): one matcher instance is shared by auto-sync, plan building and uploads.
 */
import ignore, { type Ignore } from 'ignore';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { IDENTITY, LEGACY } from '../identity';
import { writeFileAtomic } from './atomic';

/**
 * Built-in rules, applied first. A user rule written later (for example `!typings/keep.py`) can still re-include a path,
 * as in git. Grouped so the generated `.mpyignore` can explain them to students.
 */
export const DEFAULT_IGNORE_GROUPS: readonly { title: string; patterns: readonly string[] }[] = [
  {
    title: 'Files made for the editor and for IntelliSense (never belong on the board)',
    patterns: [`${IDENTITY.dotDir}/`, `${LEGACY.dotDir}/`, 'course-stubs/', 'typings/', 'pyrightconfig.json', '*.pyi', '.vscode/', '.idea/'],
  },
  {
    title: 'Python environments and tool folders',
    patterns: ['.venv/', 'venv/', 'env/', '.git/', '.gitignore', '.gitattributes', 'node_modules/', '__pycache__/', '*.pyc', '*.pyo'],
  },
  {
    title: 'Operating-system and cloud-folder leftovers (OneDrive, iCloud, Dropbox touch files without changing them)',
    patterns: [
      '.DS_Store', 'Thumbs.db', 'desktop.ini', '~$*', '*.tmp', '*.swp', '*~', '.~lock.*#', '*.part', '*.crdownload', '*.icloud',
      '.dropbox', '.dropbox.attr', '.dropbox.cache/', 'Icon', '.Trash*/', '.fseventsd/', '.Spotlight-V100/', '*.mpytmp',
    ],
  },
  {
    title: 'This ignore file itself',
    patterns: [IDENTITY.ignoreFile],
  },
];

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = DEFAULT_IGNORE_GROUPS.flatMap((g) => g.patterns);

/** Decides which workspace-relative POSIX paths sync leaves alone. */
export class IgnoreMatcher {
  private readonly matcher: Ignore;

  /**
   * @param extraRules rule texts in increasing priority (legacy file first, workspace `.mpyignore` last)
   * @param ignoreCase gitignore is case-sensitive on Linux; macOS and Windows file systems are not (default true)
   */
  constructor(extraRules: string | readonly string[] = [], ignoreCase = true) {
    this.matcher = ignore({ ignorecase: ignoreCase });
    this.matcher.add([...DEFAULT_IGNORE_PATTERNS]);
    for (const text of typeof extraRules === 'string' ? [extraRules] : extraRules) {
      this.matcher.add(text);
    }
  }

  /**
   * True when `rel` (workspace-relative, POSIX, no leading slash) must be skipped. Pass `isDir` for folders so rules such as
   * `build/` match. A path that cannot be a valid relative path (empty, absolute, `..`) is reported as ignored.
   */
  ignores(rel: string, isDir = false): boolean {
    const clean = rel.replace(/\/+$/, '');
    if (clean === '' || clean.startsWith('/') || clean.split('/').some((s) => s === '..' || s === '.' || s === '')) {
      return true;
    }
    return this.matcher.ignores(isDir ? `${clean}/` : clean);
  }
}

/** Why a rule file could not be read (shown by the caller; never fatal). */
export interface IgnoreLoadResult {
  matcher: IgnoreMatcher;
  /** Rule files that were found, in the order applied. */
  sources: string[];
  warnings: string[];
}

async function readIfExists(file: string, warnings: string[]): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    warnings.push(`Could not read ${nodePath.basename(file)}: ${(err as Error).message}. The default ignore list is used.`);
    return undefined;
  }
}

/** Build the matcher for a workspace folder: defaults, then the legacy file, then the workspace `.mpyignore`. */
export async function loadIgnoreMatcher(workspaceRoot: string, ignoreCase = true): Promise<IgnoreLoadResult> {
  const warnings: string[] = [];
  const sources: string[] = [];
  const texts: string[] = [];
  const candidates = [
    nodePath.join(workspaceRoot, LEGACY.dotDir, LEGACY.ignoreFile),
    nodePath.join(workspaceRoot, IDENTITY.ignoreFile),
  ];
  for (const file of candidates) {
    const text = await readIfExists(file, warnings);
    if (text !== undefined) {
      texts.push(text);
      sources.push(file);
    }
  }
  return { matcher: new IgnoreMatcher(texts, ignoreCase), sources, warnings };
}

/** Text of a new `.mpyignore`: the defaults written out with plain-English comments, plus a place for the student's own rules. */
export function defaultIgnoreFileText(): string {
  const lines: string[] = [
    `# ${IDENTITY.ignoreFile}: files and folders that are NOT copied to the board.`,
    '# Same rules as .gitignore: one pattern per line, "#" starts a comment, a trailing "/" means a folder,',
    '# and a leading "!" brings back something an earlier rule ignored.',
    '# The built-in rules below are always active, even if you delete them here. They are listed so you can see them.',
    '',
  ];
  for (const g of DEFAULT_IGNORE_GROUPS) {
    lines.push(`# ${g.title}`, ...g.patterns, '');
  }
  lines.push('# Your own rules go here, for example:', '# data/', '# notes.txt', '');
  return lines.join('\n');
}

/** Create the workspace `.mpyignore` if it does not exist yet. Returns true when a file was written. */
export async function createDefaultIgnoreFile(workspaceRoot: string): Promise<{ created: boolean; file: string }> {
  const file = nodePath.join(workspaceRoot, IDENTITY.ignoreFile);
  try {
    await fsp.access(file);
    return { created: false, file };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  await writeFileAtomic(file, defaultIgnoreFileText());
  return { created: true, file };
}
