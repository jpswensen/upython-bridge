/**
 * Keystrokes from the terminal to the board, raw (RQ-RUN-1): no line buffering, no local echo, no interpretation.
 *
 * Batching: everything typed in the same turn of the event loop goes out as one `tty.write`; while a write is in flight the
 * next keys wait and follow together. A long paste is cut into small writes (a MicroPython UART has a small receive buffer),
 * never in the middle of a UTF-8 character. Ctrl-C is the exception: it never waits behind anything, the whole queue (it
 * included) is sent at once, so Stop-by-keyboard works even if an earlier write is slow. Order is always preserved because the
 * session sends requests in call order.
 *
 * Pure module: no `vscode` import. The sink does the actual call.
 */

/** Most bytes in one `tty.write`. */
export const MAX_WRITE_BYTES = 256;

const CTRL_C = '\x03';

export type WriteSink = (b64: string) => Promise<unknown>;

/** Split into pieces of at most `maxBytes` UTF-8 bytes without cutting a character. */
export function splitUtf8(text: string, maxBytes: number): Uint8Array[] {
  const bytes = Buffer.from(text, 'utf8');
  const out: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    if (end < bytes.length) {
      // back up over continuation bytes (10xxxxxx) so the next piece starts on a character boundary
      while (end > start + 1 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
        end--;
      }
    }
    out.push(bytes.subarray(start, end));
    start = end;
  }
  return out;
}

export class InputForwarder {
  private pending = '';
  private inFlight = 0;
  private scheduled = false;
  private closed = false;

  /** `onError` must not throw; it is told about every failed write. */
  constructor(private readonly sink: WriteSink, private readonly onError: (err: unknown) => void, private readonly maxBytes = MAX_WRITE_BYTES) {}

  push(data: string): void {
    if (this.closed || data === '') {
      return;
    }
    this.pending += data;
    if (data.includes(CTRL_C)) {
      while (this.pending !== '') {
        this.sendNext();
      }
      return;
    }
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.inFlight === 0) {
          this.sendNext();
        }
      });
    }
  }

  /** Drop what has not been sent (the terminal was closed: nothing more is sent on its behalf). */
  close(): void {
    this.closed = true;
    this.pending = '';
  }

  /** Resolves when nothing is queued or in flight (for tests and orderly shutdown). */
  async drained(): Promise<void> {
    while (this.pending !== '' || this.inFlight > 0 || this.scheduled) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Take the next piece of the queue and send it. */
  private sendNext(): void {
    if (this.pending === '') {
      return;
    }
    const [piece] = splitUtf8(this.pending, this.maxBytes);
    if (!piece) {
      this.pending = '';
      return;
    }
    // Consume exactly the characters that the piece represents (the piece ends on a character boundary).
    this.pending = this.pending.slice(Buffer.from(piece).toString('utf8').length);
    this.inFlight++;
    this.sink(Buffer.from(piece).toString('base64'))
      .catch((err: unknown) => this.onError(err))
      .finally(() => {
        this.inFlight--;
        if (this.inFlight === 0 && this.pending !== '' && !this.closed) {
          this.sendNext();
        }
      });
  }
}
