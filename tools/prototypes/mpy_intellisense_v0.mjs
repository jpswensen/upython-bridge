#!/usr/bin/env node
// Prototype: "MicroPython IntelliSense" generator for the mpy-upgrade extension.
//
//   node mpy_intellisense.mjs --fw <firmware dir> --out <project dir>
//        [--manifest <path>] [--mpy-dir <micropython checkout>] [--mpy-lib <micropython-lib>]
//        [--port-dir <dir>] [--board-dir <dir>] [--python <python exe>] [--mode python|static|both]
//        [--stubs <dir with stock micropython-<port>-stubs contents>]
//
// What it does (all offline):
//   1. Evaluate the firmware manifest.py  -> source roots of frozen modules   (tier 1: real
//      manifestfile.py via python; tier 2: pure-JS static emulation, no code execution)
//   2. Scan C user modules (MP_REGISTER_MODULE / MP_ROM_QSTR tables)         -> generated .pyi
//   3. Emit .mpy-workbench/pyright.generated.json (+ report) with extraPaths/stubPath/etc.
//
// This is a PROTOTYPE meant to be ported to TypeScript inside the extension.  It is
// deliberately dependency-free so the algorithms are easy to lift.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------------------- args
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return a;
}
const posix = (p) => p.split(path.sep).join('/');

// ----------------------------------------------------------------------------- tier 1: python
export function evalManifestWithPython({ python, manifestfile, manifest, pathVars }) {
  const cfg = JSON.stringify({ manifestfile, manifest, path_vars: pathVars });
  const r = spawnSync(python, ['-I', path.join(HERE, 'manifest_probe.py'), cfg], { encoding: 'utf8', timeout: 20000 });
  if (r.error || r.status !== 0) return { ok: false, error: r.error?.message || r.stderr };
  const j = JSON.parse(r.stdout);
  const roots = [];
  for (const f of j.files) if (!roots.includes(f.root)) roots.push(f.root);
  const modules = [...new Set(j.files.map((f) => f.target_path.split('/')[0].replace(/\.(py|mpy)$/, '')))];
  return { ok: true, tier: 'python', roots, modules, cModules: j.c_modules, errors: j.errors, files: j.files.length };
}

