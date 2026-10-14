/**
 * Diagnostic, not a product test: what happens to helper processes that the extension host started when VS Code exits? Two small
 * shell helpers (one in its own session like the Python bridge, one in the host's group) record to out/child-trace.log whether they
 * saw the end of their stdin, got a signal, or were killed outright. The launcher copies that file into the report. Run it with
 * `--quit-via test-exit` and with `--quit-via command` and compare (DEVELOPING.md, "Closing the window").
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SuiteDef } from '../runner';
import { assert, env, sleep } from '../util';

const SCRIPT = [
  'L="$1"; N="$2"',
  'echo "$N start pid $$ pgid $(ps -o pgid= -p $$ | tr -d " ") $(date +%H:%M:%S)" >> "$L"',
  'trap \'echo "$N got TERM $(date +%H:%M:%S)" >> "$L"\' TERM',
  'trap \'echo "$N got HUP $(date +%H:%M:%S)" >> "$L"\' HUP',
  'while read line; do :; done',
  'echo "$N stdin EOF $(date +%H:%M:%S)" >> "$L"',
  'sleep 1',
  'echo "$N still alive 1 s after EOF $(date +%H:%M:%S)" >> "$L"',
].join('\n');

const keep: unknown[] = []; // keep the child handles (and their stdin pipes) alive until the host exits

export const exitprobe: SuiteDef = {
  name: 'exitprobe',
  define(s) {
    s.test('two helper processes are running and write to the trace file', async (t) => {
      const out = path.join(env.runRoot, 'out');
      const log = path.join(out, 'child-trace.log');
      for (const [name, detached] of [['detached-own-session', true], ['same-group', false]] as const) {
        keep.push(spawn('/bin/sh', ['-c', SCRIPT, 'probe', log, name], { detached, stdio: ['pipe', 'ignore', 'ignore'], shell: false, windowsHide: true }));
      }
      await sleep(1200);
      const text = fs.readFileSync(log, 'utf8');
      t.note(text.trim());
      assert.equal(text.split('\n').filter((l) => / start pid /.test(l)).length, 2, 'both helpers started');
    });
  },
};
