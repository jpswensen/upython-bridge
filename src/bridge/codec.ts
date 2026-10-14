/**
 * NDJSON framing for the bridge channel (docs/protocol.md section 2): one JSON object per `\n`-terminated line, UTF-8, lines
 * limited to 4 MiB. The decoder works on bytes so a multi-byte character split across two chunks is never damaged, copes with
 * partial lines, drops (and reports) a line over the limit, and never throws. No `vscode` import.
 */
import type { BridgeErrorBody, HelloEvent, LogEvent, ProgressEvent } from '../types/protocol';
import type { SessionEvent } from '../types/session';

export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type DecodedLine = { kind: 'line'; text: string } | { kind: 'overflow'; bytes: number };

export class LineDecoder {
  private parts: Uint8Array[] = [];
  private size = 0;
  private discarding = false;
  private discarded = 0;
  private readonly text = new TextDecoder('utf-8');

  constructor(private readonly maxBytes: number = MAX_LINE_BYTES) {}

  /** Feed a chunk; returns the complete lines it finished (blank lines are skipped). */
  push(chunk: Uint8Array): DecodedLine[] {
    const out: DecodedLine[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const nl = chunk.indexOf(0x0a, offset);
      const end = nl === -1 ? chunk.length : nl;
      this.append(chunk.subarray(offset, end));
      if (nl === -1) {
        break;
      }
      this.finishLine(out);
      offset = nl + 1;
    }
    return out;
  }

  /** Bytes of the unfinished line currently buffered (for tests and diagnostics). */
  get pendingBytes(): number {
    return this.discarding ? this.discarded : this.size;
  }

  private append(piece: Uint8Array): void {
    if (piece.length === 0) {
      return;
    }
    if (this.discarding) {
      this.discarded += piece.length;
      return;
    }
    if (this.size + piece.length > this.maxBytes) {
      this.discarding = true;
      this.discarded = this.size + piece.length;
      this.parts = [];
      this.size = 0;
      return;
    }
    this.parts.push(piece.slice()); // copy: the chunk's buffer may be reused by the stream
    this.size += piece.length;
  }

  private finishLine(out: DecodedLine[]): void {
    if (this.discarding) {
      out.push({ kind: 'overflow', bytes: this.discarded });
      this.discarding = false;
      this.discarded = 0;
      return;
    }
    const joined = Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    let end = joined.length;
    if (end > 0 && joined[end - 1] === 0x0d) {
      end -= 1;
    }
    const text = this.text.decode(joined.subarray(0, end));
    if (text.trim() !== '') {
      out.push({ kind: 'line', text });
    }
  }
}

export type WireMessage =
  | { kind: 'response'; id: number | string | null; ok: true; result: Record<string, unknown> }
  | { kind: 'response'; id: number | string | null; ok: false; error: BridgeErrorBody }
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'invalid'; reason: string };

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function bytesOf(obj: Record<string, unknown>): Uint8Array | null {
  const b64 = obj.b64;
  if (typeof b64 !== 'string' || !B64.test(b64)) {
    return null;
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function decodeEvent(obj: Record<string, unknown>): WireMessage {
  const ev = str(obj.ev);
  switch (ev) {
    case 'hello': {
      if (typeof obj.proto !== 'number') {
        return { kind: 'invalid', reason: 'hello without a protocol number' };
      }
      const vendored = isRecord(obj.vendored) ? obj.vendored : {};
      const hello: HelloEvent = {
        ev: 'hello', proto: obj.proto, bridge: str(obj.bridge), python: str(obj.python), pyserial: str(obj.pyserial),
        platform: str(obj.platform), pid: typeof obj.pid === 'number' ? obj.pid : -1,
        vendored: { mpremote: typeof vendored.mpremote === 'string' ? vendored.mpremote : null },
      };
      return { kind: 'event', event: hello };
    }
    case 'state': {
      const state = str(obj.state);
      const prev = str(obj.prev);
      if (!['disconnected', 'connecting', 'idle', 'running', 'rawop'].includes(state)) {
        return { kind: 'invalid', reason: `state event with unknown state "${state}"` };
      }
      const event: SessionEvent = {
        ev: 'state', state: state as 'idle', prev: (['disconnected', 'connecting', 'idle', 'running', 'rawop'].includes(prev) ? prev : 'disconnected') as 'idle',
      };
      if (typeof obj.reason === 'string') {
        event.reason = obj.reason;
      }
      if (typeof obj.port === 'string') {
        event.port = obj.port;
      }
      return { kind: 'event', event };
    }
    case 'repl':
    case 'out':
    case 'err': {
      const bytes = bytesOf(obj);
      return bytes ? { kind: 'event', event: { ev, bytes } } : { kind: 'invalid', reason: `${ev} event without valid base64` };
    }
    case 'progress': {
      const progress: Omit<ProgressEvent, 'ev'> = {
        id: typeof obj.id === 'number' || typeof obj.id === 'string' ? obj.id : -1,
        label: str(obj.label), done: typeof obj.done === 'number' ? obj.done : 0, total: typeof obj.total === 'number' ? obj.total : 0,
      };
      return { kind: 'event', event: { ev: 'progress', ...progress } };
    }
    case 'log': {
      const level = str(obj.level, 'info');
      const lv: LogEvent['level'] = level === 'debug' || level === 'warn' || level === 'error' ? level : 'info';
      return { kind: 'event', event: { ev: 'log', level: lv, msg: str(obj.msg) } };
    }
    case 'fatal':
      return { kind: 'event', event: { ev: 'fatal', message: str(obj.message, 'The connection helper stopped with a fatal error.') } };
    default:
      return { kind: 'invalid', reason: `unknown event "${ev}"` };
  }
}

function decodeError(raw: unknown): BridgeErrorBody {
  const e = isRecord(raw) ? raw : {};
  return {
    ...e,
    code: (typeof e.code === 'string' && e.code !== '' ? e.code : 'E_INTERNAL') as BridgeErrorBody['code'],
    message: str(e.message, 'The board operation failed.'),
    detail: str(e.detail),
    hint: str(e.hint),
  };
}

/** Parse one line of the bridge's stdout. Never throws. */
export function decodeWire(text: string): WireMessage {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    return { kind: 'invalid', reason: `not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!isRecord(obj)) {
    return { kind: 'invalid', reason: 'not a JSON object' };
  }
  if (typeof obj.ev === 'string') {
    return decodeEvent(obj);
  }
  const id = obj.id;
  if (typeof obj.ok === 'boolean' && (typeof id === 'number' || typeof id === 'string' || id === null)) {
    if (obj.ok) {
      const result: Record<string, unknown> = { ...obj };
      delete result.id;
      delete result.ok;
      return { kind: 'response', id, ok: true, result };
    }
    return { kind: 'response', id, ok: false, error: decodeError(obj.error) };
  }
  return { kind: 'invalid', reason: 'neither an event nor a response' };
}

/** The request line, `\n` included. Key order: id and op first, for readable logs. */
export function encodeRequest(id: number, op: string, args: unknown): string {
  const rest = isRecord(args) ? args : {};
  return `${JSON.stringify(Object.assign({ id, op }, rest, { id, op }))}\n`;
}
