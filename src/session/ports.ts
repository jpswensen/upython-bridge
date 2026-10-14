/**
 * Port selection helpers (D-11), pure so they can be tested without a bridge or `vscode`.
 * "auto" is a choice in the UI over `ports.list` metadata (which never opens a port); it is never sent to the bridge and
 * never written to settings. On macOS the bridge only lists `/dev/cu.*`.
 */
import type { PortRow } from '../types/protocol';
import type { RememberedPort } from '../types/settings';

/** True for the word auto in any case and spacing: not a port name. */
export function isAutoPort(port: string): boolean {
  return port.trim().toLowerCase() === 'auto';
}

/** `socket://host:port`, `rfc2217://...`, `loop://`: a transport, not a device listed by `ports.list`. */
export function isUrlPort(port: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(port.trim());
}

export type AutoPortChoice =
  /** Exactly one likely board: select it and show its name. */
  | { kind: 'one'; port: PortRow }
  /** Several likely boards: the caller shows a QuickPick (most likely first). */
  | { kind: 'many'; ports: PortRow[] }
  /** No likely board: the caller shows every port (maybe none) so the student can still choose. */
  | { kind: 'none'; ports: PortRow[] };

export function chooseAutoPort(rows: readonly PortRow[]): AutoPortChoice {
  const likely = rows.filter((r) => r.likelyBoard);
  if (likely.length === 1 && likely[0]) {
    return { kind: 'one', port: likely[0] };
  }
  if (likely.length > 1) {
    return { kind: 'many', ports: likely };
  }
  return { kind: 'none', ports: [...rows] };
}

/** Same adapter (VID and PID) when both sides know them; unknown on either side counts as a match. */
function sameAdapter(a: { vid: number | null; pid: number | null }, b: { vid: number | null; pid: number | null }): boolean {
  return (a.vid === null || b.vid === null || a.vid === b.vid) && (a.pid === null || b.pid === null || a.pid === b.pid);
}

/**
 * Find the remembered board among the current ports: the same device name with the same adapter first; otherwise the ONE port
 * with the remembered VID/PID (a Windows COM number or a macOS serial suffix can change when the cable moves). Two boards
 * with the same adapter are ambiguous: null, so the student chooses (serial numbers are not unique on cheap adapters, N-11).
 */
export function matchRememberedPort(remembered: RememberedPort | null, rows: readonly PortRow[]): PortRow | null {
  if (!remembered) {
    return null;
  }
  const byName = rows.find((r) => r.device.toLowerCase() === remembered.device.toLowerCase());
  if (byName && sameAdapter(byName, remembered)) {
    return byName;
  }
  if (remembered.vid === null || remembered.pid === null) {
    return null;
  }
  const sameIds = rows.filter((r) => r.vid === remembered.vid && r.pid === remembered.pid);
  return sameIds.length === 1 ? (sameIds[0] ?? null) : null;
}
