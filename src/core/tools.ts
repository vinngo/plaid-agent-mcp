// The tool registry: the single source of truth for every tool's name,
// description, JSON schema and behavior. The MCP adapter (local) and the Lambda
// adapter (AgentCore Gateway) both dispatch through runTool(), and
// scripts/gateway-schema.ts emits the Gateway target schema from this list.

import { z } from "zod";
import type { Account, PortfolioProvider } from "../providers/types.js";
import { PlaidRequestError } from "../providers/plaid.js";
import type { SnapshotStore } from "../storage/snapshots.js";
import {
  HOLDING_COLUMNS,
  TRANSACTION_COLUMNS,
  oldestAsOf,
  toAccountMeta,
  toCsv,
  toHoldingRows,
  toTransactionRows,
} from "./canonical.js";
import { readLatest, snapshotId, updateLatest } from "./snapshots.js";
import { summarize } from "./summary.js";

export interface ToolDeps {
  provider: PortfolioProvider;
  snapshots: SnapshotStore;
  staleAfterHours: number;
  now: () => Date;
}

/** JSON Schema subset that Gateway inline tool schemas accept. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(args: unknown, deps: ToolDeps): Promise<unknown>;
}

/** An error the agent should see and can act on (bad input, nothing linked, Plaid needs relink). */
export class ToolError extends Error {
  constructor(
    message: string,
    public code: string,
    public guidance?: string,
  ) {
    super(message);
  }
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const r2 = (n: number) => Math.round(n * 100) / 100;
const hoursBetween = (from: string, to: Date) => r2((to.getTime() - new Date(from).getTime()) / 3600_000);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Only investment accounts reach the agent. A linked login can also carry
 * checking, credit and loan accounts whose balances would read as portfolio
 * value. Depository accounts (e.g. a Fidelity cash management account) are
 * dropped too; money-market sweeps inside a brokerage still appear as holdings.
 */
function investmentAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.type === "investment");
}

async function holdingsAndMeta(deps: ToolDeps) {
  const result = await deps.provider.getHoldings();
  const pulledAt = deps.now().toISOString();
  const accounts = toAccountMeta(investmentAccounts(result.accounts), result.itemsAsOf);
  const rows = toHoldingRows(result.holdings, accounts);
  return { rows, accounts, pulledAt };
}

function requireLinked<T>(rows: T[], what: string): void {
  if (rows.length === 0) {
    throw new ToolError(`No ${what} found.`, "NO_DATA", "No brokerage is linked yet, or Plaid is still preparing data.");
  }
}

