/**
 * Source lint (CLAUDE.md engineering rules): scans src/**\/*.ts and fails on the patterns listed in the project rules.
 * Run on its own with `npm run lint`. Each rule has self-tests below, so a rule that stops detecting is itself a failure.
 *
 * Escape hatch, for the rare justified case: `// lint-allow: <rule-id> <reason>` on the same line or the line above.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { projectRoot } from '../mocks/fixtures';

interface Finding { rule: string; file: string; line: number; text: string }

interface StringToken { value: string; start: number }

/**
 * One pass over TypeScript source: `code` has comments replaced by spaces (line/column structure and string contents kept),
 * `strings` lists every string literal (quote kind and escapes ignored for the value, which is the raw text between the quotes).
 */
export function scan(src: string): { code: string; strings: StringToken[] } {
  let out = '';
  const strings: StringToken[] = [];
  let i = 0;
  let mode: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  let tokenStart = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    const n = src.charAt(i + 1);
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; tokenStart = i + 1; }
      out += c; i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; } else { out += ' '; }
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    // inside a string; an unterminated ' or " ends at the line break (a regex literal such as /"/ must not swallow the file)
    if (c === '\\') { out += c + n; i += 2; continue; }
    if (c === mode || (c === '\n' && mode !== '`')) {
      strings.push({ value: src.slice(tokenStart, i), start: tokenStart });
      mode = 'code';
    }
    out += c; i++;
  }
  return { code: out, strings };
}

/** Replace comments with spaces (keeps line/column structure and string contents). */
export function stripComments(src: string): string {
  return scan(src).code;
}

// The current product names (D-18) and the old extension's names. Outside src/identity.ts they are written through IDENTITY, commandId(), ...
// (the micro sign U+00B5 and the escape text of the mu are caught too: the display name starts with U+03BC only, written in identity.ts).
const IDENTITY_NAMES = /upy[-_ ]?bridge|upython[-_ ]?bridge|[\u03bc\u00b5]python|\\u(?:03bc|00b5)python|mpy[-_ ]?workbench|mpystudio/i;
// The working names of D-14 ("MPY" + "Bench" in any case, with a space, hyphen, underscore or nothing between): gone everywhere in
// src/, scripts/ and the manifests. The stage-2 names that stay for now (.mpyignore, MPY_SAFE_MODE, mpy_bridge.py ...) do not match.
export const OLD_WORKING_NAMES = /mpy[-_ ]?bench/i;
// Built from fragments so this file is not itself a mention of the strings it forbids.
const BOARD_STRINGS = new RegExp(['\\bW' + 'SU', 'shi' + 'eld', '\\bME\\s?[24]0' + '1\\b'].join('|'), 'i');

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function allowed(rawLines: string[], line: number, rule: string): boolean {
  const marker = `lint-allow: ${rule}`;
  return (rawLines[line - 1] ?? '').includes(marker) || (rawLines[line - 2] ?? '').includes(marker);
}

type Check = (rel: string, raw: string, code: string) => { line: number; text: string }[];

function perLine(re: RegExp, source: 'code' | 'raw', extra?: (line: string) => boolean): Check {
  return (_rel, raw, code) => {
    const lines = (source === 'raw' ? raw : code).split('\n');
    const hits: { line: number; text: string }[] = [];
    lines.forEach((l, i) => {
      if (re.test(l) && (!extra || extra(l))) { hits.push({ line: i + 1, text: l.trim() }); }
    });
    return hits;
  };
}

function wholeFile(re: RegExp, source: 'code' | 'raw' = 'code', condition?: (code: string) => boolean): Check {
  return (_rel, raw, code) => {
    const text = source === 'raw' ? raw : code;
    if (condition && !condition(code)) { return []; }
    const hits: { line: number; text: string }[] = [];
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (let m = g.exec(text); m; m = g.exec(text)) {
      hits.push({ line: lineOf(text, m.index), text: m[0].replace(/\s+/g, ' ').trim() });
    }
    return hits;
  };
}

