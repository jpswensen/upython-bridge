/**
 * A tiny test runner for the REAL extension host (no mocha, nothing downloaded). Suites run one after the other, each test with
 * its own timeout; every outcome (pass, fail with stack, skip) goes into results.json, which is rewritten after every test so a
 * hang still leaves evidence. run() of the entry ALWAYS resolves (a global guard ends the run), so VS Code exits by itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Status = 'pass' | 'fail' | 'skip';

export interface TestResult {
  name: string;
  status: Status;
  ms: number;
  error?: string;
  notes?: string[];
}

export interface SuiteResult {
  name: string;
  tests: TestResult[];
}

/** Handed to every test: `note` attaches evidence (what was observed) to the test's entry in results.json. */
export interface TestContext {
  note(text: string): void;
}

export type TestFn = (t: TestContext) => Promise<void> | void;

interface Registered {
  name: string;
  fn: TestFn | undefined;
  timeoutMs: number;
  skipReason?: string;
}

export class SuiteBuilder {
  readonly tests: Registered[] = [];

  /** A test; `timeoutMs` defaults to 60 s. */
  test(name: string, fn: TestFn, timeoutMs = 60_000): void {
    this.tests.push({ name, fn, timeoutMs });
  }

  skip(name: string, reason: string): void {
    this.tests.push({ name, fn: undefined, timeoutMs: 0, skipReason: reason });
  }
}

export interface SuiteDef {
  name: string;
  define(s: SuiteBuilder): void;
}

export interface RunnerOptions {
  outFile: string;
  requested: string;
  guardMs: number;
  /** Extra top-level facts for results.json (vscode version, extension list...). */
  facts: () => Record<string, unknown>;
}

export interface Results {
  ok: boolean;
  requested: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  suites: SuiteResult[];
  counts: { ran: number; passed: number; failed: number; skipped: number; passed_total?: number };
  fatal?: string;
  [key: string]: unknown;
}

function count(results: Results): void {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of results.suites) {
    for (const t of s.tests) {
      if (t.status === 'pass') passed++;
      else if (t.status === 'fail') failed++;
      else skipped++;
    }
  }
  results.counts = { ran: passed + failed, passed, failed, skipped };
  results.ok = failed === 0 && passed > 0 && results.fatal === undefined;
}

function write(opts: RunnerOptions, results: Results): void {
  count(results);
  const tmp = `${opts.outFile}.tmp`;
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ ...results, ...opts.facts() }, null, 2));
  fs.renameSync(tmp, opts.outFile);
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`test timed out after ${ms} ms (${what})`)), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

export async function runSuites(defs: readonly SuiteDef[], opts: RunnerOptions): Promise<Results> {
  const started = Date.now();
  const results: Results = {
    ok: false, requested: opts.requested, startedAt: new Date(started).toISOString(), suites: [],
    counts: { ran: 0, passed: 0, failed: 0, skipped: 0 },
  };
  write(opts, results);
  let guarded = false;
  const guard = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      guarded = true;
      results.fatal = `global guard: the run did not finish within ${opts.guardMs} ms`;
      resolve();
    }, opts.guardMs);
    timer.unref();
  });

  const body = async (): Promise<void> => {
    for (const def of defs) {
      const suite: SuiteResult = { name: def.name, tests: [] };
      results.suites.push(suite);
      const builder = new SuiteBuilder();
      try {
        def.define(builder);
      } catch (err) {
        suite.tests.push({ name: '(defining the suite)', status: 'fail', ms: 0, error: String((err as Error)?.stack ?? err) });
        write(opts, results);
        continue;
      }
      for (const reg of builder.tests) {
        if (guarded) return;
        if (reg.fn === undefined) {
          suite.tests.push({ name: reg.name, status: 'skip', ms: 0, notes: [reg.skipReason ?? ''] });
          write(opts, results);
          continue;
        }
        const notes: string[] = [];
        const t0 = Date.now();
        const entry: TestResult = { name: reg.name, status: 'pass', ms: 0 };
        try {
          await withTimeout(Promise.resolve(reg.fn({ note: (text) => { notes.push(text); } })), reg.timeoutMs, reg.name);
        } catch (err) {
          entry.status = 'fail';
          entry.error = String((err as Error)?.stack ?? err);
        }
        entry.ms = Date.now() - t0;
        if (notes.length > 0) entry.notes = notes;
        suite.tests.push(entry);
        write(opts, results);
      }
    }
  };

  await Promise.race([body().catch((err: unknown) => { results.fatal = `runner error: ${String((err as Error)?.stack ?? err)}`; }), guard]);
  results.finishedAt = new Date().toISOString();
  results.durationMs = Date.now() - started;
  write(opts, results);
  return results;
}
