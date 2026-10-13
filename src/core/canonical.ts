// The canonical schema from the spec. The MCP server absorbs broker and Plaid
// quirks here so the agent only ever sees these columns.

import type { Account, Holding, InvestmentTransaction } from "../providers/types.js";

export const HOLDING_COLUMNS = [
  "as_of",
  "broker",
  "account_id",
  "account_type",
  "ticker",
  "security_name",
  "security_type",
  "quantity",
  "price",
  "market_value",
  "cost_basis",
] as const;

// Spec columns, plus subtype/description so the raw Plaid detail isn't lost
// when several subtypes collapse into one canonical type.
export const TRANSACTION_COLUMNS = [
  "date",
  "broker",
  "account_id",
  "ticker",
  "type",
  "quantity",
  "price",
  "amount",
  "fees",
  "subtype",
  "description",
] as const;

export type HoldingRow = Record<(typeof HOLDING_COLUMNS)[number], string | number | null>;
export type TransactionRow = Record<(typeof TRANSACTION_COLUMNS)[number], string | number | null>;

export interface AccountMeta {
  account_id: string;
  broker: string;
  account_type: string;
  name: string;
  mask: string | null;
  balance: number | null;
  currency: string | null;
  as_of: string | null;
}

/** "Fidelity Investments" -> "fidelity", "Robinhood" -> "robinhood", else a slug. */
export function brokerOf(institution: string): string {
  const s = institution.toLowerCase();
  if (s.includes("fidelity")) return "fidelity";
  if (s.includes("robinhood")) return "robinhood";
  return s.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "unknown";
}

export function accountTypeOf(subtype: string | undefined): string {
  const s = (subtype ?? "").toLowerCase().trim();
  if (!s) return "unknown";
  if (s === "roth" || s === "roth ira") return "roth";
  if (s === "ira" || s === "traditional ira") return "ira";
  if (s === "401k" || s === "401(k)") return "401k";
  if (s.includes("brokerage")) return "brokerage";
  return s.replace(/[^a-z0-9]+/g, "_");
}

export function securityTypeOf(type: string | undefined, isCash: boolean | undefined): string {
  if (isCash) return "cash";
  const s = (type ?? "").toLowerCase();
  if (s === "cryptocurrency") return "crypto";
  return s || "other";
}

const DIVIDEND_SUBTYPES = new Set(["dividend", "qualified dividend", "non-qualified dividend", "dividend reinvestment"]);
const TRANSFER_SUBTYPES = new Set(["contribution", "deposit", "withdrawal", "transfer", "rollover"]);

/** Collapse Plaid type/subtype into buy, sell, dividend, interest, fee, transfer or other. */
export function transactionTypeOf(type: string, subtype: string): string {
  const t = type.toLowerCase();
  const st = subtype.toLowerCase();
  if (DIVIDEND_SUBTYPES.has(st)) return "dividend";
  if (t === "buy" || t === "sell" || t === "fee" || t === "transfer") return t;
  if (st === "interest") return "interest";
  if (TRANSFER_SUBTYPES.has(st)) return "transfer";
  if (st.includes("fee")) return "fee";
  return "other";
}

export function toAccountMeta(accounts: Account[], itemsAsOf: Record<string, string>, fallbackAsOf: string): AccountMeta[] {
  return accounts.map((a) => ({
    account_id: a.accountId,
    broker: brokerOf(a.institution),
    account_type: accountTypeOf(a.subtype),
    name: a.name,
    mask: a.mask ?? null,
    balance: a.currentBalance ?? null,
    currency: a.currency ?? null,
    as_of: itemsAsOf[a.itemId] ?? fallbackAsOf,
  }));
}

export function toHoldingRows(holdings: Holding[], accounts: AccountMeta[], fallbackAsOf: string): HoldingRow[] {
  const byId = new Map(accounts.map((a) => [a.account_id, a]));
  return holdings.map((h) => {
    const acct = byId.get(h.accountId);
    return {
      as_of: acct?.as_of ?? fallbackAsOf,
      broker: acct?.broker ?? brokerOf(h.institution),
      account_id: h.accountId,
      account_type: acct?.account_type ?? "unknown",
      ticker: h.ticker ?? null,
      security_name: h.name ?? null,
      security_type: securityTypeOf(h.type, h.isCashEquivalent),
      quantity: h.quantity,
      price: h.price,
      market_value: h.value,
      cost_basis: h.costBasis ?? null,
    };
  });
}

export function toTransactionRows(txns: InvestmentTransaction[]): TransactionRow[] {
  return txns.map((t) => ({
    date: t.date,
    broker: brokerOf(t.institution),
    account_id: t.accountId,
    ticker: t.ticker ?? null,
    type: transactionTypeOf(t.type, t.subtype),
    quantity: t.quantity,
    price: t.price ?? null,
    amount: t.amount,
    fees: t.fees ?? null,
    subtype: t.subtype,
    description: t.name ?? null,
  }));
}

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<C extends readonly string[]>(columns: C, rows: Record<C[number], string | number | null>[]): string {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c as C[number]])).join(","));
  return `${lines.join("\n")}\n`;
}
