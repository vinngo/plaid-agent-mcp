/**
 * Run every tool once against the configured backends and print the results.
 * With no Plaid keys this uses mock data and writes to SNAPSHOT_DIR.
 *
 *   npm run smoke
 */
import { config } from "../src/config.js";
import { defaultDeps } from "../src/core/deps.js";
import { TOOLS, runTool } from "../src/core/tools.js";

const deps = defaultDeps();
console.log(`provider=${config.providerKind} snapshots=${config.snapshots.kind} tokens=${config.tokens.kind}\n`);

const calls: [string, Record<string, unknown>][] = [
  ["snapshot_status", {}],
  ["list_accounts", {}],
  ["portfolio_summary", {}],
  ["pull_holdings", {}],
  ["pull_transactions", {}],
  ["snapshot_status", {}],
];

let failed = 0;
for (const [name, args] of calls) {
  const out = await runTool(name, args, deps);
  console.log(`── ${name} ${out.ok ? "ok" : "ERROR"}`);
  console.log(JSON.stringify(out.ok ? out.data : out.error, null, 2), "\n");
  if (!out.ok) failed++;
}

const holdingsKey = (await runTool("snapshot_status", {}, deps)) as { ok: true; data: { holdings?: { s3_key: string } } };
if (holdingsKey.ok && holdingsKey.data.holdings) {
  console.log(`── ${holdingsKey.data.holdings.s3_key}`);
  console.log(await deps.snapshots.get(holdingsKey.data.holdings.s3_key));
}

console.log(`${calls.length - failed}/${calls.length} calls ok · ${TOOLS.length} tools registered`);
process.exit(failed ? 1 : 0);
