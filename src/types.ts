import * as vscode from 'vscode';

export type CliProvider = 'claude' | 'codex' | 'copilot';
export type ReviewTrigger = 'commit' | 'push' | 'commitAndPush' | 'manual';
export type StartNotificationMode = 'progress' | 'brief';
export type CompletionNotificationMode = 'sticky' | 'brief';
export type ReviewHint = 'commit' | 'push' | 'suppress';
export type CompletionSeverity = 'info' | 'warning';
export type ReviewRunStatus = 'starting' | 'running' | 'stopping' | 'cancelled' | 'completed' | 'failed';

export interface AIReviewConfig {
  enabled: boolean;
  cli: CliProvider;
  trigger: ReviewTrigger;
  model: string;
  smallChangeModel: string;
  smallChangeLineThreshold: number;
  claudeArgs: string[];
  codexArgs: string[];
  copilotArgs: string[];
  promptFile: string;
  reviewDirectory: string;
  keepReviewFileCount: number;
  startNotificationMode: StartNotificationMode;
  completionNotificationMode: CompletionNotificationMode;
  skipCommitKeywords: string[];
}

export interface RepoSnapshot {
  headCommit: string;
  headName: string;
  upstreamName: string;
  upstreamCommit: string;
  ahead: number;
  behind: number;
}

export interface ReviewContext {
  key: string;
  root: string;
  trigger: ReviewTrigger | 'manual';
  commit: string;
  commitRange: string;
  changedLines: number;
  model: string;
  prompt: string;
  promptFilePath: string;
  provider: CliProvider;
  cliArgs: string[];
  filePath: string;
  keepReviewFileCount: number;
  startNotificationMode: StartNotificationMode;
  completionNotificationMode: CompletionNotificationMode;
}

export interface ReviewRunRecord {
  id: string;
  key: string;
  root: string;
  trigger: ReviewTrigger | 'manual';
  provider: CliProvider;
  commit: string;
  commitRange: string;
  promptFilePath: string;
  reviewFilePath: string;
  startedAt: number;
  status: ReviewRunStatus;
  pid: number | undefined;
  requestedStop: boolean;
}

export interface RepoState {
  repository: GitRepository;
  root: string;
  snapshot: RepoSnapshot;
  eventChain: Promise<void>;
  reviewChain: Promise<void>;
  pendingHints: ReviewHint[];
  suppressReviewsUntil: number;
  disposables: vscode.Disposable[];
}

export interface GitRepository {
  rootUri?: vscode.Uri;
  root?: string;
  state?: {
    onDidChange?: vscode.Event<void>;
  };
  onDidRunGitStatus?: vscode.Event<void>;
  onDidRunOperation?: vscode.Event<unknown>;
}

export interface GitExtensionApi {
  repositories: GitRepository[];
  onDidOpenRepository?: vscode.Event<GitRepository>;
  onDidCloseRepository?: vscode.Event<GitRepository>;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  cancelled: boolean;
}

export interface ProcessHandle {
  pid: number;
  stop: () => Promise<void>;
}

export interface PromptBuildOptions {
  root: string;
  trigger: ReviewContext['trigger'];
  commit: string;
  commitRange: string;
  promptFile: string;
}
