/**
 * Pure helpers of the Files view: sorting, sizes and device paths. Device paths are POSIX and absolute (CLAUDE.md rule 8);
 * names are whatever the board has (spaces, parentheses, non-ASCII, even a backslash) and are never normalised.
 */
import path from 'node:path';

// English collation is deterministic across hosts; `numeric` gives natural order (file2 before file10), and base sensitivity
// makes it case-insensitive.
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export interface Sortable { readonly name: string; readonly kind: 'file' | 'dir' }

/** Folders first, then files; inside each group case-insensitive natural order; raw comparison breaks exact ties. */
export function compareEntries(a: Sortable, b: Sortable): number {
  if (a.kind !== b.kind) {
    return a.kind === 'dir' ? -1 : 1;
  }
  const order = COLLATOR.compare(a.name, b.name);
  if (order !== 0) {
    return order;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** `/` + name for the root, else parent + `/` + name. `parent` has no trailing slash (see `normalizeRootPath`). */
export function joinDevicePath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/** Parent folder of a device path (`/` for top-level entries). */
export function parentOf(devicePath: string): string {
  return path.posix.dirname(devicePath);
}

export function isSameOrInside(devicePath: string, folder: string): boolean {
  return devicePath === folder || devicePath.startsWith(folder === '/' ? '/' : `${folder}/`);
}

/** `512 B`, `1.5 KB`, `2.0 MB`: short, for a tree description. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
