import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Context } from "aws-lambda";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockProvider } from "../src/providers/mock.js";
import { LocalSnapshotStore } from "../src/storage/snapshots.js";
import { HOLDING_COLUMNS, TRANSACTION_COLUMNS, securityTypeOf, toCsv, transactionTypeOf } from "../src/core/canonical.js";
import { TOOLS, runTool, type ToolDeps } from "../src/core/tools.js";
import { buildMcpServer } from "../src/adapters/mcp.js";
import { handler, toolNameFrom } from "../src/adapters/lambda.js";

function setup(start = new Date("2026-10-13T22:40:00Z")) {
  const dir = mkdtempSync(path.join(tmpdir(), "plaid-agent-"));
  let now = start;
  const deps: ToolDeps = {
    provider: new MockProvider(),
    snapshots: new LocalSnapshotStore(dir),
    staleAfterHours: 12,
    now: () => now,
  };
  return { dir, deps, advanceHours: (h: number) => (now = new Date(now.getTime() + h * 3600_000)) };
}

async function call(name: string, args: unknown, deps: ToolDeps): Promise<any> {
  const out = await runTool(name, args, deps);
  assert.ok(out.ok, `${name} failed: ${JSON.stringify(!out.ok && out.error)}`);
  return out.data;
}

/** Minimal RFC 4180 reader: quoted cells, escaped quotes, empty trailing cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

test("registry exposes exactly the spec's MCP tools", () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ["list_accounts", "portfolio_summary", "pull_holdings", "pull_transactions", "snapshot_status"]);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, "object");
});

test("snapshot_status before any pull says to pull", async () => {
  const { deps } = setup();
  const s = await call("snapshot_status", {}, deps);
  assert.equal(s.holdings, null);
  assert.match(s.summary, /pull_holdings/);
});

test("pull_holdings writes canonical CSV, accounts.json and latest.json", async () => {
  const { dir, deps } = setup();
  const res = await call("pull_holdings", {}, deps);

  assert.equal(res.s3_key, "snapshots/2026-10-13T2240/holdings.csv");
  assert.equal(res.row_count, 9);
  assert.equal(res.missing_cost_basis, 1);

  const rows = parseCsv(readFileSync(path.join(dir, res.s3_key), "utf8"));
  assert.deepEqual(rows[0], [...HOLDING_COLUMNS]);
  assert.equal(rows.length - 1, 9);
  const col = (name: string) => HOLDING_COLUMNS.indexOf(name as (typeof HOLDING_COLUMNS)[number]);
  const sum = rows.slice(1).reduce((s, r) => s + Number(r[col("market_value")]), 0);
  assert.equal(Math.round(sum * 100) / 100, res.total_value);
  assert.deepEqual([...new Set(rows.slice(1).map((r) => r[col("broker")]))].sort(), ["fidelity", "robinhood"]);
  assert.ok(rows.slice(1).some((r) => r[col("security_type")] === "crypto"));
  const amzn = rows.find((r) => r[col("ticker")] === "AMZN")!;
  assert.equal(amzn[col("cost_basis")], "", "missing cost basis stays empty, not 0");
  assert.equal(amzn[col("security_name")], "Amazon.com, Inc.", "comma in a name survives CSV quoting");

  const accounts = JSON.parse(readFileSync(path.join(dir, res.accounts_key), "utf8"));
  assert.equal(accounts.length, 3);
  assert.deepEqual(accounts.map((a: any) => a.account_type).sort(), ["brokerage", "brokerage", "roth"]);

  const latest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  assert.equal(latest.holdings.key, res.s3_key);
  // as_of is the oldest per-account Plaid refresh (Fidelity, 9h before mock "now").
  assert.ok(res.as_of < res.pulled_at);
});

test("snapshot_status flips to stale after the threshold", async () => {
  const { deps, advanceHours } = setup();
  await call("pull_holdings", {}, deps);
  assert.equal((await call("snapshot_status", {}, deps)).holdings.stale, false);
  advanceHours(13);
  const s = await call("snapshot_status", {}, deps);
  assert.equal(s.holdings.stale, true);
  assert.equal(s.holdings.age_hours, 13);
  assert.equal(s.accounts.length, 3);
});

test("pull_transactions defaults to 90 days and maps types", async () => {
  const { dir, deps } = setup(new Date());
  const res = await call("pull_transactions", {}, deps);
  assert.equal(res.row_count, 11);
  const rows = parseCsv(readFileSync(path.join(dir, res.s3_key), "utf8"));
  assert.deepEqual(rows[0], [...TRANSACTION_COLUMNS]);
  const types = rows.slice(1).map((r) => r[TRANSACTION_COLUMNS.indexOf("type")]);
  const count = (t: string) => types.filter((x) => x === t).length;
  assert.equal(count("buy"), 4);
  assert.equal(count("sell"), 1);
  assert.equal(count("dividend"), 2);
  assert.equal(count("interest"), 1);
  assert.equal(count("transfer"), 2); // Roth contribution + ACH deposit
  assert.equal(count("fee"), 1);

  const narrow = await call("pull_transactions", { start_date: res.end_date, end_date: res.end_date }, deps);
  assert.equal(narrow.row_count, 0);

  const latest = JSON.parse(readFileSync(path.join(dir, "latest.json"), "utf8"));
  assert.equal(latest.transactions.start_date, narrow.start_date, "latest points at the newest pull");
});

test("pull_transactions rejects bad input as a readable error", async () => {
  const { deps } = setup();
  const bad = await runTool("pull_transactions", { start_date: "10/01/2026" }, deps);
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.error.code, "INVALID_INPUT");
  const flipped = await runTool("pull_transactions", { start_date: "2026-10-10", end_date: "2026-10-01" }, deps);
  assert.equal(!flipped.ok && flipped.error.code, "INVALID_INPUT");
});

test("portfolio_summary excludes positions without cost basis from gain", async () => {
  const { deps } = setup();
  const s = await call("portfolio_summary", {}, deps);
  assert.deepEqual(s.unrealized.positions_missing_cost_basis, ["AMZN (robinhood)"]);
  // AMZN is 12 x 228.90 = 2746.80 of value with no basis; it must not count as gain.
  const amznValue = 12 * 228.9;
  assert.ok(Math.abs(s.total_value - s.cash_value - s.unrealized.covers_value - amznValue) < 0.01);
  assert.equal(s.currency, "USD");
  assert.equal(s.top_holdings.length, 5);
  assert.ok(s.as_of_by_broker.fidelity && s.as_of_by_broker.robinhood);
  const pctSum = s.by_broker.reduce((x: number, b: any) => x + b.pct, 0);
  assert.ok(Math.abs(pctSum - 100) < 0.05);
});

test("transaction type mapping covers Plaid subtypes", () => {
  assert.equal(transactionTypeOf("cash", "qualified dividend"), "dividend");
  assert.equal(transactionTypeOf("buy", "dividend reinvestment"), "dividend");
  assert.equal(transactionTypeOf("cash", "withdrawal"), "transfer");
  assert.equal(transactionTypeOf("cash", "account fee"), "fee");
  assert.equal(transactionTypeOf("cancel", "cancel"), "other");
});

test("security type mapping: crypto before the cash flag, money market as cash", () => {
  assert.equal(securityTypeOf("cryptocurrency", true), "crypto");
  assert.equal(securityTypeOf("mutual fund", true), "cash");
  assert.equal(securityTypeOf("equity", false), "equity");
  assert.equal(securityTypeOf(undefined, true), "cash");
});

test("CSV quoting escapes quotes and newlines", () => {
  const csv = toCsv(["a", "b"] as const, [{ a: 'say "hi"', b: "line\nbreak" }, { a: null, b: 3 }]);
  assert.equal(csv, 'a,b\n"say ""hi""","line\nbreak"\n,3\n');
});

test("local snapshot store refuses keys outside its root", async () => {
  const { deps } = setup();
  await assert.rejects(deps.snapshots.put("../escape.txt", "x", "text/plain"), /escapes store root/);
});

test("Lambda adapter strips the Gateway target prefix and dispatches", async () => {
  const { deps } = setup();
  const ctx = (name?: string, key: "Custom" | "custom" = "Custom") =>
    ({ clientContext: name ? { [key]: { bedrockAgentCoreToolName: name } } : undefined }) as unknown as Context;

  assert.equal(toolNameFrom(ctx("plaid-tools___pull_holdings")), "pull_holdings");
  assert.equal(toolNameFrom(ctx("plaid-tools___snapshot_status", "custom")), "snapshot_status");

  const pulled: any = await handler({}, ctx("plaid-tools___pull_holdings"), deps);
  assert.equal(pulled.row_count, 9);
  const status: any = await handler({}, ctx("plaid-tools___snapshot_status"), deps);
  assert.equal(status.holdings.s3_key, pulled.s3_key);

  const missing: any = await handler({}, ctx(), deps);
  assert.equal(missing.error.code, "BAD_INVOCATION");
  const unknown: any = await handler({}, ctx("plaid-tools___delete_everything"), deps);
  assert.equal(unknown.error.code, "UNKNOWN_TOOL");
});

test("MCP adapter lists tools and returns JSON results", async () => {
  const { deps } = setup();
  const server = buildMcpServer(deps);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  const { tools } = await client.listTools();
  assert.equal(tools.length, 5);

  const res: any = await client.callTool({ name: "pull_holdings", arguments: {} });
  assert.equal(res.isError, false);
  assert.equal(JSON.parse(res.content[0].text).row_count, 9);

  const bad: any = await client.callTool({ name: "pull_transactions", arguments: { start_date: "nope" } });
  assert.equal(bad.isError, true);
  await client.close();
});
