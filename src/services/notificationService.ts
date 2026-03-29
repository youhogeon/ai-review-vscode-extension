import * as vscode from 'vscode';

import { TRANSIENT_NOTIFICATION_DURATION_MS } from '../constants';
import {
  CompletionSeverity,
  CompletionNotificationMode,
  StartNotificationMode
} from '../types';

interface StartNotificationOptions {
  stopLabel?: string;
  onStop?: () => void | Promise<void>;
}

export class NotificationService {
  async runWithStartNotification<T>(
    mode: StartNotificationMode,
    title: string,
    task: () => Promise<T>,
    options: StartNotificationOptions = {}
  ): Promise<T> {
    if (mode === 'progress') {
      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title,
          cancellable: true
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            void options.onStop?.();
          });

          return task();
        }
      );
    }

    void this.showStopToast(title, options.stopLabel ?? 'Stop', options.onStop);
    return task();
  }

  async showCompletion(
    mode: CompletionNotificationMode,
    message: string,
    severity: CompletionSeverity
  ): Promise<void> {
    if (mode === 'brief') {
      vscode.window.setStatusBarMessage(message, TRANSIENT_NOTIFICATION_DURATION_MS);
      return;
    }

    if (severity === 'warning') {
      await vscode.window.showWarningMessage(message);
      return;
    }

    await vscode.window.showInformationMessage(message);
  }

  private async showStopToast(
    title: string,
    stopLabel: string,
    onStop?: () => void | Promise<void>
  ): Promise<void> {
    const selection = await vscode.window.showInformationMessage(title, stopLabel);

    if (selection === stopLabel) {
      await onStop?.();
    }
  }
}
