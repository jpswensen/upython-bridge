/**
 * Which MicroPython port (the `ports/<name>` folder of the source tree) a board runs, from what the identity probe reports.
 * `sys.platform` equals `os.uname().sysname` on every port and is the primary key; `_machine` text is the fallback for boards
 * that override the platform string.
 */
import type { BoardInfo } from './types';

const BY_PLATFORM: Record<string, string> = {
  esp32: 'esp32', esp8266: 'esp8266', rp2: 'rp2', pyboard: 'stm32', stm32: 'stm32', samd: 'samd', nrf: 'nrf', mimxrt: 'mimxrt',
  'renesas-ra': 'renesas-ra', zephyr: 'zephyr', alif: 'alif', psoc6: 'psoc6', cc3200: 'cc3200', WiPy: 'cc3200', webassembly: 'webassembly',
};

const BY_MACHINE: [RegExp, string][] = [
  [/\bESP32|\bESP-?32/i, 'esp32'],
  [/\bESP8266/i, 'esp8266'],
  [/\bRP2(?:040|350)|\bRaspberry Pi Pico/i, 'rp2'],
  [/\bSTM32|\bPYB(?:v|D)/i, 'stm32'],
  [/\bSAM[DE]\d|\bATSAM/i, 'samd'],
  [/\bnRF\d|\bNRF\d/i, 'nrf'],
  [/\bMIMXRT|\bi\.MX ?RT/i, 'mimxrt'],
  [/\bRA\d[A-Z]\d|\brenesas/i, 'renesas-ra'],
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Own keys only: a platform called `constructor` or `__proto__` must not find something on Object.prototype. */
const lookup = (key: string): string | undefined => (Object.prototype.hasOwnProperty.call(BY_PLATFORM, key) ? BY_PLATFORM[key] : undefined);

/**
 * The port folder name for a board, or null when it cannot be told. The identity comes from JSON that a bridge or a profile filled,
 * so every field may be null, missing or of the wrong type; those count as empty.
 */
export function portOf(board: Partial<Pick<BoardInfo, 'platform' | 'machine'>> & { uname?: { sysname?: unknown; machine?: unknown } | null }): string | null {
  const keys = [str(board.platform), str(board.uname?.sysname)];
  for (const key of keys) {
    if (key === '') { continue; }
    const hit = lookup(key) ?? lookup(key.toLowerCase());
    if (hit !== undefined) { return hit; }
  }
  for (const text of [str(board.machine), str(board.uname?.machine)]) {
    for (const [re, port] of BY_MACHINE) { if (re.test(text)) { return port; } }
  }
  return null;
}
