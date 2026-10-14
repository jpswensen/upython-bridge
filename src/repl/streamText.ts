/**
 * Turning the board's byte stream into terminal text (D-04, docs/analysis/02-repl-run.md section 10.7).
 *
 * Two small stateful steps, both safe across chunk boundaries:
 *  1. a streaming UTF-8 decoder: a multi-byte character cut in half by a serial/pipe chunk is held back until its other half
 *     arrives, instead of becoming two replacement characters (mojibake);
 *  2. a newline normaliser: a lone LF becomes CRLF (the unix-like boards and the raw REPL do not always send the CR, and a
 *     terminal would draw a staircase), and a CR at the end of one chunk followed by an LF at the start of the next stays one CRLF.
 *
 * Pure module: no `vscode` import.
 */

/** Decodes UTF-8 bytes that arrive in arbitrary pieces. Invalid bytes become U+FFFD, never an exception. */
export class Utf8StreamDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: false });

  write(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  /** Emit whatever is still held back (an incomplete character becomes U+FFFD) and start fresh. */
  flush(): string {
    const tail = this.decoder.decode();
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    return tail;
  }
}

/** Lone LF to CRLF, remembering across chunks whether the previous chunk ended with CR. */
export class NewlineNormalizer {
  private lastWasCR = false;

  push(text: string): string {
    if (text === '') {
      return '';
    }
    let head = '';
    let rest = text;
    if (this.lastWasCR && rest.charCodeAt(0) === 10) {
      head = '\n';
      rest = rest.slice(1);
    }
    this.lastWasCR = text.charCodeAt(text.length - 1) === 13;
    return head + rest.replace(/\r?\n/g, '\r\n');
  }

  reset(): void {
    this.lastWasCR = false;
  }
}

/** Bytes in, terminal text out. One instance per stream (REPL echo, program output, error text). */
export class TerminalTextStream {
  private readonly decoder = new Utf8StreamDecoder();
  private readonly newlines = new NewlineNormalizer();

  push(bytes: Uint8Array): string {
    return this.newlines.push(this.decoder.write(bytes));
  }

  /** Release held-back bytes (call when a stream ends, for example when a program finishes). */
  flush(): string {
    const tail = this.decoder.flush();
    this.newlines.reset();
    return tail;
  }
}
