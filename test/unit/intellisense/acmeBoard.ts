/** The made-up "acme" board (test/fixtures/intellisense/acme-board.json) behind the library's BoardAccess, with a call record. */
import fs from 'node:fs';
import path from 'node:path';
import type { BoardAccess, BoardEntry } from '../../../src/intellisense/board';
import type { BoardInfo } from '../../../src/intellisense/types';
import { projectRoot } from '../../mocks/fixtures';

export interface AcmeFixture {
  board: BoardInfo;
  syspath: string[];
  listing: string[];
  modules: Record<string, unknown>;
  files: Record<string, string>;
}

export const FIXTURES = path.join(projectRoot(), 'test', 'fixtures', 'intellisense');

export function acmeFixture(): AcmeFixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'acme-board.json'), 'utf8')) as AcmeFixture;
}

export interface FakeAccess extends BoardAccess {
  calls: string[];
  /** Names of every introspect call that imported something. */
  imports: string[][];
  softResets: number;
}

/** `fail`: names whose import fails on the board (error entry); `throwOn`: op that throws (`introspect-names`, `introspect`, `reset`). */
export function fakeAccess(fx: AcmeFixture = acmeFixture(), opts: { fail?: string[]; throwOn?: string; error?: Error } = {}): FakeAccess {
  const files = new Map(Object.entries(fx.files));
  const rec: FakeAccess = {
    calls: [], imports: [], softResets: 0,
    async introspect(names?: string[]): Promise<unknown> {
      rec.calls.push(names === undefined ? 'introspect' : `introspect:${names.join(',')}`);
      if (names === undefined) {
        if (opts.throwOn === 'introspect') { throw opts.error ?? new Error('E_PROGRAM_RUNNING: A program is running on the board.'); }
        return { listing: fx.listing, modules: {} };
      }
      rec.imports.push([...names]);
      if (opts.throwOn === 'introspect-names') { throw opts.error ?? new Error('E_RAW_REPL_TIMEOUT: the board did not answer'); }
      const modules: Record<string, unknown> = {};
      for (const n of names) {
        modules[n] = opts.fail?.includes(n) || fx.modules[n] === undefined ? { attrs: [], error: `ImportError: no module named '${n}'` } : fx.modules[n];
      }
      return { listing: fx.listing, modules };
    },
    async list(dir: string): Promise<BoardEntry[]> {
      rec.calls.push(`list:${dir}`);
      const prefix = `${dir}/`;
      const out = new Map<string, BoardEntry>();
      for (const [p, text] of files) {
        if (!p.startsWith(prefix)) { continue; }
        const rest = p.slice(prefix.length).split('/');
        const name = rest[0] as string;
        out.set(name, rest.length > 1 ? { name, type: 'dir', size: 0 } : { name, type: 'file', size: Buffer.byteLength(text) });
      }
      if (out.size === 0) { throw Object.assign(new Error(`The folder ${dir} does not exist on the board.`), { detail: 'ENOENT' }); }
      return [...out.values()];
    },
    async get(remote: string, local: string): Promise<void> {
      rec.calls.push(`get:${remote}`);
      const text = files.get(remote);
      if (text === undefined) { throw new Error(`no ${remote}`); }
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, text);
    },
    async softReset(): Promise<void> {
      rec.calls.push('reset.soft');
      rec.softResets++;
      if (opts.throwOn === 'reset') { throw new Error('E_BOARD_UNRESPONSIVE'); }
    },
  };
  return rec;
}
