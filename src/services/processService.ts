import * as os from 'os';
import { spawn } from 'child_process';

import { CommandResult, ProcessHandle } from '../types';

interface RunOptions {
  onSpawn?: (handle: ProcessHandle) => void | Promise<void>;
  stdin?: 'ignore' | 'pipe';
  input?: string;
  shell?: boolean;
}

export class ProcessService {
  async run(
    command: string,
    args: string[],
    cwd: string,
    options: RunOptions = {}
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      let cancelled = false;
      let childPid = -1;
      let childExited = false;

      const child = spawn(command, args, {
        cwd,
        env: process.env,
        detached: os.platform() !== 'win32',
        shell: options.shell ?? false,
        windowsHide: true,
        stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe']
      });

      childPid = child.pid ?? -1;

      const handle: ProcessHandle = {
        pid: childPid,
        stop: async () => {
          if (cancelled || childExited || childPid <= 0) {
            return;
          }

          cancelled = true;
          await this.killProcessTree(childPid);
        }
      };

      void Promise.resolve(options.onSpawn?.(handle)).catch(() => {});

      let stdout = '';
      let stderr = '';

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      if (options.stdin === 'pipe') {
        child.stdin?.setDefaultEncoding('utf8');
        child.stdin?.end(options.input ?? '');
      }

      child.on('error', (error) => {
        resolve({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: `${stderr}\n${error.message}`.trim(),
          cancelled
        });
      });

      child.on('close', (exitCode) => {
        childExited = true;
        resolve({
          ok: exitCode === 0,
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          cancelled
        });
      });
    });
  }

  private async killProcessTree(pid: number): Promise<void> {
    if (pid <= 0) {
      return;
    }

    if (os.platform() === 'win32') {
      await this.runKillCommand('taskkill', ['/pid', String(pid), '/t', '/f']);
      return;
    }

    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore kill failures; the process may have already exited.
      }
    }
  }

  private async runKillCommand(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve) => {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true
      });

      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
  }
}
