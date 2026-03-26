import * as path from 'path';
import * as vscode from 'vscode';

import { getConfig, updateResourceSetting } from '../config';
import {
  OPERATION_SUPPRESSION_WINDOW_MS,
  OPERATION_COMMIT,
  OPERATION_PUSH,
  OUTPUT_CHANNEL_NAME,
  SNAPSHOT_SETTLE_DELAY_MS
} from '../constants';
import { GitService } from '../services/gitService';
import { NotificationService } from '../services/notificationService';
import { ProcessService } from '../services/processService';
import { ReviewDashboardService } from '../services/reviewDashboardService';
import { ReviewService } from '../services/reviewService';
import {
  AIReviewConfig,
  CliProvider,
  GitExtensionApi,
  GitRepository,
  RepoSnapshot,
  RepoState,
  ReviewContext,
  ReviewHint
} from '../types';
import {
  buildReviewFileName,
  getPreferredWorkspaceFolder,
  resolvePath,
  sleep,
  toConfigPath
} from '../utils';

export class AIReviewController {
  private readonly output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  private readonly repoStates = new Map<string, RepoState>();
  private readonly processService = new ProcessService();
  private readonly notificationService = new NotificationService();
  private readonly reviewDashboardService: ReviewDashboardService;
  private readonly gitService: GitService;
  private readonly reviewService: ReviewService;

