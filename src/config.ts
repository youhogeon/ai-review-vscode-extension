import * as vscode from 'vscode';

import { CONFIG_SECTION } from './constants';
import {
  AIReviewConfig,
  CliProvider,
  CompletionNotificationMode,
  ReviewOpenMode,
  ReviewTrigger,
  StartNotificationMode
} from './types';
import { normalizeOptionalString, normalizeStringArray } from './utils';

export interface ResourceSettingUpdateResult {
  settingId: string;
  target: vscode.ConfigurationTarget;
  scopeLabel: string;
}

export function getConfig(resource: vscode.Uri | undefined): AIReviewConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);

  return {
    enabled: config.get<boolean>('_enabled', true),
    cli: config.get<CliProvider>('_cli', 'copilot'),
    trigger: config.get<ReviewTrigger>('trigger', 'commit'),
    model: normalizeOptionalString(config.get<string>('_model', '')),
    smallChangeModel: normalizeOptionalString(config.get<string>('_smallChangeModel', '')),
    smallChangeLineThreshold: Number(config.get<number>('_smallChangeLineThreshold', 50)) || 50,
    claudeArgs: normalizeStringArray(config.get<string[]>('claudeArgs', [])),
    codexArgs: normalizeStringArray(config.get<string[]>('codexArgs', [])),
    copilotArgs: normalizeStringArray(config.get<string[]>('copilotArgs', [])),
    antigravityArgs: normalizeStringArray(config.get<string[]>('antigravityArgs', [])),
    promptFile: normalizeOptionalString(config.get<string>('promptFile', '.review/prompt.md')) || '.review/prompt.md',
    reviewDirectory: normalizeOptionalString(config.get<string>('reviewDirectory', '.review')) || '.review',
    keepReviewFileCount: Math.max(1, Number(config.get<number>('keepReviewFileCount', 10)) || 10),
    startNotificationMode: config.get<StartNotificationMode>('startNotificationMode', 'progress'),
    completionNotificationMode: config.get<CompletionNotificationMode>('completionNotificationMode', 'sticky'),
    openMode: config.get<ReviewOpenMode>('openMode', 'markdown'),
    skipCommitKeywords: normalizeStringArray(config.get<string[]>('skipCommitKeywords', ['--wip--']))
  };
}

export async function updateResourceSetting(
  resource: vscode.Uri | undefined,
  key: string,
  value: string
): Promise<ResourceSettingUpdateResult> {
  const settingId = `${CONFIG_SECTION}.${key}`;
  const config = vscode.workspace.getConfiguration(undefined, resource);
  const workspaceFolder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
  const hasMultiRoot = Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1);

  let target = vscode.ConfigurationTarget.Global;
  let scopeLabel = 'global settings';

  if (workspaceFolder && hasMultiRoot) {
    target = vscode.ConfigurationTarget.WorkspaceFolder;
    scopeLabel = `workspace folder settings (${workspaceFolder.uri.fsPath})`;
  } else if (workspaceFolder || vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
    target = vscode.ConfigurationTarget.Workspace;
    scopeLabel = vscode.workspace.workspaceFile
      ? `workspace settings (${vscode.workspace.workspaceFile.fsPath})`
      : `workspace settings (${workspaceFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath})`;
  }

  await config.update(settingId, value, target);

  return { settingId, target, scopeLabel };
}
