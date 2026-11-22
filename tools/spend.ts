import { todaySpend } from '../server/spend.ts';

const totals = todaySpend();
if (!totals.length) console.log('No model calls today.');
for (const row of totals) {
  console.log(`${row.model}: ${row.calls} calls, ${row.inputTokens} input tokens, ${row.outputTokens} output tokens, $${row.costUsd.toFixed(6)}`);
}
