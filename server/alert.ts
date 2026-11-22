import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ALERTS_LOG_FILE = join(import.meta.dirname, '..', 'logs', 'alerts.log');

export function sanitizeAlertTitle(title: string): string {
  return String(title ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function runNoShell(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; killed: boolean; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    let settled = false;
    let killed = false;
    let stdout = '';
    let stderr = '';
    const cap = 1_048_576;
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error: any) {
      resolve({ code: null, killed: false, stdout: '', stderr: '', error });
      return;
    }
    const finish = (result: { code: number | null; killed: boolean; stdout: string; stderr: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill(); } catch { /* ignore */ }
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      try { child.stderr?.destroy(); } catch { /* ignore */ }
      finish({ code: null, killed: true, stdout, stderr });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ code: null, killed, stdout, stderr, error });
    });
    child.on('close', (code) => {
      finish({ code, killed, stdout, stderr });
    });
  });
}

export async function sendAlert(
  command: string[],
  rawTitle: string,
  opts: { logFile?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; skipped?: boolean; title: string; error?: string }> {
  const title = sanitizeAlertTitle(rawTitle);
  if (!command.length || !title) return { ok: true, skipped: true, title };
  const logFile = opts.logFile ?? ALERTS_LOG_FILE;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const [bin, ...rest] = command.map((part) => part.replaceAll('{title}', title));
  const res = await runNoShell(bin, rest, timeoutMs);
  const logLine = (status: string, detail = '') => {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(
        logFile,
        `${new Date().toISOString()} [${status}] ${JSON.stringify(title)}${detail ? ` ${detail}` : ''}\n`,
      );
    } catch {
      /* logging failure must not crash the caller */
    }
  };
  if (res.killed) {
    const error = 'timed out';
    logLine('FAIL', error);
    return { ok: false, title, error };
  }
  if (res.error) {
    const error = res.error.message;
    logLine('FAIL', error);
    return { ok: false, title, error };
  }
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const error = `exit ${res.code}${detail ? `: ${detail}` : ''}`;
    logLine('FAIL', error);
    return { ok: false, title, error };
  }
  logLine('OK');
  return { ok: true, title };
}
