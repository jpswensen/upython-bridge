/**
 * Links (symbolic links, junctions) inside the managed area. The tracker and the dot folder travel with a zip or a git checkout,
 * and both can carry links, so a path that lies below the workspace by its text may lead anywhere. The extension therefore never
 * writes or deletes THROUGH a link below the workspace folder. (A link AT or ABOVE the workspace folder, for example a OneDrive
 * alias of the project folder, is the user's own business and is followed.)
 */
import type { FsLike } from './types';

/**
 * The first link on the way from `workspace` (exclusive) to `target`, as an absolute path; null when there is none, when
 * something on the way does not exist yet (nothing below it can be a link), or when the file system knows no links.
 * With `includeLast: false` the final component may itself be a link: removing a link removes the link, not what it points to.
 */
export async function linkOnPath(fs: FsLike, workspace: string, target: string, options: { includeLast: boolean }): Promise<string | null> {
  const lstat = fs.lstat?.bind(fs);
  if (lstat === undefined) { return null; }
  const path = fs.path;
  const root = path.resolve(workspace);
  const parts = path.relative(root, path.resolve(target)).split(/[\\/]/).filter((p) => p !== '');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '..') { return null; } // outside the workspace: the caller's own check refuses it
    current = path.join(current, parts[i] as string);
    if (i === parts.length - 1 && !options.includeLast) { return null; }
    const st = await lstat(current);
    if (st === null) { return null; }
    if (st.isSymlink) { return current; }
  }
  return null;
}

/** The message for a refused write or delete. */
export function linkMessage(rel: string, link: string): string {
  return `${rel} is behind the link ${link}, which may lead outside your project folder, so it was left alone. Delete that link (or the whole folder it is in) and run the setup again.`;
}
