/**
 * The questions the IntelliSense setup asks, behind one small interface so the flow can be driven by tests.
 * Production: QuickPick / modal / toast. Tests: `ScriptedPrompter` (src/testApi.ts), because a modal cannot be answered
 * from inside a real extension host. Nothing here is modal except the one confirmation before files are written or removed,
 * and the first-connect offer is a plain toast: it never blocks the connection.
 */
import * as vscode from 'vscode';
import { IDENTITY } from '../identity';
import { consentLabel } from '../intellisense/preview';
import type { Consent } from '../intellisense';
import type { IntelliSensePlan } from '../intellisense/types';
import type { Logger } from '../log';
import { showToast } from '../toast';

export type OfferAnswer = 'setup' | 'later' | 'never';

export interface IntelliSensePrompter {
  /** What the user agrees to; undefined = cancelled (nothing is written). The preview document is already open. */
  choose(plan: IntelliSensePlan): Promise<Consent | undefined>;
  /** Confirm removing the listed files. */
  confirmRemove(detail: string): Promise<boolean>;
  /** The first-connect offer. Undefined = dismissed (same as "Not now"). */
  offer(): Promise<OfferAnswer | undefined>;
  /**
   * May the setup import these modules on the board to learn what they contain? Asked once per firmware. Undefined = dismissed
   * (nothing is imported this time, and the question comes again next time).
   */
  importModules(request: ImportRequest): Promise<'continue' | 'skip' | undefined>;
}

export interface ImportRequest { modules: readonly string[]; label: string }

export const IMPORT_BUTTONS = { yes: 'Continue', no: 'Skip' } as const;

/** The question, worded for a student. Exported for the tests. */
export function importQuestion(request: ImportRequest): { message: string; detail: string } {
  const shown = request.modules.slice(0, 8);
  const more = request.modules.length - shown.length;
  const names = `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  return {
    message: `To learn what ${names} contain${request.modules.length === 1 ? 's' : ''}, ${IDENTITY.displayName} imports ${request.modules.length === 1 ? 'it' : 'them'} on the board once.`,
    detail: `Importing runs their setup code, nothing else. Afterwards Python on the board is restarted so it starts fresh; your main.py is not started. Your files on the board are not changed.\n\nBoard: ${request.label}. This is asked once for this firmware. Skip: the editor accepts these modules without checking what is in them.`,
  };
}

export const OFFER_BUTTONS = { setup: 'Set up', later: 'Not now', never: "Don't ask again" } as const;

interface ConsentPick extends vscode.QuickPickItem { id: 'files' | 'create-user-config' | 'edit-settings' }

export class VsCodePrompter implements IntelliSensePrompter {
  constructor(private readonly log: Pick<Logger, 'error'>) {}

  async choose(plan: IntelliSensePlan): Promise<Consent | undefined> {
    const none: Consent = { createUserConfig: false, editSettings: false };
    if (plan.consent.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        'Set up MicroPython IntelliSense?',
        { modal: true, detail: `${plan.summary}\n\nThe preview next to this message lists every file. Nothing outside the project folder is changed.` },
        'Set up',
      );
      return choice === 'Set up' ? none : undefined;
    }
    const items: ConsentPick[] = [
      { id: 'files', label: 'Write the generated files', description: 'required', detail: plan.summary, picked: true },
      ...plan.consent.map((c): ConsentPick => ({
        id: c.id, label: consentLabel(c), detail: c.message, picked: c.picked ?? true,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true, ignoreFocusOut: true, title: 'Set up MicroPython IntelliSense',
      placeHolder: 'Tick what you agree to, then press OK. Escape changes nothing. The preview next to this list shows every file.',
    });
    if (picked === undefined || !picked.some((p) => p.id === 'files')) {
      return undefined;
    }
    const has = (id: ConsentPick['id']): boolean => picked.some((p) => p.id === id);
    return { createUserConfig: has('create-user-config'), editSettings: has('edit-settings') };
  }

  async confirmRemove(detail: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(`Remove the IntelliSense files made by ${IDENTITY.displayName}?`, { modal: true, detail }, 'Remove files');
    return choice === 'Remove files';
  }

  async importModules(request: ImportRequest): Promise<'continue' | 'skip' | undefined> {
    const q = importQuestion(request);
    const choice = await vscode.window.showInformationMessage(q.message, { modal: true, detail: q.detail }, IMPORT_BUTTONS.yes, IMPORT_BUTTONS.no);
    return choice === IMPORT_BUTTONS.yes ? 'continue' : choice === IMPORT_BUTTONS.no ? 'skip' : undefined;
  }

  async offer(): Promise<OfferAnswer | undefined> {
    const choice = await showToast(
      this.log, 'info',
      'Want code completion and import checking for MicroPython in this folder? Setting up MicroPython IntelliSense takes a few seconds and shows you every file first.',
      OFFER_BUTTONS.setup, OFFER_BUTTONS.later, OFFER_BUTTONS.never,
    );
    return choice === OFFER_BUTTONS.setup ? 'setup' : choice === OFFER_BUTTONS.never ? 'never' : choice === OFFER_BUTTONS.later ? 'later' : undefined;
  }
}
