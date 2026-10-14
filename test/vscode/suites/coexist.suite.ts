/** S-10: the old extension installed next to ours: both load, ours activates, nothing collides, the Doctor names the old one. */
import * as vscode from 'vscode';
import type { SuiteDef } from '../runner';
import { api, assert, allCommandIds, COMMAND_IDS, ourExtension, OUR_ID, sleep, waitFor } from '../util';

const OLD_ID = 'DanielBucam.mpy-workbench';

export const coexist: SuiteDef = {
  name: 'coexist',
  define(s) {
    s.test('both extensions are installed', (t) => {
      const old = vscode.extensions.getExtension(OLD_ID);
      assert.ok(old, `${OLD_ID} is installed in the scratch profile`);
      t.note(`old: ${old.id} ${String((old.packageJSON as { version?: string }).version)} active=${old.isActive}; ours active=${ourExtension().isActive}`);
    });

    s.test('ours activates by itself (workspaceContains) and returns its API', async () => {
      await waitFor(() => ourExtension().isActive, 'our activation', 30_000, 100);
      await api();
    });

    s.test('the old extension activates next to ours (explicit activate; it never touches a port at activation)', async (t) => {
      const old = vscode.extensions.getExtension(OLD_ID);
      assert.ok(old);
      await Promise.race([old.activate(), sleep(40_000).then(() => { throw new Error('the old extension did not finish activating in 40 s'); })]);
      assert.equal(old.isActive, true);
      t.note('old extension active');
      await sleep(1500);
    }, 60_000);

    s.test('both command sets are registered side by side, with no overlap', async (t) => {
      const registered = await vscode.commands.getCommands(true);
      const ours = registered.filter((c) => c.startsWith('upy-bridge.'));
      const old = registered.filter((c) => c.startsWith('mpyWorkbench.'));
      t.note(`ours: ${ours.length} commands, old: ${old.length} commands`);
      assert.deepEqual(allCommandIds().filter((id) => !registered.includes(id)), [], 'every one of our commands is registered');
      assert.ok(old.length > 5, 'the old extension registered its commands');
      assert.equal(new Set(registered).size, registered.length, 'no command id appears twice');
    });

    s.test('the two manifests share no id: extension id, display name, view containers, views, commands and settings are all distinct', (t) => {
      const old = vscode.extensions.getExtension(OLD_ID);
      assert.ok(old);
      interface Manifest {
        displayName?: string;
        contributes?: {
          commands?: { command: string }[]; views?: Record<string, { id: string }[]>; viewsContainers?: { activitybar?: { id: string }[] };
          configuration?: { properties?: Record<string, unknown> } | { properties?: Record<string, unknown> }[];
        };
      }
      const idsOf = (m: Manifest): string[] => {
        const c = m.contributes ?? {};
        const conf = Array.isArray(c.configuration) ? c.configuration : c.configuration ? [c.configuration] : [];
        return [
          ...(c.commands ?? []).map((x) => `command:${x.command}`),
          ...Object.entries(c.views ?? {}).flatMap(([container, vs]) => [`container:${container}`, ...vs.map((v) => `view:${v.id}`)]),
          ...(c.viewsContainers?.activitybar ?? []).map((x) => `container:${x.id}`),
          ...conf.flatMap((x) => Object.keys(x.properties ?? {}).map((k) => `setting:${k}`)),
        ];
      };
      const ours = ourExtension().packageJSON as Manifest;
      const theirs = old.packageJSON as Manifest;
      const shared = idsOf(ours).filter((id) => idsOf(theirs).includes(id));
      t.note(`ids: ours ${idsOf(ours).length}, old ${idsOf(theirs).length}, shared ${shared.length}; extension ids ${OUR_ID} vs ${old.id}; display names "${ours.displayName}" vs "${theirs.displayName}"`);
      assert.deepEqual(shared, [], 'no command, view, container or setting id is declared by both extensions');
      assert.notEqual(OUR_ID.toLowerCase(), OLD_ID.toLowerCase());
      assert.notEqual(ours.displayName, theirs.displayName);
      assert.ok(idsOf(ours).length > 30 && idsOf(theirs).length > 30, 'both manifests declare their ids (commands, views, container, settings)');
    });

    s.test('our extension is still healthy: Show Log works and the session is intact', async () => {
      await vscode.commands.executeCommand(COMMAND_IDS.showLog);
      const hook = await api();
      assert.equal(hook.state().interpreter === 'problem', false);
    });

    s.test('the Doctor report names the older extension', async (t) => {
      await vscode.commands.executeCommand(COMMAND_IDS.doctor);
      const doc = await waitFor(
        () => vscode.workspace.textDocuments.find((d) => d.languageId === 'markdown' && /Doctor|setup/i.test(d.getText().slice(0, 400))),
        'the Doctor report document', 60_000, 250);
      const text = doc.getText();
      t.note(`Doctor lines about the older extension: ${JSON.stringify(text.split('\n').filter((l) => /older extension|DanielBucam/i.test(l)).slice(0, 4))}`);
      assert.match(text, /DanielBucam\.mpy-workbench/, 'the report names the older extension');
    }, 90_000);
  },
};
