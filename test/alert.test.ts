import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNoShell, sanitizeAlertTitle, sendAlert } from '../server/alert.ts';

test('alerts sanitize title, run without shell, write argv, and log success/failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-alert-'));
  try {
    const outFile = join(dir, 'argv.json');
    const logFile = join(dir, 'alerts.log');
    const okScript = join(dir, 'ok.py');
    const failScript = join(dir, 'fail.py');
    const hangScript = join(dir, 'hang.py');

    writeFileSync(okScript, `
import json, sys
with open(${JSON.stringify(outFile)}, 'w', encoding='utf-8') as f:
    json.dump(sys.argv[1:], f)
`, 'utf8');
    writeFileSync(failScript, `
import sys
sys.stderr.write('boom')
sys.exit(2)
`, 'utf8');
    writeFileSync(hangScript, `
import time
time.sleep(5)
`, 'utf8');

    const rawTitle = 'Gold idea: "Smart\nKitchen\r\nHelper" ' + 'x'.repeat(90);
    const expected = sanitizeAlertTitle(rawTitle);
    assert.ok(!expected.includes('"') && !expected.includes('\n') && !expected.includes('\r'));
    assert.equal(expected.length, 80);

    // Empty command does nothing
    const skipped = await sendAlert([], rawTitle, { logFile });
    assert.equal(skipped.skipped, true);
    assert.equal(existsSync(logFile), false);

    // Success writes argv and logs OK
    const ok = await sendAlert(['python', '-I', okScript, '--title', '{title}'], rawTitle, { logFile });
    assert.equal(ok.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(outFile, 'utf8')), ['--title', expected]);

    // Failure & timeout log FAIL without hanging
    const fail = await sendAlert(['python', '-I', failScript, '{title}'], 'Bad alert', { logFile });
    assert.equal(fail.ok, false);
    const timedOut = await sendAlert(['python', '-I', hangScript, '{title}'], 'Hung alert', { logFile, timeoutMs: 200 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error, 'timed out');

    const logText = readFileSync(logFile, 'utf8');
    assert.match(logText, /\[OK\]/);
    assert.match(logText, /\[FAIL\].*exit 2/);
    assert.match(logText, /\[FAIL\].*timed out/);

    // Control chars and NUL bytes are stripped; command[0] never gets {title} substituted
    assert.equal(sanitizeAlertTitle('Hello\x00World\x07\n"Test"'), 'HelloWorld Test');
    const nulRes = await sendAlert(['python', '-I', okScript, '{title}'], 'Bad\x00Title', { logFile });
    assert.equal(nulRes.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(outFile, 'utf8')), ['BadTitle']);

    const cmd0Res = await sendAlert(['{title}', okScript], 'python', { logFile });
    assert.equal(cmd0Res.ok, false, 'command[0] must not substitute {title}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runNoShell kills child process tree on timeout and waits for exit before cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-tree-'));
  try {
    const marker = join(dir, 'grandchild-survived.txt');
    const workDir = join(dir, 'work');
    const parentScript = join(dir, 'spawn_tree.py');
    writeFileSync(parentScript, `
import os, subprocess, sys, time
os.makedirs(${JSON.stringify(workDir)}, exist_ok=True)
child_code = "import sys, time; f = open(sys.argv[1], 'w'); f.write('locked'); f.flush(); time.sleep(0.9); open(sys.argv[2], 'w').write('alive')"
subprocess.Popen([sys.executable, '-I', '-c', child_code, ${JSON.stringify(join(workDir, 'hold.txt'))}, ${JSON.stringify(marker)}], cwd=${JSON.stringify(workDir)})
time.sleep(10)
`, 'utf8');

    const res = await runNoShell('python', ['-I', parentScript], 350);
    assert.equal(res.killed, true);
    // Immediately after runNoShell resolves, workDir must be removable without EBUSY/EPERM
    rmSync(workDir, { recursive: true, force: true });
    assert.equal(existsSync(workDir), false);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(existsSync(marker), false, 'grandchild process must have been killed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
