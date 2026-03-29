import * as vscode from 'vscode';

import { CONFIG_SECTION } from './constants';
import {
  AIReviewConfig,
  CliProvider,
  CompletionNotificationMode,
  ReviewTrigger,
  StartNotificationMode
} from './types';
import { normalizeOptionalString, normalizeStringArray } from './utils';

export function getConfig(resource: vscode.Uri): AIReviewConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);

  return {
    enabled: config.get<boolean>('enabled', true),
    cli: config.get<CliProvider>('cli', 'claude'),
    trigger: config.get<ReviewTrigger>('trigger', 'commit'),
    model: normalizeOptionalString(config.get<string>('model', '')),
    smallChangeModel: normalizeOptionalString(config.get<string>('smallChangeModel', '')),
    smallChangeLineThreshold: Number(config.get<number>('smallChangeLineThreshold', 50)) || 50,
    claudeArgs: normalizeStringArray(config.get<string[]>('claudeArgs', [])),
    codexArgs: normalizeStringArray(config.get<string[]>('codexArgs', [])),
    copilotArgs: normalizeStringArray(config.get<string[]>('copilotArgs', [])),
    promptFile: normalizeOptionalString(config.get<string>('promptFile', '.review/prompt.md')) || '.review/prompt.md',
    reviewDirectory: normalizeOptionalString(config.get<string>('reviewDirectory', '.review')) || '.review',
    keepReviewFileCount: Math.max(1, Number(config.get<number>('keepReviewFileCount', 10)) || 10),
    startNotificationMode: config.get<StartNotificationMode>('startNotificationMode', 'progress'),
    completionNotificationMode: config.get<CompletionNotificationMode>('completionNotificationMode', 'sticky'),
    skipCommitKeywords: normalizeStringArray(config.get<string[]>('skipCommitKeywords', []))
  };
}

export async function updateResourceSetting(
  resource: vscode.Uri | undefined,
  key: string,
  value: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const hasMultiRoot = Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1);
  const target = resource
    ? (hasMultiRoot ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace)
    : vscode.ConfigurationTarget.Global;

  await config.update(key, value, target);
}
