import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeAlertTitle, sendAlert } from '../server/alert.ts';

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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
