/**
 * The consent flow helper (docs/extension-design.md section 3). Bridge ops that need an idle board answer E_PROGRAM_RUNNING with
 * `needs_interrupt`: ask the user ONCE, then repeat with `interrupt:true`. `fs.rmtree` of a mount point answers
 * `needs_allow_mount`: ask, then repeat with `allowMount:true`. Nothing is sent to the board before the user agrees, and a
 * "no" is a quiet cancellation (`isDeclined`), not an error toast.
 */
import type { OpArgs, OpName, OpResult } from '../types/protocol';
import { BoardError, isBoardError, type BoardSession, type CallOptions } from '../types/session';

export interface ConsentPrompter {
  /** The program on the board has to be interrupted for `op` to work. Resolves true when the user agrees. */
  confirmInterrupt(op: OpName, error: BoardError): Promise<boolean>;
  /** `path` is a drive of the board itself (a mount point), not an ordinary folder. */
  confirmAllowMount(path: string, error: BoardError): Promise<boolean>;
}

const DECLINED = 'declined';

/** The user said no to a consent question: nothing went wrong and nothing was done. */
export function isDeclined(err: unknown): boolean {
  return isBoardError(err, 'E_ABORTED') && err.detail === DECLINED;
}

function declined(op: OpName): BoardError {
  return BoardError.of('E_ABORTED', 'Cancelled. The program on the board was left alone.', { detail: DECLINED }, op);
}

/** `session.call` with the consent questions answered through `prompter`. At most one question per kind per call. */
export async function withConsent<K extends OpName>(
  session: Pick<BoardSession, 'call'>, prompter: ConsentPrompter, op: K, args: OpArgs<K>, opts?: CallOptions,
): Promise<OpResult<K>> {
  let current = args;
  let askedInterrupt = false;
  let askedMount = false;
  for (;;) {
    try {
      return await session.call(op, current, opts);
    } catch (err) {
      if (!isBoardError(err)) {
        throw err;
      }
      const a = current as { interrupt?: boolean; allowMount?: boolean; path?: string };
      if (err.needsInterrupt && a.interrupt !== true && !askedInterrupt) {
        askedInterrupt = true;
        if (!(await prompter.confirmInterrupt(op, err))) {
          throw declined(op);
        }
        current = { ...current, interrupt: true };
        continue;
      }
      if (err.needsAllowMount && a.allowMount !== true && !askedMount) {
        askedMount = true;
        if (!(await prompter.confirmAllowMount(a.path ?? '', err))) {
          throw declined(op);
        }
        current = { ...current, allowMount: true };
        continue;
      }
      throw err;
    }
  }
}
