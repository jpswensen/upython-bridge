/** The part of `MpySettings` the views read. A narrow type so tests can pass the real `Settings` and the views stay honest. */
import type { MpySettings } from '../types/settings';

export type ViewSettings = Pick<MpySettings, 'rootPath' | 'portOverride' | 'autoSync' | 'onDidChange'>;
