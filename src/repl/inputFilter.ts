/**
 * RQ-TERM-2: keep environment-activation lines out of the board.
 *
 * The Python extension (legacy path) types an activation command into every new terminal with `sendText`, and it does not skip
 * `pty` terminals. For our terminal that text arrives in `handleInput`, i.e. it would be written to the board's REPL. During the
 * first seconds after the terminal was created, and before any real keystroke, a chunk that looks like such a line is dropped.
 *
 * "Real keystroke" means: the first chunk that is not dropped. After that the window is closed for good, so a student who
 * types or pastes real Python code that mentions `activate` is never affected. (Activation text is always one chunk: it comes
 * from one `sendText` call, while a person types one key per chunk.)
 *
 * Pure module: no `vscode` import. Time is injected for tests.
 */

const ACTIVATE = String.raw`(?:activate|Activate)(?:\.(?:bat|ps1|fish|csh|nu|sh))?`;
/**
 * A path that ends in the activate script, optionally followed by an environment name. A path with spaces must be quoted
 * (as the Python tooling does), so Python code such as `x = a/activate` is not mistaken for one.
 */
const ACTIVATE_PATH =
  String.raw`(?:"[^"\r\n]*[\\/]${ACTIVATE}"|'[^'\r\n]*[\\/]${ACTIVATE}'|[^\s"']*[\\/]${ACTIVATE})(?:[ \t]+[\w.\-]+)*`;
const BARE_SCRIPT = String.raw`(?:activate\.(?:bat|ps1|fish|csh|nu)|Activate\.ps1)`;

const PATTERNS: readonly RegExp[] = [
  // zsh/bash/fish/csh: `source /x/.venv/bin/activate`, `. "/x y/bin/activate"`, `source ~/miniconda3/bin/activate base`
  new RegExp(String.raw`^(?:source|\.)[ \t]+${ACTIVATE_PATH}$`),
  // conda's old form: `source activate myenv`
  new RegExp(String.raw`^(?:source|\.)[ \t]+activate(?:[ \t]+[\w.\-]+)?$`),
  // a bare path to the script: `/x/.venv/bin/activate`, `C:\x\.venv\Scripts\activate.bat`, `.\venv\Scripts\Activate.ps1`
  new RegExp(String.raw`^(?:(?:call|&)[ \t]+)?${ACTIVATE_PATH}$`),
  // cmd/PowerShell with the script name only: `activate.bat`, `.\Activate.ps1`, `call activate.bat`
  new RegExp(String.raw`^(?:(?:call|&)[ \t]+)?(?:\.[\\/])?${BARE_SCRIPT}$`),
  // conda family: `conda activate base`, `C:\...\conda.exe activate x`, `micromamba activate x`
  /^(?:["']?[^\r\n"']*[\\/])?(?:conda|mamba|micromamba)(?:\.exe|\.bat)?["']?[ \t]+activate(?:[ \t]+\S.*)?$/,
];

/** True when every non-empty line of `data` looks like an environment activation command. */
export function looksLikeActivation(data: string): boolean {
  const lines = data.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines.length > 0 && lines.every((line) => PATTERNS.some((p) => p.test(line)));
}

export interface InputFilterOptions {
  /** How long after creation activation text is dropped. Default 10 s (RQ-TERM-2). */
  windowMs?: number;
  /** Clock in milliseconds; tests inject their own. */
  now?: () => number;
}

export const ACTIVATION_WINDOW_MS = 10_000;

export class ActivationInputFilter {
  private readonly createdAt: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private typed = false;

  constructor(options: InputFilterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? ACTIVATION_WINDOW_MS;
    this.createdAt = this.now();
  }

  /** True once a chunk got through: from then on nothing is dropped. */
  get userHasTyped(): boolean {
    return this.typed;
  }

  /**
   * Decide about one `handleInput` chunk. Returns `true` when it must be forwarded to the board; `false` when it was recognised
   * as environment-activation text and must be dropped (the caller logs it).
   */
  accept(data: string): boolean {
    if (this.typed) {
      return true;
    }
    if (this.now() - this.createdAt <= this.windowMs && looksLikeActivation(data)) {
      return false;
    }
    this.typed = true;
    return true;
  }
}