  private gitApi: GitExtensionApi | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.reviewDashboardService = new ReviewDashboardService(this.context, this.output);
    this.gitService = new GitService(this.processService);
    this.reviewService = new ReviewService(
      this.output,
      this.notificationService,
      this.processService,
      this.reviewDashboardService
    );
  }

  async activate(): Promise<void> {
    this.context.subscriptions.push(this.output);
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ReviewDashboardService.viewType, this.reviewDashboardService)
    );

    this.disposables.push(
      vscode.commands.registerCommand('aiReview.runManualReview', () => this.runManualReview()),
      vscode.commands.registerCommand('aiReview.openDashboard', () => this.reviewDashboardService.openDashboard()),
      vscode.commands.registerCommand('aiReview.selectPromptFile', () => this.selectPromptFile()),
      vscode.commands.registerCommand('aiReview.selectReviewFolder', () => this.selectReviewFolder())
    );

    this.context.subscriptions.push(...this.disposables);

    const gitApi = await this.getGitApi();
    if (!gitApi) {
      this.log('Git extension API is not available. Automatic review listeners were not started.');
      return;
    }

    this.gitApi = gitApi;

    for (const repository of gitApi.repositories) {
      await this.attachRepository(repository);
    }
    this.syncDashboardRepositories();

    if (gitApi.onDidOpenRepository) {
      this.context.subscriptions.push(
        gitApi.onDidOpenRepository((repository) => {
          void this.attachRepository(repository).catch((error) => {
            this.logError('Failed to attach repository', error);
          });
        })
      );
    }

    if (gitApi.onDidCloseRepository) {
      this.context.subscriptions.push(
        gitApi.onDidCloseRepository((repository) => {
          this.detachRepository(repository);
        })
      );
    }
  }

  dispose(): void {
    for (const state of this.repoStates.values()) {
      this.disposeRepoState(state);
    }

    this.repoStates.clear();
    this.reviewDashboardService.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async getGitApi(): Promise<GitExtensionApi | undefined> {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) {
      vscode.window.showWarningMessage(vscode.l10n.t('VS Code Git extension was not found. AI Review is idle.'));
      return undefined;
    }

    const extensionExports = extension.isActive ? extension.exports : await extension.activate();
    if (!extensionExports || typeof extensionExports.getAPI !== 'function') {
      vscode.window.showWarningMessage(vscode.l10n.t('VS Code Git API is unavailable. AI Review is idle.'));
      return undefined;
    }

    return extensionExports.getAPI(1) as GitExtensionApi;
  }

  private async attachRepository(repository: GitRepository): Promise<void> {
    const root = this.getRepositoryRoot(repository);
    if (!root || this.repoStates.has(root)) {
      return;
    }

    const state: RepoState = {
      repository,
      root,
      snapshot: await this.gitService.captureSnapshot(root),
      eventChain: Promise.resolve(),
      reviewChain: Promise.resolve(),
      pendingHints: [],
      suppressReviewsUntil: 0,
      disposables: []
    };

    state.disposables.push(
      this.safeEvent(repository.state?.onDidChange, () => {
        this.queueRepositoryEvaluation(state);
      }),
      this.safeEvent(repository.onDidRunGitStatus, () => {
        this.queueRepositoryEvaluation(state);
      }),
      this.safeEvent(repository.onDidRunOperation, (event) => {
        const kind = this.getOperationKind(event);
        if (kind) {
          this.log(`Git operation detected for ${root}: ${kind}`);
        }

        if (this.shouldSuppressOperation(kind)) {
          state.suppressReviewsUntil = Date.now() + OPERATION_SUPPRESSION_WINDOW_MS;
          this.log(`Suppressing automatic reviews for ${root} after git operation: ${kind}`);
          this.queueRepositoryEvaluation(state, 'suppress');
          return;
        }

        if (kind === OPERATION_COMMIT) {
          this.queueRepositoryEvaluation(state, 'commit');
          return;
        }

        if (kind === OPERATION_PUSH) {
          this.queueRepositoryEvaluation(state, 'push');
          return;
        }

        this.queueRepositoryEvaluation(state);
      })
    );

    this.repoStates.set(root, state);
    this.syncDashboardRepositories();
    this.log(`Attached repository: ${root}`);
  }

  private detachRepository(repository: GitRepository): void {
    const root = this.getRepositoryRoot(repository);
    if (!root) {
      return;
    }

    const state = this.repoStates.get(root);
    if (!state) {
      return;
    }

    this.disposeRepoState(state);
    this.repoStates.delete(root);
    this.syncDashboardRepositories();
    this.log(`Detached repository: ${root}`);
  }

  private disposeRepoState(state: RepoState): void {
    vscode.Disposable.from(...state.disposables).dispose();
  }

  private safeEvent<T>(
    eventFactory: vscode.Event<T> | undefined,
    listener: (event: T) => void
  ): vscode.Disposable {
    if (!eventFactory) {
      return new vscode.Disposable(() => {});
    }

    try {
      return eventFactory(listener);
    } catch (error) {
      this.logError('Failed to subscribe to repository event', error);
      return new vscode.Disposable(() => {});
    }
  }

  private queueRepositoryEvaluation(state: RepoState, hint?: ReviewHint): void {
    if (hint) {
      state.pendingHints.push(hint);
    }

    state.eventChain = state.eventChain
      .catch(() => {})
      .then(async () => {
        await sleep(SNAPSHOT_SETTLE_DELAY_MS);
        const hints = state.pendingHints.splice(0);
        await this.evaluateRepositoryState(state, hints);
      });
  }

  private async evaluateRepositoryState(state: RepoState, hints: ReviewHint[]): Promise<void> {
    const resource = vscode.Uri.file(state.root);
    const config = getConfig(resource);

    if (!config.enabled) {
      state.snapshot = await this.gitService.captureSnapshot(state.root);
      return;
    }

    const previous = state.snapshot;
    const current = await this.gitService.captureSnapshot(state.root);
    state.snapshot = current;

    if (!current.headCommit) {
      return;
    }

    const hintSet = new Set(hints);
    if (hintSet.has('suppress') || Date.now() < state.suppressReviewsUntil) {
      return;
    }

    if (
      (await this.shouldRunCommitReview(state.root, previous, current, hintSet)) &&
      this.triggerMatches(config.trigger, 'commit')
    ) {
      const reviewContext = await this.buildReviewContext(
        state.root,
        'commit',
        previous,
        current,
        config,
        true
      );

      if (reviewContext) {
        this.enqueueReview(state, reviewContext);
      }
    }

    if (this.shouldRunPushReview(previous, current, hintSet) && this.triggerMatches(config.trigger, 'push')) {
      const reviewContext = await this.buildReviewContext(
        state.root,
        'push',
        previous,
        current,
        config,
        true
      );

      if (reviewContext) {
        this.enqueueReview(state, reviewContext);
      }
    }
  }

  private async shouldRunCommitReview(
    root: string,
    previous: RepoSnapshot,
    current: RepoSnapshot,
    hintSet: ReadonlySet<ReviewHint>
  ): Promise<boolean> {
    if (hintSet.has('commit')) {
      return true;
    }

    // First commit in a new repo: no previous HEAD → treat as a commit
    if (!previous.headCommit && current.headCommit) {
      return true;
    }

    if (previous.headCommit === current.headCommit) {
      return false;
    }

    if (previous.headName && current.headName && previous.headName !== current.headName) {
      return false;
    }

    // Detect pull/fetch: upstream moved forward → not a local commit
    if (
      previous.upstreamCommit &&
      current.upstreamCommit &&
      previous.upstreamCommit !== current.upstreamCommit
    ) {
      return false;
    }

    // Detect pull: behind count decreased without new local commits
    if (previous.behind > current.behind && current.ahead <= previous.ahead) {
      return false;
    }

    if (await this.gitService.isAncestor(root, previous.headCommit, current.headCommit)) {
      return true;
    }

    return this.gitService.haveSameFirstParent(root, previous.headCommit, current.headCommit);
  }

  private shouldRunPushReview(
    previous: RepoSnapshot,
    current: RepoSnapshot,
    hintSet: ReadonlySet<ReviewHint>
  ): boolean {
    if (hintSet.has('push')) {
      return true;
    }

    return previous.ahead > 0 && current.ahead === 0 && previous.headCommit === current.headCommit;
  }

  private triggerMatches(trigger: AIReviewConfig['trigger'], target: 'commit' | 'push'): boolean {
    if (trigger === 'manual') {
      return false;
    }

    if (trigger === 'commitAndPush') {
      return true;
    }

    return trigger === target;
  }

  private async buildReviewContext(
    root: string,
    trigger: ReviewContext['trigger'],
    previous: RepoSnapshot,
    current: RepoSnapshot,
    config: AIReviewConfig,
    allowSkipKeywords: boolean
  ): Promise<ReviewContext | undefined> {
    if (!current.headCommit) {
      return undefined;
    }

    if (trigger === 'commit' && (await this.gitService.isRebaseInProgress(root))) {
      this.log(`Skipping commit review during rebase: ${root}`);
      return undefined;
    }

    let commitRange = current.headCommit;
    if (trigger === 'push') {
      if (previous.upstreamCommit && previous.upstreamCommit !== current.headCommit) {
        commitRange = `${previous.upstreamCommit}..${current.headCommit}`;
      }
    }

    if (
      allowSkipKeywords &&
      (await this.shouldSkipByCommitMessage(root, commitRange, config.skipCommitKeywords))
    ) {
      this.log(`Skipping review because a skip keyword matched: ${root}`);
      return undefined;
    }

    const changedLines = await this.gitService.countChangedLines(root, commitRange);
    const model = this.resolveModel(config, changedLines);
    const prompt = await this.reviewService.buildPrompt({
      root,
      trigger,
      commit: current.headCommit,
      commitRange,
      promptFile: config.promptFile
    });
    const reviewDirectory = resolvePath(root, config.reviewDirectory);
    const promptFilePath = resolvePath(root, config.promptFile);

    return {
      key: `${trigger}:${commitRange}:${model || 'default'}`,
      root,
      trigger,
      commit: current.headCommit,
      commitRange,
      changedLines,
      model,
      prompt,
      promptFilePath,
      provider: config.cli,
      cliArgs: this.resolveCliArgs(config),
      filePath: path.join(reviewDirectory, buildReviewFileName(trigger, current.headCommit)),
      keepReviewFileCount: config.keepReviewFileCount,
      startNotificationMode: config.startNotificationMode,
      completionNotificationMode: config.completionNotificationMode
    };
  }

  private async shouldSkipByCommitMessage(
    root: string,
    commitRange: string,
    keywords: string[]
  ): Promise<boolean> {
    if (!keywords.length) {
      return false;
    }

    const messages = await this.gitService.getCommitMessages(root, commitRange);
    return messages.some((message) => {
      const loweredMessage = message.toLowerCase();
      return keywords.some((keyword) => loweredMessage.includes(keyword.toLowerCase()));
    });
  }

  private resolveModel(config: AIReviewConfig, changedLines: number): string {
    if (config.smallChangeModel && changedLines < config.smallChangeLineThreshold) {
      return config.smallChangeModel;
    }

    return config.model;
  }

  private resolveCliArgs(config: AIReviewConfig): string[] {
    const argsMap: Record<CliProvider, string[]> = {
      claude: config.claudeArgs,
      codex: config.codexArgs,
      copilot: config.copilotArgs
    };

    return argsMap[config.cli] ?? [];
  }

  private enqueueReview(state: RepoState, reviewContext: ReviewContext): void {
    void this.reviewService.runReview(reviewContext).catch((error) => {
      this.logError(`Review execution failed for ${reviewContext.root}`, error);
    });
  }

  private async runManualReview(): Promise<void> {
    const repository = await this.pickRepository();
    if (!repository) {
      return;
    }

    const root = this.getRepositoryRoot(repository);
    if (!root) {
      return;
    }

    const resource = vscode.Uri.file(root);
    const config = getConfig(resource);
    if (!config.enabled) {
      vscode.window.showWarningMessage(vscode.l10n.t('AI Review is disabled for this repository.'));
      return;
    }

    const current = await this.gitService.captureSnapshot(root);
    if (!current.headCommit) {
      vscode.window.showWarningMessage(vscode.l10n.t('No commit was found at HEAD.'));
      return;
    }

    const reviewContext = await this.buildReviewContext(
      root,
      'manual',
      current,
      current,
      config,
      false
    );

    if (!reviewContext) {
      return;
    }

    const state = this.repoStates.get(root) ?? {
      repository,
      root,
      snapshot: current,
      eventChain: Promise.resolve(),
      reviewChain: Promise.resolve(),
      pendingHints: [],
      suppressReviewsUntil: 0,
      disposables: []
    };

    this.enqueueReview(state, reviewContext);
  }

  private async selectPromptFile(): Promise<void> {
    const workspaceFolder = getPreferredWorkspaceFolder();
    const defaultUri = workspaceFolder?.uri ?? vscode.Uri.file(path.resolve('.'));
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri,
      openLabel: vscode.l10n.t('Select Prompt File')
    });

    if (!selection || selection.length === 0) {
      return;
    }

    const value = toConfigPath(workspaceFolder, selection[0].fsPath);
    await updateResourceSetting(workspaceFolder?.uri, 'promptFile', value);
    vscode.window.showInformationMessage(vscode.l10n.t('Prompt file set to {0}', value));
  }

  private async selectReviewFolder(): Promise<void> {
    const workspaceFolder = getPreferredWorkspaceFolder();
    const defaultUri = workspaceFolder?.uri ?? vscode.Uri.file(path.resolve('.'));
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri,
      openLabel: vscode.l10n.t('Select Review Folder')
    });

    if (!selection || selection.length === 0) {
      return;
    }

    const value = toConfigPath(workspaceFolder, selection[0].fsPath);
    await updateResourceSetting(workspaceFolder?.uri, 'reviewDirectory', value);
    vscode.window.showInformationMessage(vscode.l10n.t('Review folder set to {0}', value));
  }

  private async pickRepository(): Promise<GitRepository | undefined> {
    if (!this.gitApi) {
      this.gitApi = await this.getGitApi();
    }

    if (!this.gitApi) {
      return undefined;
    }

    const repositories = this.gitApi.repositories;
    if (repositories.length === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t('No Git repository is open in this workspace.'));
      return undefined;
    }

    if (repositories.length === 1) {
      return repositories[0];
    }

    const items = repositories.map((repository) => {
      const root = this.getRepositoryRoot(repository);
      return {
        label: path.basename(root || vscode.l10n.t('repository')),
        description: root,
        repository
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Choose a repository for the review')
    });

    return picked?.repository;
  }

  private getRepositoryRoot(repository: GitRepository): string {
    return repository.rootUri?.fsPath ?? repository.root ?? '';
  }

  private getOperationKind(event: unknown): string {
    if (!event) {
      return '';
    }

    if (typeof event === 'string') {
      return event;
    }

    if (typeof event === 'object' && event !== null) {
      const maybeKind = event as { kind?: unknown; operation?: { kind?: unknown } };
      if (typeof maybeKind.kind === 'string') {
        return maybeKind.kind;
      }

      if (typeof maybeKind.operation?.kind === 'string') {
        return maybeKind.operation.kind;
      }
    }

    return '';
  }

  private shouldSuppressOperation(kind: string): boolean {
    const normalized = kind.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return (
      normalized.includes('checkout') ||
      normalized.includes('reset') ||
      normalized.includes('rebase') ||
      normalized.includes('pull') ||
      normalized.includes('merge') ||
      normalized.includes('fetch')
    );
  }

  private log(message: string): void {
    this.output.appendLine(`[info] ${message}`);
  }

  private syncDashboardRepositories(): void {
    this.reviewDashboardService.setRepositoryRoots(Array.from(this.repoStates.keys()));
  }

  private logError(message: string, error: unknown): void {
    this.output.appendLine(`[error] ${message}`);
    if (error instanceof Error) {
      this.output.appendLine(error.stack || error.message);
      return;
    }

    this.output.appendLine(String(error));
  }
}
