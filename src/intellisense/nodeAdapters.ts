/** Thin adapters from the injected interfaces to Node. The only file of the library that touches the real world. */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import type { Clock, DirEntry, FsLike, StatLike } from './types';
import { errCode } from './util';

export function nodeFs(): FsLike {
  return {
    path: nodePath,
    readFile: (file) => fsp.readFile(file),
    writeFile: (file, data) => fsp.writeFile(file, data),
    rename: (from, to) => fsp.rename(from, to),
    rm: async (target, options) => {
      if (options?.recursive !== true && (await fsp.lstat(target).catch(() => null))?.isDirectory() === true) { await fsp.rmdir(target); return; } // fsp.rm refuses a folder without recursive
      await fsp.rm(target, { force: true, recursive: options?.recursive === true });
    },
    mkdir: async (dir) => { await fsp.mkdir(dir, { recursive: true }); },
    readdir: async (dir): Promise<DirEntry[]> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink() }));
    },
    realpath: (target) => fsp.realpath(target),
    lstat: async (target) => {
      try {
        const st = await fsp.lstat(target);
        return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size, isSymlink: st.isSymbolicLink() };
      } catch (err) {
        const code = errCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') { return null; }
        throw err;
      }
    },
    createExclusive: (file, data) => fsp.writeFile(file, data, { flag: 'wx' }), // O_EXCL also refuses a dangling link
    stat: async (target): Promise<StatLike | null> => {
      try {
        const st = await fsp.stat(target);
        return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size };
      } catch (err) {
        const code = errCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') { return null; }
        throw err;
      }
    },
  };
}

export function nodeClock(): Clock {
  return { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) };
}
