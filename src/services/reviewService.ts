import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import { getDefaultPrompt, REVIEW_FILE_PREFIX } from '../constants';
import { CommandResult, ProcessHandle, PromptBuildOptions, ReviewContext } from '../types';
import { resolvePath } from '../utils';
import { ReviewDashboardService } from './reviewDashboardService';
import { NotificationService } from './notificationService';
import { ProcessService } from './processService';

type CliBuilder = (prompt: string, model: string, extraArgs: string[]) => {
  command: string;
  args: string[];
  input?: string;
  shell?: boolean;
};

const CLI_BUILDERS: Record<ReviewContext['provider'], CliBuilder> = {
  claude(prompt, model, extraArgs) {
    const args: string[] = [...extraArgs];
    if (model) {
      args.push('--model', model);
    }
    args.push('--permission-mode', 'dontAsk', '-p', prompt);
    return { command: 'claude', args };
  },
  codex(prompt, model, extraArgs) {
    const args = ['-a', 'never', ...extraArgs, 'exec'];
    if (model) {
      args.push('--model', model);
    }
    args.push('-');
    return { command: 'codex', args, input: prompt };
  },
  copilot(prompt, model, extraArgs) {
    const args: string[] = [...extraArgs];
    if (model) {
      args.push('--model', model);
    }
    args.push('-p', prompt, '--no-ask-user');
    return { command: 'copilot', args };
  }
};