// ----------------------------------------------------------------------------- tier 2: static
// A tiny Python-literal tokenizer/evaluator.  It never executes anything.
function stripComments(src) {
  // remove # comments that are outside of string literals
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i];
    if (q) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === q) q = null;
    } else if (c === '"' || c === "'") { q = c; out += c; }
    else if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    else out += c;
    i++;
  }
  return out;
}
function splitTopLevel(s) {
  const parts = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') cur += s[++i]; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const UNKNOWN = Symbol('unknown');
function evalLiteral(expr) {
  expr = expr.trim();
  let m;
  if ((m = /^(['"])((?:\\.|(?!\1).)*)\1$/s.exec(expr))) return m[2];
  if (expr === 'None') return null;
  if (expr === 'True') return true;
  if (expr === 'False') return false;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  if ((m = /^[\[(](.*)[\])]$/s.exec(expr))) return splitTopLevel(m[1]).map(evalLiteral);
  // "a" + "b" and os.path.join("a", "b")  (the only non-literal forms seen in upstream manifests)
  if (expr.includes('+') && !/[(\[]/.test(expr)) {
    const parts = expr.split('+').map(evalLiteral);
    if (parts.every((p) => typeof p === 'string')) return parts.join('');
  }
  if ((m = /^os\.path\.join\((.*)\)$/s.exec(expr))) {
    const parts = splitTopLevel(m[1]).map(evalLiteral);
    if (parts.every((p) => typeof p === 'string')) return parts.join('/');
  }
  return UNKNOWN;
}
function parseCall(argText) {
  const pos = [], kw = {};
  for (const part of splitTopLevel(argText)) {
    const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.*)$/s.exec(part);
    if (m) kw[m[1]] = evalLiteral(m[2]); else pos.push(evalLiteral(part));
  }
  return { pos, kw };
}
function findCalls(src) {
  const names = 'metadata|include|require|add_library|package|module|c_module|freeze_as_str|freeze_as_mpy|freeze_mpy|freeze';
  const re = new RegExp(`^([ \\t]*)(${names})\\s*\\(`, 'gm');
  const calls = []; let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1, q = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c; else if (c === '(') depth++; else if (c === ')') depth--;
    }
    calls.push({ name: m[2], conditional: m[1].length > 0, args: parseCall(src.slice(re.lastIndex, i - 1)) });
    re.lastIndex = i;
  }
  return calls;
}

function listPy(dir) {
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (/\.(py|mpy)$/i.test(e.name)) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

export function evalManifestStatic({ manifest, pathVars }) {
  const roots = []; const modules = new Set(); const cModules = []; const warnings = [];
  const libs = []; const visited = new Set();
  if (pathVars.MPY_LIB_DIR) for (const l of ['micropython', 'python-stdlib', 'python-ecosys']) libs.push(path.join(pathVars.MPY_LIB_DIR, l));
  const addRoot = (r) => { r = path.normalize(r); if (!roots.includes(r)) roots.push(r); };

  const run = (file) => {
    file = path.resolve(file);
    if (visited.has(file)) return;
    visited.add(file);
    let src;
    try { src = stripComments(fs.readFileSync(file, 'utf8')); } catch (e) { warnings.push(`cannot read ${file}`); return; }
    const dir = path.dirname(file);
    const sub = (p) => {
      for (const [k, v] of Object.entries(pathVars)) if (v) p = p.split(`$(${k})`).join(v);
      return path.resolve(dir, p);
    };
    for (const c of findCalls(src)) {
      const { pos, kw } = c.args;
      const bad = (...vals) => vals.some((v) => v === UNKNOWN);
      if (bad(...pos, ...Object.values(kw))) { warnings.push(`${path.basename(file)}: ${c.name}(...) has non-literal arguments, skipped`); continue; }
      if (c.conditional) warnings.push(`${path.basename(file)}: ${c.name}(${JSON.stringify(pos[0])}) is inside a block; assumed taken`);
      switch (c.name) {
        case 'freeze': case 'freeze_as_str': case 'freeze_as_mpy': case 'freeze_mpy': {
          const base = sub(pos[0]); const script = pos[1] ?? kw.script ?? null;
          if (fs.existsSync(base)) addRoot(base); else { warnings.push(`freeze base missing: ${base}`); break; }
          const scripts = script === null ? [null] : Array.isArray(script) ? script : [script];
          for (const s of scripts) {
            const target = s ? path.join(base, s) : base;
            let rel = [];
            try { rel = fs.statSync(target).isDirectory() ? listPy(target).map((f) => (s ? `${s}/${f}` : f)) : [s]; } catch { warnings.push(`freeze target missing: ${target}`); }
            for (const f of rel) modules.add(f.split('/')[0].replace(/\.(py|mpy)$/i, ''));
          }
          break;
        }
        case 'package': addRoot(sub(kw.base_path ?? pos[2] ?? '.')); modules.add(pos[0].split('/')[0]); break;
        case 'module': addRoot(sub(kw.base_path ?? pos[1] ?? '.')); modules.add(pos[0].split('/')[0].replace(/\.py$/i, '')); break;
        case 'c_module': cModules.push(sub(pos[0])); break;
        case 'add_library': libs.splice(kw.prepend ? 0 : libs.length, 0, sub(pos[1])); break;
        case 'include': {
          for (const p of Array.isArray(pos[0]) ? pos[0] : [pos[0]]) {
            let t = sub(p);
            try { if (fs.statSync(t).isDirectory()) t = path.join(t, 'manifest.py'); } catch { /* fallthrough */ }
            run(t);
          }
          break;
        }
        case 'require': {
          let found = false;
          for (const lib of libs) {
            const hit = findManifestFor(lib, pos[0]);
            if (hit) { run(hit); found = true; break; }
          }
          if (!found) warnings.push(`require("${pos[0]}"): not found in known libraries`);
          break;
        }
        default: break;
      }
    }
  };
  run(manifest);
  return { ok: true, tier: 'static', roots, modules: [...modules], cModules, errors: warnings.map((w) => ({ error: w })) };
}
function findManifestFor(libDir, name) {
  let ents;
  try { ents = fs.readdirSync(libDir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const d = path.join(libDir, e.name);
    if (e.name === name && fs.existsSync(path.join(d, 'manifest.py'))) return path.join(d, 'manifest.py');
    const deeper = findManifestFor(d, name);
    if (deeper) return deeper;
  }
  return null;
}

// ----------------------------------------------------------------------------- C user modules
function stripCComments(src) {
  // keep //| lines (hand-written stub blocks); drop other comments but preserve newlines
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/(?!\|)[^\n]*/g, '');
}
function cArgs(s) { return splitTopLevel(s); }
const stripObj = (n) => n.replace(/^(?:mp_obj_t|mp_int_t|const\s+mp_obj_t\s*\*?)\s*/, '').replace(/_(obj|in|o|arg)$/, '').replace(/^\*+/, '');

function findFunctionDef(src, cname) {
  const re = new RegExp(`(?:static\\s+)?(?:mp_obj_t|void)\\s+${cname}\\s*\\(([^)]*)\\)\\s*\\{`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  // grab body by brace matching
  const start = m.index + m[0].length;
  let i = start, depth = 1;
  for (; i < src.length && depth > 0; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; }
  return { params: m[1].trim(), body: src.slice(start, i - 1) };
}
function inferReturn(body) {
  const rets = [...body.matchAll(/return\s+([^;]+);/g)].map((m) => m[1]);
  const kinds = new Set(rets.map((r) => {
    if (/mp_const_none/.test(r)) return 'None';
    if (/mp_obj_new_(small_)?int|mp_obj_new_int_from/.test(r)) return 'int';
    if (/mp_obj_new_float/.test(r)) return 'float';
    if (/mp_obj_new_str|mp_obj_new_qstr/.test(r)) return 'str';
    if (/mp_obj_new_bool|mp_const_true|mp_const_false/.test(r)) return 'bool';
    if (/mp_obj_new_bytes|mp_obj_new_bytearray/.test(r)) return 'bytes';
    if (/mp_obj_new_list/.test(r)) return 'list[Any]';
    if (/mp_obj_new_tuple/.test(r)) return 'tuple[Any, ...]';
    return 'Any';
  }));
  if (kinds.size === 0) return 'None';
  if (kinds.has('Any')) return 'Any';
  return [...kinds].join(' | ');
}
function inferParamType(body, cname) {
  const t = (fn, type) => new RegExp(`${fn}\\s*\\(\\s*${cname}\\b`).test(body) && type;
  return t('mp_obj_get_int(?:_truncated)?', 'int') || t('mp_obj_get_float(?:_to_f)?|mp_obj_get_float_to_d', 'float')
    || t('mp_obj_str_get_str|mp_obj_str_get_qstr', 'str') || t('mp_obj_is_true', 'bool') || 'Any';
}

function parseCSignature(src, cname, arity, kind) {
  const def = findFunctionDef(src, cname);
  const pyName = (n) => (/^[A-Za-z_]\w*$/.test(n) ? n : 'arg');
  if (kind === 'fixed' && def) {
    const params = def.params === 'void' || def.params === '' ? [] : cArgs(def.params).map((p) => p.split(/[\s*]+/).pop());
    return {
      params: params.map((p) => ({ name: pyName(stripObj(p)), type: inferParamType(def.body, p) })),
      ret: inferReturn(def.body),
    };
  }
  if (kind === 'fixed') return { params: Array.from({ length: arity }, (_, i) => ({ name: `arg${i + 1}`, type: 'Any' })), ret: 'Any' };
  // var / var_between / kw: try mp_arg_t allowed_args[] for names
  const ret = def ? inferReturn(def.body) : 'Any';
  const allowed = def && /allowed_args\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(def.body);
  if (allowed) {
    const items = [...allowed[1].matchAll(/\{\s*MP_QSTR_(\w+)\s*,\s*([^,}]+)/g)];
    const params = items.map((m) => ({
      name: m[1],
      type: /MP_ARG_INT/.test(m[2]) ? 'int' : /MP_ARG_BOOL/.test(m[2]) ? 'bool' : 'Any',
      kwOnly: /KW_ONLY/.test(m[2]),
      required: /REQUIRED/.test(m[2]),
    }));
    return { params, ret, fromAllowedArgs: true };
  }
  return { params: [], ret, varargs: true };
}

function renderParams(sig, { self = false, optionalFrom = Infinity } = {}) {
  const out = self ? ['self'] : [];
  if (sig.varargs) { out.push('*args: Any'); return out.join(', '); }
  let seenKwOnly = false;
  sig.params.forEach((p, i) => {
    if (p.kwOnly && !seenKwOnly) { out.push('*'); seenKwOnly = true; }
    const opt = !p.required && (p.kwOnly || i >= optionalFrom);
    out.push(`${p.name}: ${p.type}${opt ? ' = ...' : ''}`);
  });
  return out.join(', ');
}

export function scanCModule(dir) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(c|cc|cpp|h|hpp)$/i.test(e.name)) files.push(p);
  } };
  walk(dir);
  const raw = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const src = stripCComments(raw);

  // hand-written //| blocks (CircuitPython convention).  Names defined there win over generated ones.
  const handLines = raw.split('\n').filter((l) => /^\s*\/\/\|/.test(l)).map((l) => l.replace(/^\s*\/\/\| ?/, ''));
  const handNames = new Set(handLines.map((l) => /^(?:class|def)\s+(\w+)/.exec(l)?.[1]).filter(Boolean));

  // defines
  const funObjs = new Map(); // obj -> {arity|kind, cfunc}
  for (const m of src.matchAll(/MP_DEFINE_CONST_FUN_OBJ_(0|1|2|3|VAR_BETWEEN|VAR|KW)\s*\(\s*(\w+)\s*,([^;]*)\)\s*;/g)) {
    const a = cArgs(m[3]);
    const [kind, arity] = ({ 0: ['fixed', 0], 1: ['fixed', 1], 2: ['fixed', 2], 3: ['fixed', 3] })[m[1]] ?? [m[1].toLowerCase(), 0];
    funObjs.set(m[2], { kind, arity, cfunc: a[a.length - 1].trim(), nmin: kind === 'fixed' ? arity : Number(a[0]) });
  }
  const wrappers = new Map(); // static/class method wrappers
  for (const m of src.matchAll(/MP_DEFINE_CONST_(STATICMETHOD|CLASSMETHOD)_OBJ\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g)) wrappers.set(m[2], { kind: m[1].toLowerCase(), inner: m[3] });
  const dicts = new Map();
  for (const m of src.matchAll(/MP_DEFINE_CONST_DICT\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g)) dicts.set(m[1], m[2]);
  const tables = new Map();
  for (const m of src.matchAll(/mp_rom_map_elem_t\s+(\w+)\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/g)) {
    const ents = [...m[2].matchAll(/\{\s*MP_ROM_QSTR\(\s*MP_QSTR_(\w+)\s*\)\s*,\s*((?:[^{}]|\([^)]*\))+?)\s*\}/g)].map((e) => ({ name: e[1], value: e[2].trim() }));
    tables.set(m[1], ents);
  }
  const types = new Map(); // obj -> {name, make_new, locals}
  for (const m of src.matchAll(/MP_DEFINE_CONST_OBJ_TYPE\s*\(([\s\S]*?)\)\s*;/g)) {
    const a = cArgs(m[1]);
    const t = { obj: a[0].trim(), name: /MP_QSTR_(\w+)/.exec(a[1])?.[1] };
    for (let i = 3; i + 1 < a.length; i += 2) t[a[i].trim()] = a[i + 1].trim().replace(/^&/, '');
    types.set(t.obj, t);
  }
  for (const m of src.matchAll(/const\s+mp_obj_type_t\s+(\w+)\s*=\s*\{([\s\S]*?)\n\};/g)) { // pre-1.19 style
    const name = /\.name\s*=\s*MP_QSTR_(\w+)/.exec(m[2])?.[1];
    if (!name || types.has(m[1])) continue;
    types.set(m[1], { obj: m[1], name, make_new: /\.make_new\s*=\s*(\w+)/.exec(m[2])?.[1], locals_dict: /\.locals_dict\s*=\s*\(mp_obj_dict_t\s*\*\)\s*&(\w+)/.exec(m[2])?.[1] });
  }

  // modules
  const modules = [];
  for (const m of src.matchAll(/MP_REGISTER_(?:EXTENSIBLE_)?MODULE\s*\(\s*MP_QSTR_(\w+)\s*,\s*(\w+)\s*\)/g)) {
    const modObj = m[2];
    const mm = new RegExp(`mp_obj_module_t\\s+${modObj}\\s*=\\s*\\{[\\s\\S]*?\\.globals\\s*=\\s*\\(mp_obj_dict_t\\s*\\*\\)\\s*&(\\w+)`).exec(src);
    const table = mm && tables.get(dicts.get(mm[1]));
    modules.push({ name: m[1], entries: table ?? [] });
  }

  const renderFun = (entryName, objName, { self = false } = {}) => {
    const f = funObjs.get(objName);
    if (!f) return null;
    const sig = parseCSignature(src, f.cfunc, f.arity, f.kind);
    if (f.kind === 'fixed') {
      if (self) sig.params = sig.params.slice(1);
      return `def ${entryName}(${renderParams(sig, { self })}) -> ${sig.ret}: ...`;
    }
    const opt = f.kind === 'var_between' ? 0 : f.nmin;
    return `def ${entryName}(${renderParams(sig, { self, optionalFrom: opt })}) -> ${sig.ret}: ...`;
  };

  const renderClass = (name, t) => {
    const lines = [`class ${name}:`];
    const ents = tables.get(dicts.get(t.locals_dict)) ?? [];
    const mk = t.make_new && findFunctionDef(src, t.make_new);
    let init = '*args: Any, **kwargs: Any';
    if (mk) {
      const chk = /mp_arg_check_num\s*\(\s*n_args\s*,\s*n_kw\s*,\s*(\d+)\s*,\s*(\d+)/.exec(mk.body);
      if (chk) { const lo = Number(chk[1]), hi = Number(chk[2]); init = Array.from({ length: hi }, (_, i) => `arg${i + 1}: Any${i >= lo ? ' = ...' : ''}`).join(', '); }
    }
    lines.push(`    def __init__(self${init ? ', ' + init : ''}) -> None: ...`);
    for (const e of ents) {
      const wrapped = wrappers.get(e.value.replace(/^MP_ROM_PTR\(&(\w+)\)$/, '$1'));
      const objName = /^MP_ROM_PTR\(&(\w+)\)$/.exec(e.value)?.[1];
      if (/^MP_ROM_INT\(/.test(e.value)) lines.push(`    ${e.name}: int`);
      else if (objName && funObjs.has(objName)) lines.push('    ' + renderFun(e.name, objName, { self: true }));
      else if (wrapped) lines.push(`    # ${wrapped.kind} ${e.name}: signature not generated`, `    def ${e.name}(*args: Any) -> Any: ...`);
      else lines.push(`    ${e.name}: Any`);
    }
    return lines.join('\n');
  };

  const out = [];
  for (const mod of modules) {
    const L = ['# Generated by mpy-workbench from C source (MP_REGISTER_MODULE). Do not edit; add a hand-written',
      '# <module>.pyi next to the C file or //| lines in the C source to override.', 'from typing import Any', ''];
    if (handLines.length) { L.push('# --- hand-written //| blocks ---', ...handLines, ''); }
    for (const e of mod.entries) {
      if (e.name === '__name__' || handNames.has(e.name)) continue;
      const objName = /^MP_ROM_PTR\(&(\w+)\)$/.exec(e.value)?.[1];
      if (/^MP_ROM_INT\(/.test(e.value)) L.push(`${e.name}: int`);
      else if (/^MP_ROM_(TRUE|FALSE)$/.test(e.value)) L.push(`${e.name}: bool`);
      else if (e.value === 'MP_ROM_NONE') L.push(`${e.name}: None`);
      else if (/^MP_ROM_QSTR\(/.test(e.value)) L.push(`${e.name}: str`);
      else if (objName && funObjs.has(objName)) L.push(renderFun(e.name, objName));
      else if (objName && types.has(objName)) L.push('', renderClass(e.name, types.get(objName)), '');
      else L.push(`${e.name}: Any  # unresolved: ${e.value}`);
    }
    out.push({ module: mod.name, pyi: L.join('\n') + '\n', names: mod.entries.map((e) => e.name).filter((n) => n !== '__name__') });
  }
  return out;
}

// ----------------------------------------------------------------------------- assemble
function main() {
  const a = parseArgs(process.argv);
  const fw = path.resolve(a.fw);
  const out = path.resolve(a.out);
  const manifest = path.resolve(a.manifest ?? path.join(fw, 'manifest.py'));
  const pathVars = {
    MPY_DIR: a['mpy-dir'] && path.resolve(a['mpy-dir']),
    MPY_LIB_DIR: a['mpy-lib'] && path.resolve(a['mpy-lib']),
    PORT_DIR: a['port-dir'] && path.resolve(a['port-dir']),
    BOARD_DIR: a['board-dir'] && path.resolve(a['board-dir']),
  };
  const mode = a.mode ?? 'python';
  const python = a.python ?? 'python3';
  const manifestfile = pathVars.MPY_DIR && path.join(pathVars.MPY_DIR, 'tools', 'manifestfile.py');

  let res;
  if (mode !== 'static' && manifestfile && fs.existsSync(manifestfile)) res = evalManifestWithPython({ python, manifestfile, manifest, pathVars });
  if (!res?.ok) res = evalManifestStatic({ manifest, pathVars });

  // classify roots: upstream (inside MPY_DIR / MPY_LIB_DIR) vs user (everything else)
  const isUpstream = (r) => [pathVars.MPY_DIR, pathVars.MPY_LIB_DIR].filter(Boolean).some((u) => r === u || r.startsWith(u + path.sep));
  const userRoots = res.roots.filter((r) => !isUpstream(r));
  const upstreamRoots = res.roots.filter(isUpstream);

  // C modules -> generated stubs
  const stubRoot = path.join(out, '.mpy-workbench', 'stubs');
  const genDir = path.join(stubRoot, 'custom');
  fs.rmSync(genDir, { recursive: true, force: true });
  fs.mkdirSync(genDir, { recursive: true });
  const generated = [];
  for (const cdir of res.cModules) {
    for (const g of scanCModule(cdir)) {
      const handFile = fs.existsSync(path.join(cdir, `${g.module}.pyi`)) ? path.join(cdir, `${g.module}.pyi`) : null;
      fs.writeFileSync(path.join(genDir, `${g.module}.pyi`), handFile ? fs.readFileSync(handFile) : g.pyi);
      generated.push({ module: g.module, from: posix(path.relative(out, cdir)), handWritten: !!handFile, names: g.names });
    }
  }

  // Stock stubs (unpacked micropython-<port>[-<board>]-stubs wheel) -> flattened, managed stubPath dir
  let activeDir = null; let stockInfo = null;
  if (a.stubs) {
    activeDir = path.join(stubRoot, 'active');
    stockInfo = installStockStubs(path.resolve(a.stubs), activeDir);
  }

  // Paths in the generated file are relative to the generated file's own directory (pyright resolves them there).
  const cfgDir = path.join(out, '.mpy-workbench');
  const rel = (p) => posix(path.relative(cfgDir, p) || '.');
  const localLib = fs.existsSync(path.join(out, 'lib')) ? [rel(path.join(out, 'lib'))] : []; // mirror of the board's /lib (on sys.path)
  const extraPaths = [
    ...localLib,
    ...userRoots.map(rel),
    ...(generated.length ? [rel(genDir)] : []),
    ...upstreamRoots.map(rel), // after stubPath, so stock stubs still win for same-named modules
  ];
  const header = [
    '// GENERATED by MPY Workbench ("Update MicroPython IntelliSense"). Do not edit: it is rewritten on every update.',
    '// Put your own overrides in ../pyrightconfig.json -- that file "extends" this one and is never touched.',
  ].join('\n');
  // ENVIRONMENT ONLY.  Rule severities/typeCheckingMode deliberately live in the user-owned pyrightconfig.json:
  // pyright re-derives the whole rule set when a child config sets typeCheckingMode, silently discarding rule overrides
  // inherited from an `extends` base (observed with pyright 1.1.414).
  const config = {
    pythonPlatform: 'Linux', // same answers on macOS and Windows hosts (pyright evaluates sys.platform checks in stubs)
    ...(activeDir ? { stubPath: rel(activeDir) } : {}),
    extraPaths,
  };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'pyright.generated.json'), header + '\n' + JSON.stringify(config, null, 2) + '\n');
  const report = { tier: res.tier, frozenModules: res.modules, userRoots: userRoots.map(rel), upstreamRoots: upstreamRoots.map(rel), cModules: generated, stockStubs: stockInfo, evalErrors: res.errors, extraPaths };
  fs.writeFileSync(path.join(cfgDir, 'intellisense-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

// ----------------------------------------------------------------------------- stock stubs
// Stdlib packages that micropython-stdlib-stubs re-defines with MicroPython-only API (os.ilistdir, sys.print_exception,
// asyncio.sleep_ms, io/struct/array/json/collections/ssl differences).  Verified by grepping the 1.29 package for
// MicroPython markers.  Everything else (typing, builtins, abc, enum, types, ...) is left to pyright's bundled typeshed.
export const STDLIB_OVERRIDES = ['os', 'sys', 'json', 'asyncio', 'io', 'collections', 'array', 'struct', 'ssl', '_asyncio'];
export function installStockStubs(pkgDir, activeDir) {
  fs.rmSync(activeDir, { recursive: true, force: true });
  fs.mkdirSync(activeDir, { recursive: true });
  const skip = new Set(['stdlib', 'stubs', 'README.md', 'LICENSE.md', 'pyproject.toml']);
  let files = 0, bytes = 0;
  const copy = (src, dst) => {
    const st = fs.statSync(src);
    if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src)) copy(path.join(src, e), path.join(dst, e)); }
    else { fs.copyFileSync(src, dst); files++; bytes += st.size; }
  };
  for (const e of fs.readdirSync(pkgDir)) if (!skip.has(e) && !e.endsWith('.dist-info')) copy(path.join(pkgDir, e), path.join(activeDir, e));
  const stdlib = path.join(pkgDir, 'stdlib');
  const applied = [];
  for (const m of STDLIB_OVERRIDES) {
    for (const cand of [m, `${m}.pyi`]) if (fs.existsSync(path.join(stdlib, cand))) { copy(path.join(stdlib, cand), path.join(activeDir, cand)); applied.push(cand); }
  }
  return { files, kB: Math.round(bytes / 1024), stdlibOverrides: applied };
}

// ----------------------------------------------------------------------------- choose the stub package for a board
// probe = what `mpremote exec` reports (sys.implementation / os.uname()).  available = { pkgName: [version strings] }.
const PORT_FROM_SYSNAME = { pyboard: 'stm32', 'esp32': 'esp32', rp2: 'rp2', esp8266: 'esp8266', mimxrt: 'mimxrt', samd: 'samd', nrf52: 'nrf', renesas: 'renesas-ra' };
const verKey = (v) => v.split('.').slice(0, 3).map((x) => parseInt(x, 10) || 0);
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
export function pickStubPackage(probe, available) {
  const port = PORT_FROM_SYSNAME[probe.sysname] ?? probe.sysname;
  const board = (probe.build || '').split('-')[0].toLowerCase(); // "ESP32_GENERIC-SPIRAM" -> esp32_generic
  const names = [
    ...(board ? [`micropython-${port}-${board}-stubs`] : []),
    ...(port === 'esp32' && !board ? ['micropython-esp32-esp32_generic-stubs'] : []),
    `micropython-${port}-stubs`,
  ];
  const want = probe.version.slice(0, 3);
  let fallback = null;
  for (const name of names) {
    const vs = available[name];
    if (!vs) continue;
    // exact major.minor.patch if published, else the newest published version that is <= the board's
    const parsed = vs.map((v) => ({ v, k: verKey(v), post: parseInt(/post(\d+)/.exec(v)?.[1] ?? '0', 10) }));
    const ok = parsed.filter((p) => cmp(p.k, want) <= 0).sort((x, y) => cmp(y.k, x.k) || y.post - x.post);
    if (ok.length) {
      const exact = cmp(ok[0].k, want) === 0;
      return { package: name, version: ok[0].v, exact, note: exact ? '' : 'nearest older release' };
    }
    // this package starts after the board's firmware (e.g. board package only exists from 1.21): try the next, more generic package
    fallback ??= { package: name, version: parsed.sort((x, y) => cmp(x.k, y.k) || x.post - y.post)[0].v, exact: false, note: 'board older than all published stubs' };
  }
  return fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
