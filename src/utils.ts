import * as path from 'path';
import * as vscode from 'vscode';

import { REVIEW_FILE_PREFIX } from './constants';

export function resolvePath(root: string, configuredPath: string): string {
  if (!configuredPath) {
    return root;
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return path.join(root, configuredPath);
}

export function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildReviewFileName(trigger: string, commit: string): string {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ];
  const timeParts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ];
  const timestamp = `${parts.join('-')}_${timeParts.join('-')}`;
  const shortCommit = (commit || 'unknown').slice(0, 7);
  return `${REVIEW_FILE_PREFIX}${timestamp}-${shortCommit}-${trigger}.md`;
}

export function toConfigPath(
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  targetPath: string
): string {
  if (!workspaceFolder) {
    return targetPath;
  }

  const relativePath = path.relative(workspaceFolder.uri.fsPath, targetPath);
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join('/');
  }

  return targetPath;
}

export function getPreferredWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      return activeFolder;
    }
  }

  return vscode.workspace.workspaceFolders?.[0];
}