export const RULES: { id: string; why: string; check: Check }[] = [
  { id: 'no-sendText', why: 'Never type commands into a terminal (R-ARCH-2, RQ-TERM-1).', check: perLine(/\.sendText\s*\(|>\s*\/dev\/tty/, 'code') },
  {
    id: 'no-exec-string', why: 'exec/execSync run a shell string. Use spawn/execFile with an argv array (R-ARCH-2).',
    check: wholeFile(/import\s*\{[^}]*\b(?:exec|execSync)\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]|\b(?:cp|child_process|childProcess)\.(?:exec|execSync)\s*\(/),
  },
  { id: 'no-shell-true', why: 'shell:true (or a shell path) invites quoting bugs and injection (R-ARCH-2).', check: perLine(/\bshell\s*:\s*(?:true\b|['"`])/, 'code') },
  {
    id: 'no-string-command', why: 'A command given as one string needs a shell. Pass the executable and an args array.',
    check: wholeFile(/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(['"`])(?:(?!\1)[^\\]|\\.)*\1\s*\)/),
  },
  {
    id: 'spawn-needs-windowsHide', why: 'Every child process must set windowsHide:true and shell:false (R-ARCH-2).',
    check: (_rel, _raw, code) => {
      const calls = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/.exec(code);
      const ok = /windowsHide\s*:\s*true/.test(code) && !/shell\s*:\s*true/.test(code);
      return calls && !ok ? [{ line: lineOf(code, calls.index), text: 'file spawns a process without windowsHide: true' }] : [];
    },
  },
  {
    id: 'no-auto-port', why: '"auto" is a UI choice, never a port name, and is never written to settings (D-11). Comparing against it (a guard) is fine.',
    check: (_rel, raw, code) => {
      const lines = raw.split('\n');
      const hits: { line: number; text: string }[] = [];
      for (const tok of scan(raw).strings) {
        if (tok.value.trim().toLowerCase() !== 'auto') { continue; }
        const before = code.slice(Math.max(0, tok.start - 14), tok.start - 1).trimEnd();
        const line = lineOf(raw, tok.start);
        const text = lines[line - 1] ?? '';
        if (/(?:===|!==|==|!=)$/.test(before) || /openPolicy|policy/i.test(text) || !/port|connect|serial|device/i.test(text)) { continue; }
        hits.push({ line, text: text.trim() });
      }
      return hits;
    },
  },
  {
    id: 'no-settings-json-edit', why: 'settings.json is edited only through jsonc-parser (comments and trailing commas must survive).',
    check: (_rel, _raw, code) => {
      if (!/settings\.json/.test(code)) { return []; }
      const m = /JSON\.(?:parse|stringify)\s*\(/.exec(code);
      return m ? [{ line: lineOf(code, m.index), text: m[0] }] : [];
    },
  },
  { id: 'no-console', why: 'Use the Logger (src/log.ts); console output is invisible to students.', check: perLine(/\bconsole\s*\./, 'code') },
  {
    id: 'identity-names', why: 'Names live only in src/identity.ts (D-14): use IDENTITY/commandId/settingId/viewId.',
    check: (rel, raw) => (rel === 'src/identity.ts' ? [] : perLine(IDENTITY_NAMES, 'raw')(rel, raw, raw)),
  },
  { id: 'generic-board-strings', why: 'No board- or course-specific strings in shipping code (D-15, tools/check_generic.py).', check: perLine(BOARD_STRINGS, 'raw') },
  {
    id: 'no-any', why: '`any` needs a comment saying why.',
    check: (_rel, raw, code) => {
      const rawLines = raw.split('\n');
      return perLine(/:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/, 'code')(_rel, raw, code)
        .filter((h) => !/\/\//.test(rawLines[h.line - 1] ?? '') && !/\/\/|\*\//.test(rawLines[h.line - 2] ?? ''));
    },
  },
  { id: 'no-empty-catch', why: 'No swallowed errors: handle, log or rethrow.', check: wholeFile(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/) },
  {
    id: 'no-network', why: 'No network access at runtime (CLAUDE.md, 06 invariant 10).',
    check: wholeFile(/from\s*['"](?:node:)?(?:https?|net|tls|dgram)['"]|\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket\b/),
  },
  { id: 'no-module-level-state', why: 'No module-level mutable state: construct classes in activate() (06 rule d).', check: perLine(/^(?:export\s+)?let\s/, 'code') },
];

export function lintSource(rel: string, raw: string): Finding[] {
  const code = stripComments(raw);
  const rawLines = raw.split('\n');
  const findings: Finding[] = [];
  for (const rule of RULES) {
    for (const hit of rule.check(rel, raw, code)) {
      if (!allowed(rawLines, hit.line, rule.id)) { findings.push({ rule: rule.id, file: rel, line: hit.line, text: hit.text }); }
    }
  }
  return findings;
}

function listFiles(dir: string, extensions: readonly string[]): string[] {
  if (!fs.existsSync(dir)) { return []; }
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') { out.push(...listFiles(full, extensions)); } } else if (extensions.some((x) => e.name.endsWith(x))) { out.push(full); }
  }
  return out.sort();
}

const listTs = (dir: string): string[] => listFiles(dir, ['.ts']);

/** Lines of `text` that contain an old working name (D-18), as `line: text`. */
export function oldNameHits(text: string): string[] {
  return text.split('\n').flatMap((l, i) => (OLD_WORKING_NAMES.test(l) ? [`${i + 1}: ${l.trim().slice(0, 120)}`] : []));
}

describe('lint: src/**', () => {
  it('has no violations', () => {
    const root = projectRoot();
    const files = listTs(path.join(root, 'src'));
    assert.ok(files.length > 0, 'no source files found under src/');
    const findings = files.flatMap((f) => lintSource(path.relative(root, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')));
    const report = findings.map((f) => `  ${f.file}:${f.line} [${f.rule}] ${f.text}\n      ${RULES.find((r) => r.id === f.rule)?.why ?? ''}`).join('\n');
    assert.equal(findings.length, 0, `\nLint violations:\n${report}\n`);
  });
});

describe('lint: no old working name (D-18) in src/, scripts/ or the manifests', () => {
  it('finds none in src/**, scripts/**, package.json and package-lock.json (identity.ts and the comments included)', () => {
    const root = projectRoot();
    const files = [
      ...listFiles(path.join(root, 'src'), ['.ts']),
      ...listFiles(path.join(root, 'scripts'), ['.mjs', '.mts', '.ts', '.js']),
      path.join(root, 'package.json'),
      path.join(root, 'package-lock.json'),
    ].filter((f) => fs.existsSync(f));
    assert.ok(files.length > 20, 'the scan found the sources');
    const report = files.flatMap((f) => oldNameHits(fs.readFileSync(f, 'utf8')).map((h) => `  ${path.relative(root, f)}:${h}`));
    assert.deepEqual(report, [], `\nOld working names (use IDENTITY from src/identity.ts, then npm run gen:manifest):\n${report.join('\n')}\n`);
  });

  for (const bad of ['mpyBench.run', 'const d = ".mpybench";', 'MPYBENCH_TEST=1', 'the MPY Bench log', 'out/mpy-bench-0.1.0.vsix', 'MPY_Bench', '// local.mpy-bench']) {
    it(`flags: ${bad}`, () => { assert.equal(oldNameHits(bad).length, 1); });
  }
  for (const good of ['MPY_SAFE_MODE', 'bridge/mpy_bridge.py', 'const f = ".mpyignore";', 'DanielBucam.mpy-workbench', 'upy-bridge.run', 'UPYBRIDGE_TEST', '.upy-bridge/']) {
    it(`accepts: ${good}`, () => { assert.deepEqual(oldNameHits(good), []); });
  }
});

describe('lint: the rules detect what they should (self-tests)', () => {
  const bad: [string, string][] = [
    ['no-sendText', 'terminal.sendText("python x.py");'],
    ['no-sendText', 'await run("echo hi > /dev/ttyUSB0");'],
    ['no-exec-string', "import { exec } from 'node:child_process';"],
    ['no-exec-string', 'cp.execSync("ls");'],
    ['no-shell-true', 'spawn(py, args, { shell: true });'],
    ['no-shell-true', "spawn(py, args, { shell: '/bin/sh' });"],
    ['no-string-command', 'spawn("python -m foo");'],
    ['no-string-command', 'execFile(`${py} -m foo`);'],
    ['spawn-needs-windowsHide', 'spawn(py, [a], { cwd });'],
    ['no-auto-port', "await session.connect('auto');"],
    ['no-auto-port', "const port = cfg.get('port') ?? 'auto';"],
    ['no-auto-port', "await cfg.update('connect', 'auto', target);"],
    ['no-settings-json-edit', "const p = path.join(dir, 'settings.json'); const o = JSON.parse(text);"],
    ['no-console', 'console.log("x");'],
    ['identity-names', "const id = 'upy-bridge.run';"],
    ['identity-names', '// see the .upy-bridge folder'],
    ['identity-names', "const old = 'mpyWorkbench.pickPort';"],
    ['identity-names', "const name = 'upython-bridge';"],
    ['identity-names', "const title = '\u03bcPython Bridge';"],
    ['identity-names', "const title = '\\u03bcPython Bridge';"],
    ['identity-names', "const title = '\u00b5Python Bridge';"],
    ['generic-board-strings', "if (build === 'W" + "SU_" + "SHI" + "ELD') {}"],
    ['generic-board-strings', '// the ' + 'shi' + 'eld package'],
    ['no-any', 'const x: any = 1;'],
    ['no-empty-catch', 'try { f(); } catch (e) {}'],
    ['no-empty-catch', 'try { f(); } catch { }'],
    ['no-network', "import https from 'node:https';"],
    ['no-network', 'const r = await fetch(url);'],
    ['no-module-level-state', 'let cache = new Map();'],
  ];
  for (const [rule, sample] of bad) {
    it(`flags ${rule}: ${sample.slice(0, 50)}`, () => {
      assert.ok(lintSource('src/x.ts', sample).some((f) => f.rule === rule), `rule ${rule} did not fire`);
    });
  }

  const good: string[] = [
    "const p = spawn(py, ['-I', '-c', code], { shell: false, windowsHide: true });",
    "const policy = { openPolicy: 'auto' };",
    "if (port.trim().toLowerCase() === 'auto') { throw new Error('Choose a real port, not \"auto\".'); }",
    "// 'auto' in a comment about a port is fine: connect('auto') is only an example",
    "const re = /x/; const m = re.exec(text);",
    "const x: any = 1; // reason: foreign API",
    'try { f(); } catch (e) { log.error("failed", e); }',
    "const id = commandId('run');",
    "const label = 'Select Serial Port';",
    "const settingsPath = 'settings.json'; const edits = modify(text, ['a'], 1, {});",
    'const ok = (await fetchPlan()).items;',
  ];
  for (const sample of good) {
    it(`accepts: ${sample.slice(0, 60)}`, () => {
      assert.deepEqual(lintSource('src/x.ts', sample), []);
    });
  }

  it('lets src/identity.ts hold the names', () => {
    assert.deepEqual(lintSource('src/identity.ts', "export const prefix = 'upy-bridge';"), []);
  });

  it('honours the lint-allow marker on the same or the previous line', () => {
    assert.deepEqual(lintSource('src/x.ts', 'let counter = 0; // lint-allow: no-module-level-state test fixture'), []);
    assert.deepEqual(lintSource('src/x.ts', '// lint-allow: no-module-level-state test fixture\nlet counter = 0;'), []);
  });
});
