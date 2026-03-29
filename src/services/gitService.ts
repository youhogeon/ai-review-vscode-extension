import * as fs from 'fs/promises';
import * as path from 'path';

import { CommandResult, RepoSnapshot } from '../types';
import { ProcessService } from './processService';

export class GitService {
  constructor(private readonly processService: ProcessService) {}

  async captureSnapshot(root: string): Promise<RepoSnapshot> {
    const headCommitResult = await this.execGit(root, ['rev-parse', 'HEAD'], true);
    const headNameResult = await this.execGit(root, ['symbolic-ref', '--short', 'HEAD'], true);
    const upstreamNameResult = await this.execGit(
      root,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      true
    );
    const upstreamCommitResult = await this.execGit(root, ['rev-parse', '@{upstream}'], true);

    let ahead = 0;
    let behind = 0;
    if (upstreamNameResult.exitCode === 0) {
      const countsResult = await this.execGit(
        root,
        ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
        true
      );

      if (countsResult.exitCode === 0) {
        const values = countsResult.stdout.trim().split(/\s+/);
        ahead = Number(values[0]) || 0;
        behind = Number(values[1]) || 0;
      }
    }

    return {
      headCommit: headCommitResult.exitCode === 0 ? headCommitResult.stdout.trim() : '',
      headName: headNameResult.exitCode === 0 ? headNameResult.stdout.trim() : '',
      upstreamName: upstreamNameResult.exitCode === 0 ? upstreamNameResult.stdout.trim() : '',
      upstreamCommit: upstreamCommitResult.exitCode === 0 ? upstreamCommitResult.stdout.trim() : '',
      ahead,
      behind
    };
  }

  async isRebaseInProgress(root: string): Promise<boolean> {
    const gitDirResult = await this.execGit(root, ['rev-parse', '--git-dir'], true);
    if (gitDirResult.exitCode !== 0) {
      return false;
    }

    const gitDir = gitDirResult.stdout.trim();
    const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(root, gitDir);
    const hasRebaseMerge = await this.pathExists(path.join(absoluteGitDir, 'rebase-merge'));
    const hasRebaseApply = await this.pathExists(path.join(absoluteGitDir, 'rebase-apply'));
    return hasRebaseMerge || hasRebaseApply;
  }

  async getCommitMessages(root: string, commitRange: string): Promise<string[]> {
    const args = commitRange.includes('..')
      ? ['log', '--format=%B%x1e', commitRange]
      : ['log', '-1', '--format=%B', commitRange];

    const result = await this.execGit(root, args, true);
    if (result.exitCode !== 0) {
      return [];
    }

    if (commitRange.includes('..')) {
      return result.stdout
        .split('\x1e')
        .map((message) => message.trim())
        .filter(Boolean);
    }

    return result.stdout.trim() ? [result.stdout.trim()] : [];
  }

  async countChangedLines(root: string, commitRange: string): Promise<number> {
    const args = commitRange.includes('..')
      ? ['diff', '--numstat', commitRange]
      : ['show', '--numstat', '--format=', commitRange];

    const result = await this.execGit(root, args, true);
    if (result.exitCode !== 0) {
      return 0;
    }

    let total = 0;
    for (const line of result.stdout.split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts.length < 2) {
        continue;
      }

      const added = Number(parts[0]);
      const deleted = Number(parts[1]);

      if (!Number.isNaN(added)) {
        total += added;
      }

      if (!Number.isNaN(deleted)) {
        total += deleted;
      }
    }

    return total;
  }

  async isAncestor(root: string, ancestorCommit: string, descendantCommit: string): Promise<boolean> {
    if (!ancestorCommit || !descendantCommit) {
      return false;
    }

    const result = await this.execGit(root, ['merge-base', '--is-ancestor', ancestorCommit, descendantCommit], true);
    return result.exitCode === 0;
  }

  async haveSameFirstParent(root: string, leftCommit: string, rightCommit: string): Promise<boolean> {
    if (!leftCommit || !rightCommit || leftCommit === rightCommit) {
      return false;
    }

    const [leftParent, rightParent] = await Promise.all([
      this.getFirstParent(root, leftCommit),
      this.getFirstParent(root, rightCommit)
    ]);

    // Both are root commits (no parent) → same lineage (e.g. amend of first commit)
    if (!leftParent && !rightParent) {
      return true;
    }

    return Boolean(leftParent && rightParent && leftParent === rightParent);
  }

  private async execGit(cwd: string, args: string[], allowFailure: boolean): Promise<CommandResult> {
    const result = await this.processService.run('git', args, cwd);
    if (!allowFailure && !result.ok) {
      throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    }

    return result;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async getFirstParent(root: string, commit: string): Promise<string> {
    const result = await this.execGit(root, ['rev-parse', `${commit}^`], true);
    return result.exitCode === 0 ? result.stdout.trim() : '';
  }
}
