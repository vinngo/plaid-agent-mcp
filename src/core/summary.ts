// Small, inline-JSON portfolio summary. Anything row-level belongs in the
// sandbox; this only answers "how much / how is it split" questions.
//
// Unrealized gain is computed only over positions that have a cost basis, and
// the rest are listed by name. (Upstream summed value over all positions but
// cost over only some, which counted uncovered positions as pure gain.)

import type { AccountMeta, HoldingRow } from "./canonical.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? r2((part / whole) * 100) : 0);

function groupSum<K extends string>(rows: HoldingRow[], keyOf: (r: HoldingRow) => K): Map<K, number> {
  const m = new Map<K, number>();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + Number(r.market_value));
  return m;
}

export function summarize(rows: HoldingRow[], accounts: AccountMeta[]) {
  const total = rows.reduce((s, r) => s + Number(r.market_value), 0);
  const currencies = [...new Set(accounts.map((a) => a.currency ?? "UNKNOWN"))];

  const withBasis = rows.filter((r) => r.cost_basis !== null && r.security_type !== "cash");
  const missingBasis = rows.filter((r) => r.cost_basis === null && r.security_type !== "cash");
  const coveredValue = withBasis.reduce((s, r) => s + Number(r.market_value), 0);
  const coveredCost = withBasis.reduce((s, r) => s + Number(r.cost_basis), 0);

  const asOfByBroker: Record<string, string> = {};
  for (const a of accounts) {
    if (!a.as_of) continue;
    // Report the oldest refresh per broker: that's how stale its data can be.
    if (!asOfByBroker[a.broker] || a.as_of < asOfByBroker[a.broker]) asOfByBroker[a.broker] = a.as_of;
  }

  const acctById = new Map(accounts.map((a) => [a.account_id, a]));
  const byAccount = [...groupSum(rows, (r) => String(r.account_id)).entries()]
    .map(([id, value]) => {
      const a = acctById.get(id);
      return { account_id: id, broker: a?.broker ?? "unknown", account_type: a?.account_type ?? "unknown", name: a?.name ?? id, value: r2(value), pct: pct(value, total) };
    })
    .sort((a, b) => b.value - a.value);

  const byTicker = groupSum(
    rows.filter((r) => r.security_type !== "cash"),
    (r) => String(r.ticker ?? r.security_name ?? "unknown"),
  );
  const topHoldings = [...byTicker.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ticker, value]) => ({ ticker, value: r2(value), pct: pct(value, total) }));

  const share = (m: Map<string, number>, label: string) =>
    [...m.entries()].map(([k, v]) => ({ [label]: k, value: r2(v), pct: pct(v, total) })).sort((a, b) => b.value - a.value);

  const gain = coveredValue - coveredCost;
  const unrealized = {
    gain: r2(gain),
    gain_pct: coveredCost > 0 ? r2((gain / coveredCost) * 100) : null,
    covers_value: r2(coveredValue),
    positions_missing_cost_basis: missingBasis.map((r) => `${r.ticker ?? r.security_name} (${r.broker})`),
  };

  const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const parts = [
    `Total ${usd(total)} across ${accounts.length} account(s).`,
    `Unrealized ${gain >= 0 ? "+" : ""}${usd(gain)}${unrealized.gain_pct !== null ? ` (${unrealized.gain_pct}%)` : ""} on ${usd(coveredValue)} with known cost basis.`,
  ];
  if (missingBasis.length) parts.push(`No cost basis for: ${unrealized.positions_missing_cost_basis.join(", ")}.`);
  if (currencies.length > 1) parts.push(`Mixed currencies (${currencies.join(", ")}) are summed unconverted.`);

  return {
    summary: parts.join(" "),
    as_of_by_broker: asOfByBroker,
    currency: currencies.length === 1 ? currencies[0] : currencies,
    total_value: r2(total),
    cash_value: r2(rows.filter((r) => r.security_type === "cash").reduce((s, r) => s + Number(r.market_value), 0)),
    unrealized,
    by_broker: share(groupSum(rows, (r) => String(r.broker)), "broker"),
    by_security_type: share(groupSum(rows, (r) => String(r.security_type)), "security_type"),
    by_account: byAccount,
    top_holdings: topHoldings,
  };
}
