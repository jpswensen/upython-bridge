/**
 * Editing the workspace settings file of the fallback tier: only through jsonc-parser (comments, trailing commas and unrelated keys
 * survive), only ADD keys that are absent, never touch an array the user owns, and put a marker comment on every key we add so that
 * "remove" can take back exactly those keys when their value is still the one we wrote.
 */
import { applyEdits, createScanner, modify, parse, parseTree, type FormattingOptions, type ParseError } from 'jsonc-parser';
import { IDENTITY } from '../identity';

// jsonc-parser's SyntaxKind is an ambient const enum (not usable with verbatimModuleSyntax): the token numbers of its public API
const TOKEN_COMMA = 5;
const TOKEN_LINE_COMMENT = 12;
const TOKEN_BLOCK_COMMENT = 13;
const TOKEN_EOF = 17;

export const SETTINGS_REL = '.vscode/settings.json';
const MARKER = `// ${IDENTITY.displayName}: added by the IntelliSense fallback. Remove with the "Remove IntelliSense files" command.`;

export interface KeyValue { key: string; value: unknown }

export interface SettingsEditResult {
  text: string;
  applied: string[];
  /** Keys that already existed: left alone (the user's value wins). */
  existing: string[];
  error?: string;
}

function detectFormat(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : text.includes('\r') && !text.includes('\n') ? '\r' : '\n';
  const tab = /^\t/m.test(text);
  const spaces = /^( +)\S/m.exec(text)?.[1]?.length ?? 4;
  return { insertSpaces: !tab, tabSize: tab ? 1 : spaces, eol };
}

