/** Streaming UTF-8 decoding and newline normalisation (src/repl/streamText.ts): pure, no mock needed. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NewlineNormalizer, TerminalTextStream, Utf8StreamDecoder } from '../../src/repl/streamText';

const SAMPLE = 'héllo ✓ 中文 😀 end\n';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('Utf8StreamDecoder', () => {
  it('gives the same text for every possible split point of a multi-byte string', () => {
    const all = bytes(SAMPLE);
    for (let i = 0; i <= all.length; i++) {
      const d = new Utf8StreamDecoder();
      const text = d.write(all.subarray(0, i)) + d.write(all.subarray(i)) + d.flush();
      assert.equal(text, SAMPLE, `split at ${i}`);
    }
  });

  it('survives byte-by-byte delivery (worst case) without a replacement character', () => {
    const d = new Utf8StreamDecoder();
    let text = '';
    for (const b of bytes(SAMPLE)) {
      text += d.write(Uint8Array.of(b));
    }
    assert.equal(text + d.flush(), SAMPLE);
    assert.ok(!text.includes('�'));
  });

  it('turns invalid bytes and an incomplete tail into U+FFFD instead of throwing, and starts fresh after flush', () => {
    const d = new Utf8StreamDecoder();
    assert.equal(d.write(Uint8Array.of(0x61, 0xff, 0x62)), 'a�b');
    assert.equal(d.write(Uint8Array.of(0xe2, 0x9c)), '');
    assert.equal(d.flush(), '�');
    assert.equal(d.write(bytes('ok')), 'ok');
  });
});

describe('NewlineNormalizer', () => {
  it('turns a lone LF into CRLF and leaves CRLF and a lone CR alone', () => {
    const n = new NewlineNormalizer();
    assert.equal(n.push('a\nb\n\nc'), 'a\r\nb\r\n\r\nc');
    assert.equal(n.push('x\r\ny'), 'x\r\ny');
    assert.equal(n.push('p\rq'), 'p\rq');
  });

  it('does not double the CR when CR and LF arrive in different chunks', () => {
    const n = new NewlineNormalizer();
    assert.equal(n.push('line\r') + n.push('\nnext\n'), 'line\r\nnext\r\n');
    assert.equal(n.push('\nstart'), '\r\nstart', 'a chunk that starts with LF after a normal chunk is a lone LF');
  });
});

describe('TerminalTextStream', () => {
  it('decodes and normalises together, for every split point', () => {
    const all = bytes(SAMPLE + 'last\r\nline\n');
    const expected = SAMPLE.replace(/\n/g, '\r\n') + 'last\r\nline\r\n';
    for (let i = 0; i <= all.length; i++) {
      const s = new TerminalTextStream();
      assert.equal(s.push(all.subarray(0, i)) + s.push(all.subarray(i)) + s.flush(), expected, `split at ${i}`);
    }
  });
});
