import * as vscode from 'vscode';

import { AIReviewController } from './controller/aiReviewController';

let controller: AIReviewController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new AIReviewController(context);
  await controller.activate();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
