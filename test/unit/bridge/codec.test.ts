import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LineDecoder, MAX_LINE_BYTES, decodeWire, encodeRequest } from '../../../src/bridge/codec';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('LineDecoder', () => {
  it('splits complete lines and keeps a partial line until it is finished', () => {
    const d = new LineDecoder();
    assert.deepEqual(d.push(enc('{"a":1}\n{"b"')), [{ kind: 'line', text: '{"a":1}' }]);
    assert.deepEqual(d.push(enc(':2}\n')), [{ kind: 'line', text: '{"b":2}' }]);
    assert.equal(d.pendingBytes, 0);
  });

  it('does not damage a multi-byte character split across chunks', () => {
    const bytes = enc('{"msg":"\u00fcbung \u4e2d"}\n');
    const d = new LineDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i++) { out.push(...d.push(bytes.subarray(i, i + 1))); } // one byte at a time
    assert.deepEqual(out, [{ kind: 'line', text: '{"msg":"\u00fcbung \u4e2d"}' }]);
  });

  it('strips a trailing CR and skips blank lines', () => {
    const d = new LineDecoder();
    assert.deepEqual(d.push(enc('x\r\n\r\n\n  \ny\n')), [{ kind: 'line', text: 'x' }, { kind: 'line', text: 'y' }]);
  });

  it('drops a line over the limit, reports it once, and continues with the next line', () => {
    const d = new LineDecoder(16);
    const out = [...d.push(enc('0123456789')), ...d.push(enc('0123456789')), ...d.push(enc('0123\nok\n'))];
    assert.deepEqual(out, [{ kind: 'overflow', bytes: 24 }, { kind: 'line', text: 'ok' }]);
  });

  it('has the 4 MiB limit of the protocol', () => {
    assert.equal(MAX_LINE_BYTES, 4 * 1024 * 1024);
  });
});

describe('decodeWire', () => {
  it('decodes responses (ok and error, with the optional machine-readable fields)', () => {
    assert.deepEqual(decodeWire('{"id":3,"ok":true,"entries":[]}'), { kind: 'response', id: 3, ok: true, result: { entries: [] } });
    const bad = decodeWire('{"id":4,"ok":false,"error":{"code":"E_PROGRAM_RUNNING","message":"m","detail":"d","hint":"h","needs_interrupt":true,"sync":"running-program"}}');
    assert.equal(bad.kind, 'response');
    assert.ok(bad.kind === 'response' && !bad.ok);
    assert.equal(bad.error.code, 'E_PROGRAM_RUNNING');
    assert.equal(bad.error.needs_interrupt, true);
    assert.equal(bad.error.sync, 'running-program');
  });

  it('fills a damaged error body with safe defaults instead of throwing', () => {
    const r = decodeWire('{"id":1,"ok":false,"error":"boom"}');
    assert.ok(r.kind === 'response' && !r.ok);
    assert.equal(r.error.code, 'E_INTERNAL');
    assert.equal(typeof r.error.message, 'string');
  });

  it('decodes events, turning base64 into bytes', () => {
    const r = decodeWire(`{"ev":"out","b64":"${Buffer.from('hi\r\n').toString('base64')}"}`);
    assert.ok(r.kind === 'event' && r.event.ev === 'out');
    assert.deepEqual([...(r.event as { bytes: Uint8Array }).bytes], [104, 105, 13, 10]);
    const s = decodeWire('{"ev":"state","state":"idle","prev":"connecting","reason":"prompt seen","port":"/dev/cu.x"}');
    assert.deepEqual(s, { kind: 'event', event: { ev: 'state', state: 'idle', prev: 'connecting', reason: 'prompt seen', port: '/dev/cu.x' } });
    const p = decodeWire('{"ev":"progress","id":7,"label":"x","done":5,"total":10}');
    assert.deepEqual(p, { kind: 'event', event: { ev: 'progress', id: 7, label: 'x', done: 5, total: 10 } });
    const h = decodeWire('{"ev":"hello","proto":1,"bridge":"1","python":"3.13","pyserial":"3.5","platform":"win32","pid":5,"vendored":{"mpremote":null}}');
    assert.ok(h.kind === 'event' && h.event.ev === 'hello' && h.event.vendored.mpremote === null);
  });

  it('calls garbage invalid instead of throwing', () => {
    for (const bad of ['not json', '[1,2]', '42', '{"ev":"nope"}', '{"ev":"out","b64":"@@@"}', '{"ev":"state","state":"weird"}', '{"x":1}', '{"ev":"hello"}']) {
      assert.equal(decodeWire(bad).kind, 'invalid', bad);
    }
  });
});

describe('encodeRequest', () => {
  it('writes id and op first, one line, args after, non-ASCII intact', () => {
    const line = encodeRequest(5, 'fs.put', { local: 'C:\\Users\\Student Name\\Lab 1 (Fall)\\\u00fcbung.py', remote: '/a.py' });
    assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1);
    assert.ok(line.startsWith('{"id":5,"op":"fs.put"'));
    const back = JSON.parse(line) as { local: string };
    assert.equal(back.local, 'C:\\Users\\Student Name\\Lab 1 (Fall)\\\u00fcbung.py');
  });
});
