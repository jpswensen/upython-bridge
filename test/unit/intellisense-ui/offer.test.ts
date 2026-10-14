/** The first-connect offer (src/commands/intellisenseOffer.ts): once, non-modal, never blocking the connection, remembered. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IntelliSenseOffer, OFFER_STATE_KEY } from '../../../src/commands/intellisenseOffer';
import { VsCodePrompter } from '../../../src/commands/intellisensePrompts';
import { nodeFs } from '../../../src/intellisense';
import { settingId } from '../../../src/identity';
import { FakeSession, FAKE_IDENTITY } from '../../mocks/fakeSession';
import { TempDirs } from '../../mocks/fixtures';
import { MockMemento } from '../../mocks/extensionContext';
import { mock } from '../../mocks/vscode';
import { Settings } from '../../../src/types/settings';
import { makeProject, openWorkspace, settle } from './helpers';

const dirs = new TempDirs();
beforeEach(() => {
  mock.reset();
  mock.addExtension('ms-python.vscode-pylance');
});
afterEach(() => {
  mock.reset();
  dirs.cleanup();
});

interface Rig { session: FakeSession; state: MockMemento; fixes: unknown[]; answers: { offer: 'setup' | 'later' | 'never' | undefined; asked: number }; offer: IntelliSenseOffer; ws: string }

function rig(over: { prompter?: { offer(): Promise<'setup' | 'later' | 'never' | undefined> }; state?: MockMemento } = {}): Rig {
  const p = makeProject(dirs);
  openWorkspace(p.ws);
  const session = new FakeSession();
  const state = over.state ?? new MockMemento();
  const fixes: unknown[] = [];
  const answers = { offer: 'later' as 'setup' | 'later' | 'never' | undefined, asked: 0 };
  const offer = new IntelliSenseOffer({
    session, settings: new Settings(), state, log: { info: () => undefined, error: () => undefined }, fs: nodeFs(),
    prompter: over.prompter ?? { offer: async () => { answers.asked++; return answers.offer; } },
    controller: { fix: async (a) => { fixes.push(a); return { status: 'applied' }; } },
  });
  mock.track(offer);
  return { session, state, fixes, answers, offer, ws: p.ws };
}

const connect = (s: FakeSession): void => s.setState({ state: 'idle', port: '/dev/cu.fake', identity: FAKE_IDENTITY });

describe('the first-connect offer', () => {
  it('is made once, after the board answered, and "Not now" does not remember anything', async () => {
    const r = rig();
    r.session.setState({ state: 'connecting', port: '/dev/cu.fake' });
    await settle();
    assert.equal(r.answers.asked, 0, 'not while connecting');
    r.session.setState({ state: 'idle', port: '/dev/cu.fake', identity: null });
    await settle();
    assert.equal(r.answers.asked, 0, 'not before the identity is read');
    connect(r.session);
    await settle();
    r.session.setState({ state: 'running' });
    connect(r.session);
    await settle();
    assert.equal(r.answers.asked, 1, 'once per window');
    assert.equal(r.state.get(OFFER_STATE_KEY), undefined);
  });

  it('"Set up" runs the setup for the folder; "Don\'t ask again" is remembered in workspaceState', async () => {
    const a = rig();
    a.answers.offer = 'setup';
    connect(a.session);
    await settle();
    assert.deepEqual(a.fixes, [{ folder: a.ws, source: 'offer' }]);

    mock.reset();
    mock.addExtension('ms-python.vscode-pylance');
    const b = rig();
    b.answers.offer = 'never';
    connect(b.session);
    await settle();
    assert.equal(b.state.get(OFFER_STATE_KEY), 'never');
    assert.equal(await b.offer.start(), 'not-asked', 'the next window does not ask');
  });

  it('is not made when the files exist, when the setting is off, when "never" was chosen, or when there is no language server', async () => {
    const r = rig();
    fs.mkdirSync(path.join(r.ws, '.upy-bridge'));
    fs.writeFileSync(path.join(r.ws, '.upy-bridge', 'manifest.json'), '{}');
    assert.equal(await r.offer.start(), 'not-asked');

    const off = rig();
    mock.config.set(settingId('intellisenseOffer'), false);
    assert.equal(await off.offer.start(), 'not-asked');
    mock.config.set(settingId('intellisenseOffer'), true);

    const never = rig({ state: new MockMemento({ [OFFER_STATE_KEY]: 'never' }) });
    assert.equal(await never.offer.start(), 'not-asked');

    mock.reset();
    const none = rig();
    assert.equal(await none.offer.start(), 'not-asked', 'no Pylance, Python or Pyright extension: nothing to configure');
    assert.equal(none.answers.asked, 0);
  });

  it('never blocks the connection: the state listener returns at once even if nobody answers the offer', async () => {
    let asked = 0;
    const r = rig({ prompter: { offer: () => { asked++; return new Promise(() => undefined); } } });
    const t0 = Date.now();
    connect(r.session);
    assert.ok(Date.now() - t0 < 50, 'setState returned without waiting for the offer');
    await settle();
    assert.equal(asked, 1);
  });
});

describe('the real prompter', () => {
  it('shows the offer as a plain toast with three buttons, never modal', async () => {
    mock.answerMessage(/code completion and import checking/, "Don't ask again");
    const answer = await new VsCodePrompter({ error: () => undefined }).offer();
    assert.equal(answer, 'never');
    const m = mock.messages('info')[0];
    assert.deepEqual(m?.items, ['Set up', 'Not now', "Don't ask again"]);
    assert.equal(m?.modal, false);
  });

  it('asks for consent with a multi-select whose items start ticked', async () => {
    const prompter = new VsCodePrompter({ error: () => undefined });
    const plan = { summary: 'write 3 files', consent: [{ id: 'create-user-config', message: 'Create it.', path: 'pyrightconfig.json' }, { id: 'edit-settings', message: 'Add them.', path: '.vscode/settings.json' }] };
    mock.answerQuickPick((items) => (items as { picked?: boolean; id: string }[]).filter((i) => i.picked === true && i.id !== 'edit-settings'));
    const got = await prompter.choose(plan as never);
    assert.deepEqual(got, { createUserConfig: true, editSettings: false });
    const call = mock.calls.quickPicks[0];
    assert.deepEqual(call?.labels, ['Write the generated files', 'Create pyrightconfig.json', 'Add the entries to .vscode/settings.json']);
    mock.answerQuickPick((items) => (items as { id: string }[]).filter((i) => i.id !== 'files'));
    assert.equal(await prompter.choose(plan as never), undefined, 'unticking the files cancels');
    mock.answerQuickPick(undefined);
    assert.equal(await prompter.choose(plan as never), undefined, 'Escape cancels');
  });

  it('asks before importing board modules: one modal naming the modules, Continue / Skip, Escape imports nothing', async () => {
    const prompter = new VsCodePrompter({ error: () => undefined });
    mock.answerMessage(/To learn what acme, _acme contain/, 'Continue', { once: true });
    assert.equal(await prompter.importModules({ modules: ['acme', '_acme'], label: 'ACME_BOARD, MicroPython 1.29.0' }), 'continue');
    const m = mock.messages('info')[0];
    assert.equal(m?.modal, true);
    assert.deepEqual(m?.items, ['Continue', 'Skip']);
    mock.answerMessage(/To learn what acme contains/, 'Skip', { once: true });
    assert.equal(await prompter.importModules({ modules: ['acme'], label: 'x' }), 'skip');
    mock.answerMessage(/To learn what acme contains/, undefined, { once: true });
    assert.equal(await prompter.importModules({ modules: ['acme'], label: 'x' }), undefined);
  });

  it('without consent items it is one modal with one button', async () => {
    const prompter = new VsCodePrompter({ error: () => undefined });
    mock.answerMessage('Set up MicroPython IntelliSense?', 'Set up');
    assert.ok(await prompter.choose({ summary: 'write 2 files', consent: [] } as never));
    assert.equal(mock.messages('info')[0]?.modal, true);
    mock.answerMessage('Set up MicroPython IntelliSense?', undefined);
    mock.reset();
    assert.equal(await prompter.choose({ summary: 'x', consent: [] } as never), undefined);
  });
});
