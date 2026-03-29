import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import { getConfig } from '../config';
import { getPreferredWorkspaceFolder, resolvePath } from '../utils';
import { CommandResult, ProcessHandle, ReviewRunRecord, ReviewRunStatus } from '../types';

interface DashboardWebviewState {
  repositories: DashboardRepositoryViewModel[];
  selectedRoot: string;
  activeRuns: DashboardRunViewModel[];
  historyRuns: DashboardRunViewModel[];
  selectedRunId: string | undefined;
  selectedPromptContent: string;
  selectedPromptFilePath: string;
  selectedPromptFileMissing: boolean;
  notice: string;
}

interface DashboardRunViewModel {
  id: string;
  root: string;
  trigger: ReviewRunRecord['trigger'];
  provider: ReviewRunRecord['provider'];
  commit: string;
  commitRange: string;
  reviewFilePath: string;
  promptFilePath: string;
  pid: number | undefined;
  status: ReviewRunStatus;
  startedAt: number;
  startedAtLabel: string;
}

interface DashboardRepositoryViewModel {
  root: string;
  label: string;
}

interface DashboardInitOptions {
  root: string;
  trigger: ReviewRunRecord['trigger'];
  provider: ReviewRunRecord['provider'];
  commit: string;
  commitRange: string;
  promptFilePath: string;
  reviewFilePath: string;
}

interface ActiveRun extends ReviewRunRecord {
  stopHandle: ProcessHandle | undefined;
  promptContent: string;
  promptMissing: boolean;
}

interface PromptTarget {
  promptFilePath: string;
  promptContent: string;
  promptMissing: boolean;
  scopeLabel: string;
}

export class ReviewDashboardService implements vscode.WebviewViewProvider {
  static readonly viewType = 'aiReview.dashboard';
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly historyRuns = new Map<string, ActiveRun>();
  private repositoryRoots: string[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private sidebarView: vscode.WebviewView | undefined;
  private selectedRunId: string | undefined;
  private selectedRoot = '';
  private notice = '';
  private readonly maxHistoryRuns = 12;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.sidebarView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
    webviewView.onDidDispose(() => {
      if (this.sidebarView === webviewView) {
        this.sidebarView = undefined;
      }
    });
    void this.renderWebview(webviewView.webview);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.sidebarView = undefined;
    this.activeRuns.clear();
    this.historyRuns.clear();
  }

  async openDashboard(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      void this.refreshWebview();
      return;
    }

    this.output.appendLine('[info] Opening AI Review Dashboard.');

    this.panel = vscode.window.createWebviewPanel(
      'aiReviewDashboard',
      vscode.l10n.t('AI Review Dashboard'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.options = { enableScripts: true };
    this.panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });

    await this.renderWebview(this.panel.webview);
    void this.refreshWebview();
  }

  setRepositoryRoots(roots: string[]): void {
    this.repositoryRoots = [...new Set(roots)].sort((left, right) => left.localeCompare(right));

    const selectedRun = this.getSelectedRun();
    if (selectedRun) {
      this.selectedRoot = selectedRun.root;
    }

    if (!this.selectedRoot || !this.repositoryRoots.includes(this.selectedRoot)) {
      this.selectedRoot = this.repositoryRoots[0] ?? '';
    }

    if (this.selectedRunId) {
      const run = this.getSelectedRun();
      if (!run || (this.selectedRoot && run.root !== this.selectedRoot)) {
        this.selectedRunId = this.pickFallbackSelectedRunId(this.selectedRoot);
      }
    }

    void this.refreshWebview();
  }

  registerRun(options: DashboardInitOptions): string {
    const id = randomUUID();
    this.activeRuns.set(id, {
      id,
      key: `${options.trigger}:${options.commitRange}:${options.provider}:${id}`,
      root: options.root,
      trigger: options.trigger,
      provider: options.provider,
      commit: options.commit,
      commitRange: options.commitRange,
      promptFilePath: options.promptFilePath,
      reviewFilePath: options.reviewFilePath,
      startedAt: Date.now(),
      status: 'starting',
      pid: undefined,
      requestedStop: false,
      stopHandle: undefined,
      promptContent: '',
      promptMissing: false
    });

    if (!this.selectedRunId) {
      this.selectedRunId = id;
    }
    this.selectedRoot = options.root;

    this.output.appendLine(
      `[info] Registered dashboard run ${id} for ${options.root}. Prompt file: ${options.promptFilePath}`
    );

    void this.refreshSelectedPromptIfNeeded(id).then(() => {
      if (this.selectedRunId === id) {
        void this.refreshWebview();
      }
    });
    void this.refreshWebview();
    return id;
  }

  attachProcess(runId: string, handle: ProcessHandle): void {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return;
    }

    run.pid = handle.pid;
    run.status = run.requestedStop ? 'stopping' : 'running';
    run.stopHandle = handle;
    void this.refreshWebview();

    if (run.requestedStop) {
      void handle.stop();
    }
  }

  async requestStop(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return;
    }

    run.requestedStop = true;
    run.status = 'stopping';
    this.notice = vscode.l10n.t('Stopping {0}...', path.basename(run.root));
    void this.refreshWebview();

    if (!run.stopHandle) {
      this.output.appendLine(`[info] Stop requested before process spawn for ${run.root}`);
      return;
    }

    await run.stopHandle.stop();
  }

  completeRun(runId: string, result: CommandResult): void {
    const run = this.activeRuns.get(runId);
    if (!run) {
      return;
    }

    if (result.cancelled) {
      run.status = 'cancelled';
      this.notice = vscode.l10n.t('Stopped {0}.', path.basename(run.root));
    } else if (result.ok) {
      run.status = 'completed';
      this.notice = vscode.l10n.t('Finished {0}.', path.basename(run.root));
    } else {
      run.status = 'failed';
      this.notice = vscode.l10n.t('Review failed for {0}.', path.basename(run.root));
    }

    this.activeRuns.delete(runId);
    this.historyRuns.set(runId, run);
    this.trimHistoryRuns();

    if (this.selectedRunId === runId) {
      this.selectedRunId = this.pickFallbackSelectedRunId();
    }

    void this.refreshWebview();
  }

  async selectRun(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId) ?? this.historyRuns.get(runId);
    if (!run) {
      return;
    }

    this.selectedRunId = runId;
    this.selectedRoot = run.root;
    await this.refreshSelectedPromptIfNeeded(runId);
    await this.refreshWebview();
  }

  async selectRoot(root: string): Promise<void> {
    if (!root || !this.repositoryRoots.includes(root)) {
      return;
    }

    this.selectedRoot = root;
    const selectedRun = this.getSelectedRun();
    if (selectedRun && selectedRun.root !== root) {
      this.selectedRunId = this.pickFallbackSelectedRunId(root);
    }

    await this.refreshWebview();
  }

  async saveSelectedPrompt(content: string): Promise<void> {
    const target = await this.getPromptTarget();
    if (!target) {
      return;
    }

    await fs.mkdir(path.dirname(target.promptFilePath), { recursive: true });
    await fs.writeFile(target.promptFilePath, content, 'utf8');

    const run = this.getSelectedRun();
    if (run) {
      run.promptContent = content;
      run.promptMissing = false;
    }

    this.output.appendLine(`[info] Saved prompt file from dashboard (${target.scopeLabel}): ${target.promptFilePath}`);
    this.notice = vscode.l10n.t('Saved prompt file: {0}', target.promptFilePath);
    await this.refreshWebview();
  }

  async openSelectedPromptInEditor(): Promise<void> {
    const target = await this.getPromptTarget();
    if (!target) {
      return;
    }

    this.output.appendLine(`[info] Opening prompt file in editor (${target.scopeLabel}): ${target.promptFilePath}`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.promptFilePath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async openSelectedReviewFile(runId?: string): Promise<void> {
    const run = runId
      ? this.activeRuns.get(runId) ?? this.historyRuns.get(runId)
      : this.getSelectedRun();
    if (!run) {
      return;
    }

    this.output.appendLine(`[info] Opening review file in editor: ${run.reviewFilePath}`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(run.reviewFilePath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private getSelectedRun(): ActiveRun | undefined {
    if (!this.selectedRunId) {
      return undefined;
    }

    return this.activeRuns.get(this.selectedRunId) ?? this.historyRuns.get(this.selectedRunId);
  }

  private pickFallbackSelectedRunId(root = this.selectedRoot): string | undefined {
    for (const run of this.activeRuns.values()) {
      if (!root || run.root === root) {
        return run.id;
      }
    }

    for (const run of this.historyRuns.values()) {
      if (!root || run.root === root) {
        return run.id;
      }
    }

    return undefined;
  }

  private trimHistoryRuns(): void {
    while (this.historyRuns.size > this.maxHistoryRuns) {
      const oldest = this.historyRuns.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }

      this.historyRuns.delete(oldest);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }

    const payload = message as {
      type?: unknown;
      runId?: unknown;
      content?: unknown;
      message?: unknown;
      source?: unknown;
      line?: unknown;
      column?: unknown;
    };
    if (typeof payload.type !== 'string') {
      return;
    }

    this.output.appendLine(
      `[info] Dashboard message received: ${payload.type}${typeof payload.runId === 'string' ? ` (${payload.runId})` : ''}`
    );

    if (payload.type === 'ready') {
      await this.refreshWebview();
      return;
    }

    if (payload.type === 'refresh') {
      if (this.selectedRunId) {
        await this.refreshSelectedPromptIfNeeded(this.selectedRunId, true);
      }

      await this.refreshWebview();
      return;
    }

    if (payload.type === 'selectRun' && typeof payload.runId === 'string') {
      await this.selectRun(payload.runId);
      return;
    }

    if (payload.type === 'selectRoot' && typeof payload.runId === 'string') {
      await this.selectRoot(payload.runId);
      return;
    }

    if (payload.type === 'stopRun' && typeof payload.runId === 'string') {
      await this.requestStop(payload.runId);
      return;
    }

    if (payload.type === 'savePrompt' && typeof payload.content === 'string') {
      await this.saveSelectedPrompt(payload.content);
      return;
    }

    if (payload.type === 'webviewError') {
      const message = typeof payload.message === 'string' ? payload.message : 'Unknown webview error';
      const source = typeof payload.source === 'string' ? payload.source : 'unknown source';
      const line = typeof payload.line === 'number' ? `:${payload.line}` : '';
      const column = typeof payload.column === 'number' ? `:${payload.column}` : '';
      this.output.appendLine(`[error] Webview error at ${source}${line}${column}: ${message}`);
      return;
    }

    if (payload.type === 'openPrompt') {
      await this.openSelectedPromptInEditor();
      return;
    }

    if (payload.type === 'openReviewFile') {
      await this.openSelectedReviewFile(typeof payload.runId === 'string' ? payload.runId : undefined);
    }
  }

  private async refreshSelectedPromptIfNeeded(runId: string, force = false): Promise<void> {
    const run = this.activeRuns.get(runId) ?? this.historyRuns.get(runId);
    if (!run) {
      return;
    }

    if (!force && run.promptContent) {
      return;
    }

    const loaded = await this.loadPromptFile(run.promptFilePath, `dashboard run ${runId}`);
    run.promptContent = loaded.content;
    run.promptMissing = loaded.missing;
  }

  private async getPromptTarget(): Promise<PromptTarget | undefined> {
    const run = this.getSelectedRun();
    if (run && (!this.selectedRoot || run.root === this.selectedRoot)) {
      await this.refreshSelectedPromptIfNeeded(run.id, true);
      return {
        promptFilePath: run.promptFilePath,
        promptContent: run.promptContent,
        promptMissing: run.promptMissing,
        scopeLabel: `run ${run.id}`
      };
    }

    const workspaceFolder = this.getSelectedWorkspaceFolder();
    if (!workspaceFolder) {
      this.output.appendLine('[warn] No workspace folder was found for dashboard prompt editing.');
      return undefined;
    }

    const config = getConfig(workspaceFolder.uri);
    const promptFilePath = resolvePath(workspaceFolder.uri.fsPath, config.promptFile);
    const loaded = await this.loadPromptFile(promptFilePath, `workspace ${workspaceFolder.uri.fsPath}`);

    return {
      promptFilePath,
      promptContent: loaded.content,
      promptMissing: loaded.missing,
      scopeLabel: `workspace ${workspaceFolder.uri.fsPath}`
    };
  }

  private getSelectedWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    if (this.selectedRoot) {
      const selectedFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.selectedRoot));
      if (selectedFolder) {
        return selectedFolder;
      }
    }

    return getPreferredWorkspaceFolder();
  }

  private async loadPromptFile(
    promptFilePath: string,
    scopeLabel: string
  ): Promise<{ content: string; missing: boolean }> {
    try {
      this.output.appendLine(`[info] Loading prompt file for ${scopeLabel}: ${promptFilePath}`);
      const content = await fs.readFile(promptFilePath, 'utf8');
      this.output.appendLine(`[info] Loaded prompt file for ${scopeLabel} (${content.length} chars).`);
      return { content, missing: false };
    } catch {
      this.output.appendLine(`[warn] Failed to read prompt file for ${scopeLabel}: ${promptFilePath}`);
      return { content: '', missing: true };
    }
  }

  private async renderWebview(webview: vscode.Webview): Promise<void> {
    webview.html = this.getHtml(webview, await this.getState());
  }

  private async refreshWebview(): Promise<void> {
    const state = await this.getState();
    const posts: Thenable<boolean>[] = [];

    if (this.panel) {
      posts.push(this.panel.webview.postMessage({ type: 'state', state }));
    }

    if (this.sidebarView) {
      posts.push(this.sidebarView.webview.postMessage({ type: 'state', state }));
    }

    await Promise.all(posts);
  }

  private async getState(): Promise<DashboardWebviewState> {
    const repositories = this.repositoryRoots.map((root) => ({
      root,
      label: path.basename(root) || root
    }));
    const selectedRoot = this.selectedRoot || repositories[0]?.root || '';

    const activeRuns = Array.from(this.activeRuns.values())
      .filter((run) => !selectedRoot || run.root === selectedRoot)
      .map((run) => ({
      id: run.id,
      root: run.root,
      trigger: run.trigger,
      provider: run.provider,
      commit: run.commit,
      commitRange: run.commitRange,
      reviewFilePath: run.reviewFilePath,
      promptFilePath: run.promptFilePath,
      pid: run.pid,
      status: run.status,
      startedAt: run.startedAt,
      startedAtLabel: new Date(run.startedAt).toLocaleString()
    }));

    const historyRuns = Array.from(this.historyRuns.values())
      .filter((run) => !selectedRoot || run.root === selectedRoot)
      .map((run) => ({
      id: run.id,
      root: run.root,
      trigger: run.trigger,
      provider: run.provider,
      commit: run.commit,
      commitRange: run.commitRange,
      reviewFilePath: run.reviewFilePath,
      promptFilePath: run.promptFilePath,
      pid: run.pid,
      status: run.status,
      startedAt: run.startedAt,
      startedAtLabel: new Date(run.startedAt).toLocaleString()
    }));

    const selectedRun = this.getSelectedRun();
    const effectiveSelectedRun =
      selectedRun && (!selectedRoot || selectedRun.root === selectedRoot) ? selectedRun : undefined;
    const promptTarget = effectiveSelectedRun
      ? {
          promptFilePath: effectiveSelectedRun.promptFilePath,
          promptContent: effectiveSelectedRun.promptContent,
          promptMissing: effectiveSelectedRun.promptMissing
        }
      : await this.getPromptTarget();

    return {
      repositories,
      selectedRoot,
      activeRuns,
      historyRuns,
      selectedRunId: effectiveSelectedRun?.id,
      selectedPromptContent: promptTarget?.promptContent ?? '',
      selectedPromptFilePath: promptTarget?.promptFilePath ?? '',
      selectedPromptFileMissing: promptTarget?.promptMissing ?? false,
      notice: this.notice
    };
  }

  private getSnapshotState(): DashboardWebviewState {
    const repositories = this.repositoryRoots.map((root) => ({
      root,
      label: path.basename(root) || root
    }));
    const selectedRoot = this.selectedRoot || repositories[0]?.root || '';
    const activeRuns = Array.from(this.activeRuns.values()).map((run) => ({
      id: run.id,
      root: run.root,
      trigger: run.trigger,
      provider: run.provider,
      commit: run.commit,
      commitRange: run.commitRange,
      reviewFilePath: run.reviewFilePath,
      promptFilePath: run.promptFilePath,
      pid: run.pid,
      status: run.status,
      startedAt: run.startedAt,
      startedAtLabel: new Date(run.startedAt).toLocaleString()
    }));

    const historyRuns = Array.from(this.historyRuns.values()).map((run) => ({
      id: run.id,
      root: run.root,
      trigger: run.trigger,
      provider: run.provider,
      commit: run.commit,
      commitRange: run.commitRange,
      reviewFilePath: run.reviewFilePath,
      promptFilePath: run.promptFilePath,
      pid: run.pid,
      status: run.status,
      startedAt: run.startedAt,
      startedAtLabel: new Date(run.startedAt).toLocaleString()
    }));

    const selectedRun = this.getSelectedRun();
    return {
      repositories,
      selectedRoot,
      activeRuns: activeRuns.filter((run) => !selectedRoot || run.root === selectedRoot),
      historyRuns: historyRuns.filter((run) => !selectedRoot || run.root === selectedRoot),
      selectedRunId: selectedRun?.root === selectedRoot ? selectedRun.id : undefined,
      selectedPromptContent: selectedRun?.promptContent ?? '',
      selectedPromptFilePath: selectedRun?.promptFilePath ?? '',
      selectedPromptFileMissing: selectedRun?.promptMissing ?? false,
      notice: this.notice
    };
  }

  private getHtml(webview: vscode.Webview, initialStateValue: DashboardWebviewState): string {
    const nonce = this.getNonce();
    const initialState = JSON.stringify(initialStateValue).replace(/</g, '\\u003c');

    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${vscode.l10n.t('AI Review Dashboard')}</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #111827;
      --panel-2: #1f2937;
      --border: rgba(148, 163, 184, 0.25);
      --text: #e5e7eb;
      --muted: #94a3b8;
      --accent: #22c55e;
      --accent-2: #38bdf8;
      --danger: #f87171;
      --warn: #fbbf24;
      --shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
      --radius: 18px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(56, 189, 248, 0.18), transparent 35%),
        radial-gradient(circle at top right, rgba(34, 197, 94, 0.15), transparent 30%),
        linear-gradient(180deg, #020617 0%, var(--bg) 100%);
      min-height: 100vh;
    }

    .shell {
      display: grid;
      grid-template-rows: auto auto;
      align-content: start;
      min-height: 100vh;
      padding: 24px;
      gap: 18px;
    }

    .hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 22px 24px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: rgba(15, 23, 42, 0.78);
      backdrop-filter: blur(14px);
      box-shadow: var(--shadow);
    }

    .hero h1 {
      margin: 0;
      font-size: 22px;
      letter-spacing: -0.02em;
    }

    .hero p {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 13px;
    }

    .hero-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }

    .hero-select {
      display: grid;
      gap: 4px;
      min-width: 240px;
    }

    .hero-select label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .button {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--panel-2);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      font-weight: 600;
    }

    .button:hover {
      transform: translateY(-1px);
      border-color: rgba(56, 189, 248, 0.45);
      background: #273244;
    }

    .button.primary {
      background: linear-gradient(135deg, #22c55e, #38bdf8);
      color: #04111a;
      border-color: transparent;
    }

    .button.danger {
      background: rgba(248, 113, 113, 0.16);
      border-color: rgba(248, 113, 113, 0.35);
      color: #fecaca;
    }

    .grid {
      display: grid;
      grid-template-columns: 360px minmax(0, 1fr);
      gap: 18px;
      min-height: 0;
      align-items: start;
      align-content: start;
    }

    .left-stack {
      display: grid;
      align-content: start;
      gap: 18px;
      min-height: 0;
      align-self: start;
    }

    .panel {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: rgba(15, 23, 42, 0.72);
      backdrop-filter: blur(14px);
      box-shadow: var(--shadow);
      min-height: 0;
      overflow: hidden;
      align-self: start;
    }

    .panel-header {
      padding: 18px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }

    .panel-header h2 {
      margin: 0;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }

    .panel-body {
      padding: 18px 20px;
      overflow: auto;
      max-height: calc(100vh - 220px);
    }

    .run-list {
      display: grid;
      gap: 12px;
    }

    .run-card {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      background: rgba(17, 24, 39, 0.92);
      transition: border-color 120ms ease, transform 120ms ease;
      color: var(--text);
    }

    .run-card:hover {
      transform: translateY(-1px);
      border-color: rgba(56, 189, 248, 0.45);
    }

    .run-card.selected {
      border-color: rgba(56, 189, 248, 0.8);
      box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.25) inset;
    }

    .run-summary {
      display: grid;
      gap: 10px;
    }

    .run-toggle {
      width: 100%;
      padding: 0;
      background: transparent;
      border: 0;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    .run-toggle:focus-visible {
      outline: 2px solid rgba(56, 189, 248, 0.85);
      outline-offset: 4px;
      border-radius: 12px;
    }

    .run-top {
      display: flex;
      justify-content: flex-start;
      gap: 10px;
      align-items: flex-start;
    }

    .run-heading {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      flex: 1;
    }

    .run-title {
      font-weight: 700;
      font-size: 14px;
      margin: 0;
      color: var(--text);
    }

    .run-meta,
    .run-subtle {
      font-size: 12px;
      color: var(--muted);
      word-break: break-word;
    }

    .run-primary {
      font-size: 18px;
      line-height: 1;
      color: var(--text);
      min-width: 18px;
      text-align: left;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .badge.running { background: rgba(34, 197, 94, 0.16); color: #86efac; }
    .badge.starting { background: rgba(56, 189, 248, 0.16); color: #7dd3fc; }
    .badge.stopping { background: rgba(251, 191, 36, 0.18); color: #fde68a; }
    .badge.completed { background: rgba(34, 197, 94, 0.16); color: #86efac; }
    .badge.failed { background: rgba(248, 113, 113, 0.16); color: #fecaca; }
    .badge.cancelled { background: rgba(248, 113, 113, 0.16); color: #fecaca; }

    .run-expanded {
      display: grid;
      gap: 16px;
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid rgba(148, 163, 184, 0.18);
    }

    .run-detail-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .field {
      display: grid;
      gap: 6px;
    }

    .field label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .field .value {
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
    }

    .field.full {
      grid-column: 1 / -1;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    .section-title {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .editor-wrap {
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 12px;
      min-height: 0;
    }

    .editor {
      width: 100%;
      min-height: 320px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: rgba(2, 6, 23, 0.9);
      color: var(--text);
      padding: 16px;
      font-family: 'Cascadia Mono', 'SFMono-Regular', Consolas, monospace;
      font-size: 13px;
      line-height: 1.6;
      outline: none;
    }

    .editor:focus {
      border-color: rgba(56, 189, 248, 0.75);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
    }

    .empty {
      border: 1px dashed rgba(148, 163, 184, 0.35);
      border-radius: 16px;
      padding: 20px;
      color: var(--muted);
      text-align: center;
      line-height: 1.6;
      background: rgba(15, 23, 42, 0.46);
    }

    .notice {
      color: var(--warn);
      font-size: 13px;
      line-height: 1.6;
    }

    @media (max-width: 1080px) {
      .shell {
        min-height: auto;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      .panel-body {
        max-height: none;
        overflow: visible;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <div>
        <h1>${vscode.l10n.t('AI Review Dashboard')}</h1>
      </div>
      <div class="hero-actions">
        <div class="hero-select">
          <label for="rootSelect">${vscode.l10n.t('Repository')}</label>
          <select class="editor select" id="rootSelect" style="min-height:auto; resize:none; padding:10px 12px;"></select>
        </div>
        <button class="button" id="refreshButton">${vscode.l10n.t('Refresh')}</button>
      </div>
    </header>

    <main class="grid">
      <div class="left-stack">
        <section class="panel">
          <div class="panel-header">
            <h2>${vscode.l10n.t('Active Runs')}</h2>
            <span class="run-subtle" id="runCount"></span>
          </div>
          <div class="panel-body">
            <div class="run-list" id="activeRunList"></div>
            <div class="empty" id="activeEmptyState" hidden>
              ${vscode.l10n.t('No reviews are currently running for this repository.')}<br>
              ${vscode.l10n.t('When a review starts after a commit or push, you can stop it here.')}
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>${vscode.l10n.t('Recent History')}</h2>
            <span class="run-subtle" id="historyCount"></span>
          </div>
          <div class="panel-body">
            <div class="run-list" id="historyRunList"></div>
            <div class="empty" id="historyEmptyState" hidden>
              ${vscode.l10n.t('No recent reviews are available for this repository.')}
            </div>
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-header">
          <h2>${vscode.l10n.t('Prompt Workspace')}</h2>
          <span class="run-subtle" id="repositoryCount"></span>
        </div>
        <div class="panel-body editor-wrap">
          <div class="notice" id="notice"></div>
          <div class="toolbar">
            <button class="button primary" id="savePromptButton">${vscode.l10n.t('Save Prompt')}</button>
            <button class="button" id="openPromptButton">${vscode.l10n.t('Open in Editor')}</button>
          </div>
          <div class="field full">
            <label for="promptEditor">${vscode.l10n.t('Prompt File')}</label>
            <div class="run-subtle" id="promptPath"></div>
          </div>
          <textarea class="editor" id="promptEditor" spellcheck="false" placeholder="${vscode.l10n.t('Edit the prompt file for the selected repository.')}"></textarea>
        </div>
      </section>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const __i18n = {
      starting: ${JSON.stringify(vscode.l10n.t('starting'))},
      running: ${JSON.stringify(vscode.l10n.t('running'))},
      stopping: ${JSON.stringify(vscode.l10n.t('stopping'))},
      cancelled: ${JSON.stringify(vscode.l10n.t('cancelled'))},
      completed: ${JSON.stringify(vscode.l10n.t('completed'))},
      failed: ${JSON.stringify(vscode.l10n.t('failed'))},
      repositories: ${JSON.stringify(vscode.l10n.t('{0} repositories'))},
      running_count: ${JSON.stringify(vscode.l10n.t('{0} running'))},
      recent_count: ${JSON.stringify(vscode.l10n.t('{0} recent'))},
      na: ${JSON.stringify(vscode.l10n.t('n/a'))},
      pending: ${JSON.stringify(vscode.l10n.t('pending'))},
      stop: ${JSON.stringify(vscode.l10n.t('Stop'))},
      openReviewFile: ${JSON.stringify(vscode.l10n.t('Open Review File'))},
      repository: ${JSON.stringify(vscode.l10n.t('Repository'))},
      pid: ${JSON.stringify(vscode.l10n.t('PID'))},
      commitId: ${JSON.stringify(vscode.l10n.t('Commit ID'))},
      started: ${JSON.stringify(vscode.l10n.t('Started'))},
      commitRange: ${JSON.stringify(vscode.l10n.t('Commit Range'))},
      reviewFile: ${JSON.stringify(vscode.l10n.t('Review File'))},
      promptFile: ${JSON.stringify(vscode.l10n.t('Prompt File'))},
      missingFile: ${JSON.stringify(vscode.l10n.t('{0} (missing file, it will be created when you save)'))},
    };
    const initialState = ${initialState};
    let state = initialState;
    let selectedRunId = initialState.selectedRunId;
    const expandedRunIds = new Set();

    const activeRunList = document.getElementById('activeRunList');
    const activeEmptyState = document.getElementById('activeEmptyState');
    const historyRunList = document.getElementById('historyRunList');
    const historyEmptyState = document.getElementById('historyEmptyState');
    const runCount = document.getElementById('runCount');
    const historyCount = document.getElementById('historyCount');
    const repositoryCount = document.getElementById('repositoryCount');
    const rootSelect = document.getElementById('rootSelect');
    const notice = document.getElementById('notice');
    const promptEditor = document.getElementById('promptEditor');
    const promptPath = document.getElementById('promptPath');
    const refreshButton = document.getElementById('refreshButton');
    const savePromptButton = document.getElementById('savePromptButton');
    const openPromptButton = document.getElementById('openPromptButton');

    function statusLabel(status) {
      return __i18n[status] || status;
    }

    function canStopRun(status) {
      return status === 'starting' || status === 'running' || status === 'stopping';
    }

    function shortCommit(value) {
      return value ? String(value).slice(0, 8) : __i18n.na;
    }

    function toggleRun(runId) {
      if (expandedRunIds.has(runId)) {
        expandedRunIds.delete(runId);
      } else {
        expandedRunIds.add(runId);
        selectedRunId = runId;
        vscode.postMessage({ type: 'selectRun', runId });
      }

      renderRunList();
    }

    function createRunCard(run, includeStopAction) {
      const card = document.createElement('article');
      card.className = 'run-card' + (run.id === selectedRunId ? ' selected' : '');

      const expanded = expandedRunIds.has(run.id);
      const toggleButton = document.createElement('button');
      toggleButton.type = 'button';
      toggleButton.className = 'run-toggle';
      toggleButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggleButton.innerHTML = [
        '<div class="run-summary">',
        '  <div class="run-top">',
        '    <div class="run-primary">' + (expanded ? '&minus;' : '+') + '</div>',
        '    <div class="run-heading">',
        '      <div>',
        '        <div class="run-title">' + escapeHtml(run.provider) + ' / ' + escapeHtml(run.trigger) + '</div>',
        '        <div class="run-meta">' + escapeHtml(run.startedAtLabel) + ' / ' + escapeHtml(shortCommit(run.commit)) + '</div>',
        '      </div>',
        '      <span class="badge ' + escapeHtml(run.status) + '">' + escapeHtml(statusLabel(run.status)) + '</span>',
        '    </div>',
        '  </div>',
        '</div>'
      ].join('\\n');
      toggleButton.addEventListener('click', () => toggleRun(run.id));
      card.appendChild(toggleButton);

      if (!expanded) {
        return card;
      }

      const expandedSection = document.createElement('div');
      expandedSection.className = 'run-expanded';
      expandedSection.innerHTML = [
        '<div class="run-detail-grid">',
        '  <div class="field">',
        '    <label>' + escapeHtml(__i18n.repository) + '</label>',
        '    <div class="value">' + escapeHtml(run.root) + '</div>',
        '  </div>',
        '  <div class="field">',
        '    <label>' + escapeHtml(__i18n.pid) + '</label>',
        '    <div class="value">' + escapeHtml(run.pid ?? (includeStopAction ? __i18n.pending : __i18n.na)) + '</div>',
        '  </div>',
        '  <div class="field full">',
        '    <label>' + escapeHtml(__i18n.commitId) + '</label>',
        '    <div class="value">' + escapeHtml(run.commit || __i18n.na) + '</div>',
        '  </div>',
        '  <div class="field full">',
        '    <label>' + escapeHtml(__i18n.started) + '</label>',
        '    <div class="value">' + escapeHtml(run.startedAtLabel) + '</div>',
        '  </div>',
        '  <div class="field full">',
        '    <label>' + escapeHtml(__i18n.commitRange) + '</label>',
        '    <div class="value">' + escapeHtml(run.commitRange) + '</div>',
        '  </div>',
        '  <div class="field full">',
        '    <label>' + escapeHtml(__i18n.reviewFile) + '</label>',
        '    <div class="value">' + escapeHtml(run.reviewFilePath) + '</div>',
        '  </div>',
        '  <div class="field full">',
        '    <label>' + escapeHtml(__i18n.promptFile) + '</label>',
        '    <div class="value">' + escapeHtml(run.promptFilePath) + '</div>',
        '  </div>',
        '</div>'
      ].join('\\n');

      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar';

      if (includeStopAction && canStopRun(run.status)) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'button danger';
        stop.textContent = __i18n.stop;
        stop.addEventListener('click', (event) => {
          event.stopPropagation();
          selectedRunId = run.id;
          vscode.postMessage({ type: 'stopRun', runId: run.id });
        });
        toolbar.appendChild(stop);
      }

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'button';
      open.textContent = __i18n.openReviewFile;
      open.addEventListener('click', (event) => {
        event.stopPropagation();
        selectedRunId = run.id;
        vscode.postMessage({ type: 'openReviewFile', runId: run.id });
      });
      toolbar.appendChild(open);

      expandedSection.appendChild(toolbar);
      card.appendChild(expandedSection);
      return card;
    }

    function renderRunList() {
      activeRunList.innerHTML = '';
      historyRunList.innerHTML = '';
      repositoryCount.textContent = __i18n.repositories.replace('{0}', state.repositories.length);
      runCount.textContent = __i18n.running_count.replace('{0}', state.activeRuns.length);
      historyCount.textContent = __i18n.recent_count.replace('{0}', state.historyRuns.length);
      activeEmptyState.hidden = state.activeRuns.length > 0;
      historyEmptyState.hidden = state.historyRuns.length > 0;

      for (const run of state.activeRuns) {
        activeRunList.appendChild(createRunCard(run, true));
      }

      for (const run of state.historyRuns) {
        historyRunList.appendChild(createRunCard(run, false));
      }
    }

    function renderRepositorySelector() {
      rootSelect.innerHTML = '';
      for (const repo of state.repositories) {
        const option = document.createElement('option');
        option.value = repo.root;
        option.textContent = repo.label + ' - ' + repo.root;
        option.selected = repo.root === state.selectedRoot;
        rootSelect.appendChild(option);
      }

      rootSelect.disabled = state.repositories.length === 0;
    }

    function renderPromptWorkspace() {
      promptEditor.disabled = false;
      promptEditor.value = state.selectedPromptContent || '';
      promptPath.textContent = state.selectedPromptFileMissing
        ? __i18n.missingFile.replace('{0}', state.selectedPromptFilePath)
        : state.selectedPromptFilePath;
      savePromptButton.disabled = !state.selectedPromptFilePath;
      openPromptButton.disabled = !state.selectedPromptFilePath;
    }

    function renderNotice() {
      notice.textContent = state.notice || '';
      notice.style.display = state.notice ? 'block' : 'none';
    }

    function render() {
      renderRepositorySelector();
      renderRunList();
      renderPromptWorkspace();
      renderNotice();
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    refreshButton.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    rootSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectRoot', runId: rootSelect.value }));
    savePromptButton.addEventListener('click', () => vscode.postMessage({ type: 'savePrompt', content: promptEditor.value }));
    openPromptButton.addEventListener('click', () => vscode.postMessage({ type: 'openPrompt' }));

    promptEditor.addEventListener('input', () => {
      state.selectedPromptContent = promptEditor.value;
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'state') {
        return;
      }

      state = message.state;
      const visibleRunIds = new Set(state.activeRuns.concat(state.historyRuns).map((run) => run.id));
      for (const runId of Array.from(expandedRunIds)) {
        if (!visibleRunIds.has(runId)) {
          expandedRunIds.delete(runId);
        }
      }
      selectedRunId = state.selectedRunId;
      render();
    });

    window.addEventListener('error', (event) => {
      vscode.postMessage({
        type: 'webviewError',
        message: event.message,
        source: event.filename,
        line: event.lineno,
        column: event.colno
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      vscode.postMessage({
        type: 'webviewError',
        message: reason && reason.message ? reason.message : String(reason),
        source: 'unhandledrejection'
      });
    });

    vscode.postMessage({ type: 'ready' });
    render();
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }
}