// Every successful result carries `data_as_of`: the oldest time Plaid itself last
// refreshed any account the result covers (ISO UTC), or null when unknown. It is
// never a pull time; those are reported separately as `pulled_at`.
export const TOOLS: ToolDef[] = [
  {
    name: "snapshot_status",
    description:
      "Check how fresh the stored snapshots are before deciding whether to pull. Returns, for holdings and " +
      "transactions, the S3 key, when it was pulled and its age in hours, plus each account's as_of (when Plaid " +
      "itself last refreshed that brokerage, or null if unknown). data_as_of is the oldest of those. `stale` " +
      "compares pull age to the threshold; a fresh pull cannot make data newer than Plaid's own refresh. Cheap: " +
      "reads only latest.json, never calls Plaid.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, deps) {
      const latest = await readLatest(deps.snapshots);
      const now = deps.now();
      const h = latest.holdings;
      const t = latest.transactions;
      const holdings = h && {
        s3_key: h.key,
        accounts_key: h.accounts_key,
        pulled_at: h.pulled_at,
        age_hours: hoursBetween(h.pulled_at, now),
        stale: hoursBetween(h.pulled_at, now) > deps.staleAfterHours,
        row_count: h.row_count,
        total_value: h.total_value,
      };
      const transactions = t && {
        s3_key: t.key,
        pulled_at: t.pulled_at,
        age_hours: hoursBetween(t.pulled_at, now),
        stale: hoursBetween(t.pulled_at, now) > deps.staleAfterHours,
        start_date: t.start_date,
        end_date: t.end_date,
        row_count: t.row_count,
      };
      const accounts = (h?.accounts ?? []).map((a) => ({
        broker: a.broker,
        account_id: a.account_id,
        account_type: a.account_type,
        name: a.name,
        as_of: a.as_of,
        data_age_hours: a.as_of ? hoursBetween(a.as_of, now) : null,
      }));
      const summary = !h
        ? "No holdings snapshot yet. Call pull_holdings."
        : `Holdings pulled ${holdings!.age_hours}h ago (${holdings!.stale ? "stale" : "fresh"}, threshold ${deps.staleAfterHours}h).` +
          (t ? ` Transactions ${t.start_date}..${t.end_date} pulled ${transactions!.age_hours}h ago.` : " No transactions snapshot yet.");
      return {
        summary,
        data_as_of: oldestAsOf(accounts.map((a) => a.as_of)),
        stale_after_hours: deps.staleAfterHours,
        holdings: holdings ?? null,
        transactions: transactions ?? null,
        accounts,
      };
    },
  },

  {
    name: "list_accounts",
    description:
      "List linked brokerage accounts with broker (fidelity, robinhood), account_type (brokerage, ira, roth, " +
      "401k), name, last-four mask and last-known balance. Investment accounts only: checking, credit, loan and " +
      "other depository accounts (including a Fidelity cash management account) are excluded; money-market " +
      "sweeps inside a brokerage account appear as holdings. Small inline JSON; calls Plaid.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, deps) {
      const accounts = toAccountMeta(investmentAccounts(await deps.provider.listAccounts()), {}).map(
        ({ as_of: _asOf, ...rest }) => rest,
      );
      requireLinked(accounts, "accounts");
      return {
        summary: `${accounts.length} account(s) across ${new Set(accounts.map((a) => a.broker)).size} broker(s).`,
        // Plaid's accounts call carries no refresh time for these balances.
        data_as_of: null,
        accounts,
      };
    },
  },

  {
    name: "portfolio_summary",
    description:
      "Total value, cash, allocation by broker / security type / account, top 5 holdings, and unrealized gain " +
      "computed only over positions with a known cost basis (positions without one are listed, not guessed). " +
      "Small inline JSON with as_of per broker and data_as_of (the oldest). Use this for 'how much do I have / how is it split' questions " +
      "that need no row-level math. Calls Plaid; does not write a snapshot.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, deps) {
      const { rows, accounts } = await holdingsAndMeta(deps);
      requireLinked(rows, "holdings");
      return summarize(rows, accounts);
    },
  },

  {
    name: "pull_holdings",
    description:
      "Pull current holdings for every linked account from Plaid and write them as holdings.csv (plus " +
      "accounts.json) to a new dated snapshot. Returns a pointer, not the rows: load the s3_key into the sandbox " +
      `to analyze it. Columns: ${HOLDING_COLUMNS.join(", ")}. cost_basis is empty when the broker doesn't report ` +
      "it; flag those rows rather than computing gains on them.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, deps) {
      const { rows, accounts, pulledAt } = await holdingsAndMeta(deps);
      requireLinked(rows, "holdings");
      const dir = `snapshots/${snapshotId(deps.now())}`;
      const key = `${dir}/holdings.csv`;
      const accountsKey = `${dir}/accounts.json`;
      const totalValue = r2(rows.reduce((s, r) => s + Number(r.market_value), 0));

      await deps.snapshots.put(key, toCsv(HOLDING_COLUMNS, rows), "text/csv");
      await deps.snapshots.put(accountsKey, `${JSON.stringify(accounts, null, 2)}\n`, "application/json");
      await updateLatest(deps.snapshots, {
        holdings: { key, accounts_key: accountsKey, pulled_at: pulledAt, row_count: rows.length, total_value: totalValue, accounts },
      });

      return {
        s3_key: key,
        accounts_key: accountsKey,
        data_as_of: oldestAsOf(accounts.map((a) => a.as_of)),
        pulled_at: pulledAt,
        row_count: rows.length,
        total_value: totalValue,
        missing_cost_basis: rows.filter((r) => r.cost_basis === null && r.security_type !== "cash").length,
      };
    },
  },

  {
    name: "pull_transactions",
    description:
      "Pull investment transactions in a date range from Plaid and write them as transactions.csv to a new dated " +
      "snapshot. Returns a pointer, not the rows. Defaults to the last 90 days; Plaid keeps up to 24 months. " +
      `Columns: ${TRANSACTION_COLUMNS.join(", ")}. type is one of buy, sell, dividend, interest, fee, transfer, ` +
      "other. amount uses Plaid's sign: positive = cash out of the account (buys, fees), negative = cash in " +
      "(sells, dividends, deposits).",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date, YYYY-MM-DD. Default: 90 days ago." },
        end_date: { type: "string", description: "End date, YYYY-MM-DD. Default: today." },
      },
    },
    async run(args, deps) {
      const parsed = z.object({ start_date: DATE.optional(), end_date: DATE.optional() }).safeParse(args ?? {});
      if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "INVALID_INPUT");
      const now = deps.now();
      const endDate = parsed.data.end_date ?? isoDate(now);
      const startDate = parsed.data.start_date ?? isoDate(new Date(now.getTime() - 90 * 86400_000));
      if (startDate > endDate) throw new ToolError("start_date is after end_date.", "INVALID_INPUT");

      const { transactions } = await deps.provider.getInvestmentTransactions({ startDate, endDate });
      const rows = toTransactionRows(transactions);
      const pulledAt = now.toISOString();
      const key = `snapshots/${snapshotId(now)}/transactions.csv`;

      await deps.snapshots.put(key, toCsv(TRANSACTION_COLUMNS, rows), "text/csv");
      await updateLatest(deps.snapshots, {
        transactions: { key, pulled_at: pulledAt, start_date: startDate, end_date: endDate, row_count: rows.length },
      });
      return {
        s3_key: key,
        // Plaid reports no refresh time with investment transactions.
        data_as_of: null,
        pulled_at: pulledAt,
        start_date: startDate,
        end_date: endDate,
        row_count: rows.length,
      };
    },
  },
];

export type ToolOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: { message: string; code: string; guidance?: string } };

/** Run a tool by name. Expected failures come back as data the agent can read; bugs still throw. */
export async function runTool(name: string, args: unknown, deps: ToolDeps): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: { message: `Unknown tool: ${name}`, code: "UNKNOWN_TOOL" } };
  try {
    return { ok: true, data: await tool.run(args, deps) };
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, error: { message: err.message, code: err.code, guidance: err.guidance } };
    if (err instanceof PlaidRequestError) {
      const guidance =
        err.code === "ITEM_LOGIN_REQUIRED"
          ? "The brokerage connection needs to be re-linked in the web app."
          : err.code === "PRODUCT_NOT_READY"
            ? "Plaid is still preparing investments data. Try again shortly."
            : undefined;
      return { ok: false, error: { message: `Plaid error: ${err.message}`, code: err.code ?? "PLAID_ERROR", guidance } };
    }
    throw err;
  }
}
