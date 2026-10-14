/**
 * The consent flow helper and the small pure session modules (port matching, learned-reset store).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDeclined, withConsent } from '../../../src/session/consent';
import { LearnedResetStore } from '../../../src/session/learnedReset';
import { chooseAutoPort, isAutoPort, isUrlPort, matchRememberedPort } from '../../../src/session/ports';
import { BoardError } from '../../../src/types/session';
import { FakeSession } from '../../mocks/fakeSession';
import { MockMemento } from '../../mocks/extensionContext';
import { StubUi, port } from './kit';

describe('withConsent', () => {
  it('asks once when a program is running, then repeats the call with interrupt:true', async () => {
    const s = FakeSession.connected({ state: 'running' });
    s.useBoardFs({ '/main.py': 'print(1)' });
    const ui = new StubUi();
    const res = await withConsent(s, ui, 'fs.list', { path: '/' });
    assert.deepEqual(res.entries.map((e) => e.name), ['main.py']);
    assert.deepEqual(ui.interruptAsked, ['fs.list']);
    assert.deepEqual(s.argsOf('fs.list').map((a) => a.interrupt), [undefined, true]);
  });

  it('does nothing to the board when the student says no, and the answer is a quiet cancellation', async () => {
    const s = FakeSession.connected({ state: 'running' });
    s.useBoardFs({});
    const ui = new StubUi();
    ui.interruptAnswer = false;
    await assert.rejects(withConsent(s, ui, 'fs.list', { path: '/' }), (e: unknown) => isDeclined(e));
    assert.equal(s.callsOf('fs.list').length, 1);
    assert.equal(isDeclined(BoardError.of('E_ABORTED', 'aborted by signal')), false, 'a real abort is not a decline');
  });

  it('asks about a drive of the board before deleting it, then repeats with allowMount:true', async () => {
    const s = FakeSession.connected();
    let first = true;
    s.script('fs.rmtree', (args) => {
      if (first && args.allowMount !== true) {
        first = false;
        throw BoardError.of('E_FS_ERRNO', 'That is a drive of the board.', { needs_allow_mount: true, mount_reason: 'dev', detail: 'EPERM' });
      }
      return { removed: 3 };
    });
    const ui = new StubUi();
    const res = await withConsent(s, ui, 'fs.rmtree', { path: '/flash', confirm: true });
    assert.equal(res.removed, 3);
    assert.deepEqual(ui.mountAsked, ['/flash']);
    assert.deepEqual(s.argsOf('fs.rmtree').map((a) => a.allowMount), [undefined, true]);
  });

  it('passes every other error through untouched and does not ask twice for the same thing', async () => {
    const s = FakeSession.connected();
    s.fail('fs.list', 'E_FS_ERRNO', 'No such folder.', { detail: 'ENOENT' });
    const ui = new StubUi();
    await assert.rejects(withConsent(s, ui, 'fs.list', { path: '/x' }), (e: unknown) => e instanceof BoardError && e.code === 'E_FS_ERRNO');
    assert.deepEqual(ui.interruptAsked, []);
    const stubborn = FakeSession.connected();
    stubborn.script('fs.list', () => { throw BoardError.of('E_PROGRAM_RUNNING', 'Still running.', { needs_interrupt: true }); });
    await assert.rejects(withConsent(stubborn, ui, 'fs.list', { path: '/' }), (e: unknown) => e instanceof BoardError && e.needsInterrupt);
    assert.equal(ui.interruptAsked.length, 1);
    assert.equal(stubborn.callsOf('fs.list').length, 2);
  });
});

describe('ports', () => {
  it('knows the word auto and URL transports', () => {
    assert.ok(isAutoPort('auto') && isAutoPort(' Auto ') && !isAutoPort('/dev/cu.auto'));
    assert.ok(isUrlPort('socket://127.0.0.1:5000') && isUrlPort('rfc2217://h:1') && !isUrlPort('COM3') && !isUrlPort('/dev/cu.x'));
  });

  it('chooses automatically only among likely boards', () => {
    const noise = port('/dev/cu.Bluetooth-Incoming-Port', null, null, false);
    assert.equal(chooseAutoPort([port('/dev/cu.a'), noise]).kind, 'one');
    assert.equal(chooseAutoPort([port('/dev/cu.a'), port('/dev/cu.b'), noise]).kind, 'many');
    const none = chooseAutoPort([noise]);
    assert.ok(none.kind === 'none' && none.ports.length === 1, 'every port stays visible for a manual choice');
    assert.equal(chooseAutoPort([]).kind, 'none');
  });

  it('matches the remembered board by name and adapter, then by a unique adapter, never by guessing', () => {
    const remembered = { device: 'COM3', vid: 0x10c4, pid: 0xea60 };
    assert.equal(matchRememberedPort(remembered, [port('com3')])?.device, 'com3', 'Windows names ignore case');
    assert.equal(matchRememberedPort(remembered, [port('COM8')])?.device, 'COM8');
    assert.equal(matchRememberedPort(remembered, [port('COM8'), port('COM9')]), null);
    assert.equal(matchRememberedPort(remembered, [port('COM3', 0x1a86, 0x7523)]), null);
    assert.equal(matchRememberedPort({ device: 'socket://x', vid: null, pid: null }, [port('COM3')]), null);
    assert.equal(matchRememberedPort(null, [port('COM3')]), null);
  });
});

describe('LearnedResetStore', () => {
  it('keeps verified and failed per (VID, PID, unique id) and survives a new store over the same memento', async () => {
    const memento = new MockMemento();
    const a = new LearnedResetStore(memento, () => 1000);
    const key = { vid: 0x10c4, pid: 0xea60, uniqueId: 'aabb' };
    assert.equal(a.get(key), null);
    await a.set(key, 'failed');
    assert.equal(new LearnedResetStore(memento).get(key), 'failed');
    assert.equal(a.get({ ...key, uniqueId: 'other' }), null, 'another board with the same adapter is another entry');
    await a.set(key, 'verified');
    assert.equal(a.get(key), 'verified');
    assert.deepEqual(a.all(), [{ key: `${0x10c4}:${0xea60}:aabb`, learned: 'verified', at: 1000 }]);
    await a.forget(key);
    assert.equal(a.get(key), null);
  });
});
