/**
 * What the views need to know about a session, computed in ONE place so the Files view, the context keys and the status bar
 * can never disagree (for example "is a port selected?" gates the Files welcome text and the placeholder rows alike).
 * Pure: no `vscode` import.
 */
import type { SessionState } from '../types/session';

/**
 * `ready` is an idle board, `working` a bridge file operation that holds the REPL for a moment (the protocol state `rawop`):
 * both are "connected" and neither should make the UI flicker.
 */
export type Phase = 'disconnected' | 'connecting' | 'ready' | 'working' | 'running';

export interface SessionSummary {
  /** Connected/connecting port, else the selected one, else the manual `port` setting. Never "auto". */
  readonly port: string | null;
  /** A port is known (selected, remembered or set in the settings). Drives the Files welcome text. */
  readonly hasPort: boolean;
  readonly phase: Phase;
  /** The bridge has an open connection (idle, running or a file operation). */
  readonly connected: boolean;
  readonly running: boolean;
  /** No working Python was found: the Files welcome text points to the Doctor. */
  readonly interpreterProblem: boolean;
}

const PHASES: Record<SessionState['state'], Phase> = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  idle: 'ready',
  rawop: 'working',
  running: 'running',
};

export function summarize(state: SessionState, selectedPort: string | null, portOverride: string): SessionSummary {
  const port = state.port ?? selectedPort ?? (portOverride !== '' ? portOverride : null);
  const phase = PHASES[state.state];
  return {
    port,
    hasPort: port !== null,
    phase,
    connected: phase === 'ready' || phase === 'working' || phase === 'running',
    running: phase === 'running',
    interpreterProblem: state.interpreter === 'problem',
  };
}

/** Phases that look the same to the Files view: a bridge file operation must not refresh the tree. */
export function treePhase(phase: Phase): Exclude<Phase, 'working'> {
  return phase === 'working' ? 'ready' : phase;
}