/** Structural equality for parsed JSON values (the settings file must not go through JSON.stringify, see the lint rule). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (Array.isArray(a) && Array.isArray(b)) { return a.length === b.length && a.every((v, i) => deepEqual(v, b[i])); }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** Compact JSON text of a value (strings, numbers, booleans, null, arrays, objects) without going through the JSON global. */
function toJsonText(value: unknown): string {
  if (typeof value === 'string') { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`; }
  if (Array.isArray(value)) { return `[${value.map(toJsonText).join(', ')}]`; }
  if (typeof value === 'object' && value !== null) {
    return `{ ${Object.entries(value).map(([k, v]) => `${toJsonText(k)}: ${toJsonText(v)}`).join(', ')} }`;
  }
  return String(value);
}

function lineStartOf(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && text.charAt(i - 1) !== '\n' && text.charAt(i - 1) !== '\r') { i--; }
  return i;
}

/** Offset of the comma that follows `from` (the end of a value), or -1 when the next real token is something else. Comments are skipped. */
function commaAfter(text: string, from: number): number {
  const scanner = createScanner(text, true);
  scanner.setPosition(from);
  return scanner.scan() === TOKEN_COMMA ? scanner.getTokenOffset() : -1;
}

/**
 * Append one property to the root object WITHOUT reformatting anything else. Positions come from the parse tree and the scanner
 * (never from regexes over the text): the comma goes right after the last value (a comma inside a trailing comment is not a
 * separator), the new lines go in front of the line that holds the closing brace, or in front of the brace itself when it shares
 * its line with other content, and a marker comment precedes the key. (jsonc-parser's modify() with formatting options re-prints
 * the neighbouring property, which would reflow an array the user owns.) The caller re-parses the result and refuses it if it is
 * not what was meant.
 */
function appendProperty(text: string, key: string, value: unknown, format: FormattingOptions): string {
  const eol = format.eol ?? '\n';
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (tree === undefined || tree.type !== 'object') { return text; }
  const closeAt = tree.offset + tree.length - 1;
  if (text.charAt(closeAt) !== '}') { return text; }
  const last = tree.children?.[tree.children.length - 1];
  const unit = format.insertSpaces === false ? '\t' : ' '.repeat(format.tabSize ?? 4);
  let indent = unit;
  if (last !== undefined) {
    const lead = text.slice(lineStartOf(text, last.offset), last.offset);
    if (/^[ \t]*$/.test(lead)) { indent = lead; }
  }
  const block = `${indent}${MARKER}${eol}${indent}${toJsonText(key)}: ${toJsonText(value)}`;
  const braceLine = lineStartOf(text, closeAt);
  const ownLine = /^[ \t]*$/.test(text.slice(braceLine, closeAt));
  let insertAt: number;
  let insertion: string;
  if (ownLine) {
    insertAt = braceLine;
    insertion = `${block}${eol}`;
  } else {
    insertAt = closeAt;
    while (insertAt > 0 && (text.charAt(insertAt - 1) === ' ' || text.charAt(insertAt - 1) === '\t')) { insertAt--; }
    insertion = `${eol}${block}${eol}`;
  }
  let head = text.slice(0, insertAt);
  if (last !== undefined) {
    const valueEnd = last.offset + last.length;
    if (commaAfter(text, valueEnd) < 0) { head = `${text.slice(0, valueEnd)},${text.slice(valueEnd, insertAt)}`; }
  }
  return `${head}${insertion}${text.slice(insertAt)}`;
}

/** True when `after` is valid JSONC, still has every original key with its value and every comment, and carries the new keys. */
function editIsSound(before: string, after: string, items: KeyValue[]): boolean {
  const errors: ParseError[] = [];
  const parsed = parse(after, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { return false; }
  const was = parse(before, [], { allowTrailingComma: true }) as Record<string, unknown>;
  const now = parsed as Record<string, unknown>;
  if (!Object.keys(was).every((k) => k in now && deepEqual(was[k], now[k]))) { return false; }
  if (!items.every((i) => i.key in now && deepEqual(now[i.key], i.value))) { return false; }
  const scanner = createScanner(before, false);
  for (let t = scanner.scan(); t !== TOKEN_EOF; t = scanner.scan()) {
    if ((t === TOKEN_LINE_COMMENT || t === TOKEN_BLOCK_COMMENT) && !after.includes(scanner.getTokenValue())) { return false; }
  }
  return true;
}

export function addSettingsKeys(existingText: string | null, items: KeyValue[]): SettingsEditResult {
  const hadBom = existingText?.charCodeAt(0) === 0xfeff;
  let text = (existingText ?? '').replace(/^\uFEFF/, '');
  if (text.trim() === '') { text = '{\n}\n'; }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { text: existingText ?? '', applied: [], existing: [], error: 'The settings file is not valid JSON with comments, so it was not changed. Fix it, or add the keys yourself.' };
  }
  const format = detectFormat(text);
  const original = text;
  const applied: string[] = [];
  const existing: string[] = [];
  for (const item of items) {
    if (item.key in (parsed as Record<string, unknown>)) { existing.push(item.key); continue; }
    text = appendProperty(text, item.key, item.value, format);
    applied.push(item.key);
  }
  if (applied.length > 0 && !editIsSound(original, text, items.filter((i) => applied.includes(i.key)))) {
    // fail closed: never write a settings file we have not re-read successfully
    return { text: existingText ?? '', applied: [], existing: [], error: 'The settings file has a layout the extension could not edit safely, so it was not changed. Add the keys yourself.' };
  }
  return { text: (hadBom ? '\uFEFF' : '') + text, applied, existing };
}

/**
 * Remove one property line-wise: its own line(s), the marker line above it when present, and the comma we added after the previous
 * value (so the text goes back to what it was). Returns null when the property shares its line with something else; the caller
 * then falls back to jsonc-parser's modify().
 */
function removePropertyLines(text: string, key: string): string | null {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  const props = tree?.children ?? [];
  const idx = props.findIndex((p) => p.children?.[0]?.value === key);
  const prop = props[idx];
  if (prop === undefined) { return null; }
  let lineStart = text.lastIndexOf('\n', prop.offset - 1) + 1;
  if (!/^[ \t]*$/.test(text.slice(lineStart, prop.offset))) { return null; }
  const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1;
  if (lineStart > 0 && text.slice(prevStart, lineStart).trim() === MARKER) { lineStart = prevStart; }
  const end = prop.offset + prop.length;
  const tail = /^[ \t]*(,)?[ \t]*(?:\/\/[^\n]*)?(?:\r?\n|$)/.exec(text.slice(end));
  if (tail === null) { return null; }
  let out = text.slice(0, lineStart) + text.slice(end + tail[0].length);
  if (tail[1] === undefined && idx > 0) {
    const before = props[idx - 1] as NonNullable<typeof prop>;
    const prevEnd = before.offset + before.length;
    if (out.charAt(prevEnd) === ',') { out = out.slice(0, prevEnd) + out.slice(prevEnd + 1); }
  }
  return out;
}

/** The text still parses and no longer has the key. */
function removalIsSound(text: string, key: string): boolean {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  return errors.length === 0 && parsed !== undefined && typeof parsed === 'object' && !(key in parsed);
}

export interface RemoveResult { text: string; removed: string[]; kept: string[] }

/** Take back keys we added, if (and only if) their value is still what we wrote. */
export function removeSettingsKeys(existingText: string, items: KeyValue[]): RemoveResult {
  const hadBom = existingText.charCodeAt(0) === 0xfeff;
  let text = existingText.replace(/^\uFEFF/, '');
  const removed: string[] = [];
  const kept: string[] = [];
  for (const item of items) {
    const errors: ParseError[] = [];
    const parsed = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
    if (errors.length > 0 || parsed === undefined || !(item.key in parsed)) { kept.push(item.key); continue; }
    if (!deepEqual(parsed[item.key], item.value)) { kept.push(item.key); continue; }
    const lineWise = removePropertyLines(text, item.key);
    const candidate = lineWise !== null && removalIsSound(lineWise, item.key) ? lineWise : applyEdits(text, modify(text, [item.key], undefined, {}));
    if (!removalIsSound(candidate, item.key)) { kept.push(item.key); continue; }
    text = candidate;
    removed.push(item.key);
  }
  return { text: (hadBom ? '\uFEFF' : '') + text, removed, kept };
}
