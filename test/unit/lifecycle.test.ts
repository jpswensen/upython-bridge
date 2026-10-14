import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Teardown } from '../../src/lifecycle';

describe('Teardown', () => {
  const recorder = (): { order: string[]; item: (name: string, fail?: boolean) => { dispose(): void }; errors: string[]; log: { error(message: string, cause?: unknown): void } } => {
    const order: string[] = [];
    const errors: string[] = [];
    return {
      order, errors,
      item: (name, fail = false) => ({ dispose: () => { order.push(name); if (fail) { throw new Error(`${name} failed`); } } }),
      log: { error: (message, cause) => errors.push(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`) },
    };
  };

  it('disposes early items first (last added first), then the rest in reverse order, then the late items', () => {
    const r = recorder();
    const t = new Teardown(r.log);
    t.addLate(r.item('log'));
    t.add(r.item('commands'));
    t.addEarly(r.item('session'));
    t.add(r.item('views'));
    t.addEarly(r.item('sync'));
    t.dispose();
    assert.deepEqual(r.order, ['sync', 'session', 'views', 'commands', 'log']);
  });

  it('keeps going after a failing dispose, logs it, and is idempotent', () => {
    const r = recorder();
    const t = new Teardown(r.log);
    t.add(r.item('a'));
    t.add(r.item('b', true));
    t.add(r.item('c'));
    t.dispose();
    t.dispose();
    assert.deepEqual(r.order, ['c', 'b', 'a']);
    assert.deepEqual(r.errors, ['releasing a resource failed: b failed']);
    assert.equal(t.disposed, true);
  });
});