export class ReviewService {
  private static readonly REVIEW_RESULT_SPACER_LINES = 32;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly notificationService: NotificationService,
    private readonly processService: ProcessService,
    private readonly reviewDashboardService: ReviewDashboardService
  ) {}

  async buildPrompt(options: PromptBuildOptions): Promise<string> {
    const resolvedPromptFile = resolvePath(options.root, options.promptFile);
    let template = getDefaultPrompt(vscode.env.language);

    this.output.appendLine(`[info] Building prompt from: ${resolvedPromptFile}`);

    try {
      template = await fs.readFile(resolvedPromptFile, 'utf8');
      this.output.appendLine(`[info] Loaded custom prompt template: ${resolvedPromptFile}`);
    } catch {
      this.output.appendLine(`[info] Prompt file not found, using default prompt: ${resolvedPromptFile}`);
    }

    const replacements: Record<string, string> = {
      '$commit$': options.commit,
      '$commit_range$': options.commitRange,
      '$trigger$': options.trigger,
      '$repo$': options.root
    };

    let prompt = template;
    for (const [token, value] of Object.entries(replacements)) {
      prompt = prompt.split(token).join(value);
    }

    return prompt;
  }

  async runReview(reviewContext: ReviewContext): Promise<void> {
    await fs.mkdir(path.dirname(reviewContext.filePath), { recursive: true });
    await fs.writeFile(reviewContext.filePath, this.buildReviewHeader(reviewContext), 'utf8');

    this.output.appendLine(
      `[info] Starting ${reviewContext.provider} review for ${reviewContext.commitRange} in ${reviewContext.root}`
    );

    let activeProcess: ProcessHandle | undefined;
    let stopRequested = false;
    const dashboardRunId = this.reviewDashboardService.registerRun({
      root: reviewContext.root,
      trigger: reviewContext.trigger,
      provider: reviewContext.provider,
      commit: reviewContext.commit,
      commitRange: reviewContext.commitRange,
      promptFilePath: reviewContext.promptFilePath,
      reviewFilePath: reviewContext.filePath
    });

    const builder = CLI_BUILDERS[reviewContext.provider];
    const result = await this.notificationService.runWithStartNotification(
      reviewContext.startNotificationMode,
      vscode.l10n.t('AI review running: {0} ({1})', path.basename(reviewContext.root), reviewContext.trigger),
      async () => {
        const invocation = builder(reviewContext.prompt, reviewContext.model, reviewContext.cliArgs);
        const promptPreview = this.createPromptPreview(reviewContext.prompt);
        this.output.appendLine(
          `[info] CLI invocation: ${invocation.command} ${invocation.args.map((arg) => JSON.stringify(arg)).join(' ')}`
        );
        this.output.appendLine(
          `[info] Prompt delivery: ${invocation.input !== undefined ? 'stdin' : 'argument'} (${reviewContext.prompt.length} chars)`
        );
        this.output.appendLine(`[info] Prompt preview: ${promptPreview}`);

        return this.processService.run(invocation.command, invocation.args, reviewContext.root, {
          stdin: invocation.input !== undefined ? 'pipe' : 'ignore',
          input: invocation.input,
          shell: invocation.shell,
          onSpawn: async (handle) => {
            activeProcess = handle;
            this.reviewDashboardService.attachProcess(dashboardRunId, handle);
            await this.appendAgentPidHint(reviewContext.filePath, handle.pid);
            this.output.appendLine(
              `[info] Review process started for ${reviewContext.root} with PID ${handle.pid}. Stop with: kill -9 -- -${handle.pid}`
            );

            if (stopRequested) {
              await handle.stop();
            }
          }
        });
      },
      {
        stopLabel: vscode.l10n.t('Stop'),
        onStop: async () => {
          stopRequested = true;

          if (!activeProcess) {
            this.output.appendLine('[info] Stop requested before the review process started.');
            await this.reviewDashboardService.requestStop(dashboardRunId);
            return;
          }

          this.output.appendLine(`[info] Stopping review process PID ${activeProcess.pid}...`);
          await this.reviewDashboardService.requestStop(dashboardRunId);
          this.output.appendLine(`[info] Review process PID ${activeProcess.pid} stop requested.`);
        }
      }
    );

    this.reviewDashboardService.completeRun(dashboardRunId, result);

    await fs.appendFile(reviewContext.filePath, this.formatProcessResult(result), 'utf8');
    await this.cleanupOldReviewFiles(path.dirname(reviewContext.filePath), reviewContext.keepReviewFileCount);
    await this.openReviewFile(reviewContext.filePath);

    if (result.cancelled) {
      await this.notificationService.showCompletion(
        reviewContext.completionNotificationMode,
        vscode.l10n.t('AI review was stopped for {0} ({1}).', path.basename(reviewContext.root), reviewContext.trigger),
        'warning'
      );
      return;
    }

    if (result.ok) {
      await this.notificationService.showCompletion(
        reviewContext.completionNotificationMode,
        vscode.l10n.t('AI review finished for {0} ({1}).', path.basename(reviewContext.root), reviewContext.trigger),
        'info'
      );
      return;
    }

    const commandName = CLI_BUILDERS[reviewContext.provider]('', '', []).command;
    const isCommandNotFound =
      (result.exitCode === -1 && /ENOENT/i.test(result.stderr)) ||
      (!result.ok && !result.stdout.trim() && result.stderr.includes(`'${commandName}'`));

    if (isCommandNotFound) {
      this.output.appendLine(`[error] '${reviewContext.provider}' CLI is not installed or not found in PATH.`);
      this.output.appendLine(`[error] stderr: ${result.stderr}`);
      await vscode.window.showErrorMessage(
        vscode.l10n.t("'{0}' CLI is not installed or not found in PATH. Please install it and try again.", reviewContext.provider)
      );
      return;
    }

    this.output.appendLine(`[warn] Review process exited with code ${result.exitCode}. stderr: ${result.stderr}`);
    await this.notificationService.showCompletion(
      reviewContext.completionNotificationMode,
      vscode.l10n.t('AI review finished with issues for {0}.', path.basename(reviewContext.root)),
      'warning'
    );
  }

  private async openReviewFile(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  }

  private async cleanupOldReviewFiles(directory: string, keepCount: number): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const reviewFiles = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(REVIEW_FILE_PREFIX) && entry.name.endsWith('.md'))
        .map(async (entry) => {
          const filePath = path.join(directory, entry.name);
          const stat = await fs.stat(filePath);
          return { filePath, mtimeMs: stat.mtimeMs };
        })
    );

    reviewFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const filesToDelete = reviewFiles.slice(keepCount);

    await Promise.all(filesToDelete.map((file) => fs.rm(file.filePath, { force: true })));
  }

  private buildReviewHeader(reviewContext: ReviewContext): string {
    return [
      '<!-- AI Review -->',
      `<!-- Started: ${new Date().toISOString()} -->`,
      `<!-- Trigger: ${reviewContext.trigger} -->`,
      `<!-- CLI: ${reviewContext.provider} -->`,
      `<!-- Model: ${reviewContext.model || 'default'} -->`,
      `<!-- Commit: ${reviewContext.commit} -->`,
      `<!-- Commit Range: ${reviewContext.commitRange} -->`,
      `<!-- Changed Lines: ${reviewContext.changedLines} -->`,
      '',
    ].join('\n');
  }

  private async appendAgentPidHint(filePath: string, pid: number): Promise<void> {
    const lines = [
      '',
      `<!-- Agent PID: ${pid} -->`,
      `<!-- stop agent (linux/unix): \`kill -9 -- -${pid}\` -->`,
      `<!-- stop agent (windows): \`taskkill /PID ${pid} /T /F\` -->`,
      ''
    ];

    await fs.appendFile(filePath, `\n${lines.join('\n')}`, 'utf8');
  }

  private formatProcessResult(result: CommandResult): string {
    const sections: string[] = [];
    const trimmedStdout = result.stdout.trim();
    const trimmedStderr = result.stderr.trim();

    sections.push('## Process Output');
    sections.push('');

    if (trimmedStdout) {
      sections.push('### STDOUT');
      sections.push('');
      sections.push(trimmedStdout);
    }

    if (trimmedStderr) {
      sections.push('');
      sections.push('### STDERR');
      sections.push('');
      sections.push(trimmedStderr);
    }

    if (result.cancelled) {
      sections.push('');
      sections.push('## Review stopped by user');
      sections.push('');
      sections.push('The review process was stopped before completion.');
    }

    sections.push('');
    sections.push(`<!-- Exit Code: ${result.exitCode} -->`);
    sections.push(...Array.from({ length: ReviewService.REVIEW_RESULT_SPACER_LINES }, () => ''));
    sections.push('# Final Review Result');
    sections.push('');

    if (trimmedStdout) {
      sections.push(trimmedStdout);
    } else if (result.cancelled) {
      sections.push('No final review result was produced because the process was stopped.');
    } else {
      sections.push('No final review result was produced.');
    }

    return `\n${sections.join('\n')}\n`;
  }

  private createPromptPreview(prompt: string): string {
    const normalized = prompt.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '(empty prompt)';
    }

    return normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized;
  }
}
