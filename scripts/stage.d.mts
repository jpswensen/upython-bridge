export const ROOT_FILES: string[];
export const SHIPPED_DIRS: string[];
export const BUNDLE: string;
export function isSkipped(name: string, isDirectory: boolean): boolean;
export function stageExtension(srcRoot: string, destRoot: string): string[];
