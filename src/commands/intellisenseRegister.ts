/** Wires the IntelliSense feature (commands, quick fix, first-connect offer) in activate(). */
import * as vscode from 'vscode';
import { nodeFs } from '../intellisense';
import type { Services } from '../types/services';
import { IntelliSenseController, registerIntelliSenseCommands, type IntelliSenseDeps } from './intellisense';
import { IntelliSenseOffer } from './intellisenseOffer';
import { registerQuickFix } from './intellisenseQuickFix';

export interface IntelliSenseFeature {
  controller: IntelliSenseController;
  disposables: vscode.Disposable[];
}

export function registerIntelliSense(services: Services, parts: IntelliSenseDeps): IntelliSenseFeature {
  const controller = new IntelliSenseController(services, parts);
  const fs = parts.deps?.fs ?? nodeFs();
  const offer = new IntelliSenseOffer({
    session: services.session, settings: services.settings, state: services.context.workspaceState, log: services.log.child('intellisense'),
    fs, prompter: parts.prompter, controller,
  });
  return { controller, disposables: [...registerIntelliSenseCommands(controller), registerQuickFix(fs), offer] };
}
