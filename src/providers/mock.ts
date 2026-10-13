// Mock provider: sample data shaped like the real setup (Fidelity + Robinhood,
// USD) so the whole pipeline runs before any Plaid keys exist. One position has
// no cost basis on purpose, to exercise the "flag, don't compute" path.

import type {
  Account,
  Holding,
  HoldingsResult,
  InvestmentTransaction,
  LinkedItemInfo,
  PortfolioProvider,
  QueryOptions,
  Security,
  TransactionQueryOptions,
  TransactionsResult,
} from "./types.js";

const FIDELITY = { itemId: "mock-item-fidelity", institution: "Fidelity" };
const ROBINHOOD = { itemId: "mock-item-robinhood", institution: "Robinhood" };
const USD = "USD";

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function hoursAgoIso(n: number): string {
  return new Date(Date.now() - n * 3600_000).toISOString();
}

const ACCOUNTS: Account[] = [
  { ...FIDELITY, accountId: "mock-acc-fid-brokerage", name: "Individual", mask: "1111", type: "investment", subtype: "brokerage", currency: USD },
  { ...FIDELITY, accountId: "mock-acc-fid-roth", name: "Roth IRA", mask: "2222", type: "investment", subtype: "roth", currency: USD },
  { ...ROBINHOOD, accountId: "mock-acc-rh-brokerage", name: "Robinhood Individual", mask: "3333", type: "investment", subtype: "brokerage", currency: USD },
];

interface Seed {
  accountId: string;
  securityId: string;
  ticker?: string;
  name: string;
  type: string;
  quantity: number;
  price: number;
  costBasis?: number;
  isCashEquivalent?: boolean;
}

const SEEDS: Seed[] = [
  // Fidelity Individual
  { accountId: "mock-acc-fid-brokerage", securityId: "sec-vti", ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", quantity: 40, price: 312.4, costBasis: 10400 },
  { accountId: "mock-acc-fid-brokerage", securityId: "sec-fxaix", ticker: "FXAIX", name: "Fidelity 500 Index Fund", type: "mutual fund", quantity: 55.312, price: 221.15, costBasis: 9800 },
  { accountId: "mock-acc-fid-brokerage", securityId: "sec-spaxx", ticker: "SPAXX", name: "Fidelity Government Money Market", type: "cash", quantity: 1840.22, price: 1, costBasis: 1840.22, isCashEquivalent: true },
  // Fidelity Roth IRA
  { accountId: "mock-acc-fid-roth", securityId: "sec-vxus", ticker: "VXUS", name: "Vanguard Total International Stock ETF", type: "etf", quantity: 60, price: 71.85, costBasis: 3720 },
  { accountId: "mock-acc-fid-roth", securityId: "sec-fxaix", ticker: "FXAIX", name: "Fidelity 500 Index Fund", type: "mutual fund", quantity: 20.5, price: 221.15, costBasis: 3600 },
  // Robinhood
  { accountId: "mock-acc-rh-brokerage", securityId: "sec-nvda", ticker: "NVDA", name: "NVIDIA Corporation", type: "equity", quantity: 25, price: 182.3, costBasis: 2950 },
  { accountId: "mock-acc-rh-brokerage", securityId: "sec-amzn", ticker: "AMZN", name: "Amazon.com, Inc.", type: "equity", quantity: 12, price: 228.9 }, // no cost basis
  { accountId: "mock-acc-rh-brokerage", securityId: "sec-btc", ticker: "BTC", name: "Bitcoin", type: "cryptocurrency", quantity: 0.0425, price: 112400, costBasis: 3900 },
  { accountId: "mock-acc-rh-brokerage", securityId: "sec-cash", name: "Cash", type: "cash", quantity: 312.67, price: 1, costBasis: 312.67, isCashEquivalent: true },
];

const SECURITIES: Security[] = [...new Map(SEEDS.map((s) => [s.securityId, s])).values()].map((s) => ({
  securityId: s.securityId,
  ticker: s.ticker,
  name: s.name,
  type: s.type,
  closePrice: s.price,
  closePriceAsOf: daysAgo(1),
  currency: USD,
  isCashEquivalent: s.isCashEquivalent ?? false,
}));

const r2 = (n: number) => Math.round(n * 100) / 100;

function buildHoldings(): Holding[] {
  return SEEDS.map((s) => {
    const account = ACCOUNTS.find((a) => a.accountId === s.accountId)!;
    const value = r2(s.quantity * s.price);
    const gain = s.costBasis !== undefined ? r2(value - s.costBasis) : undefined;
    return {
      itemId: account.itemId,
      accountId: s.accountId,
      accountName: account.name,
      institution: account.institution,
      securityId: s.securityId,
      ticker: s.ticker,
      name: s.name,
      type: s.type,
      quantity: s.quantity,
      price: s.price,
      priceAsOf: daysAgo(1),
      value,
      costBasis: s.costBasis,
      currency: USD,
      unrealizedGain: gain,
      unrealizedGainPct: gain !== undefined && s.costBasis ? r2((gain / s.costBasis) * 100) : undefined,
      isCashEquivalent: s.isCashEquivalent ?? false,
    };
  });
}

function accountsWithBalances(): Account[] {
  const holdings = buildHoldings();
  return ACCOUNTS.map((a) => {
    const total = r2(holdings.filter((h) => h.accountId === a.accountId).reduce((sum, h) => sum + h.value, 0));
    return { ...a, currentBalance: total, availableBalance: total };
  });
}

function buildTransactions(): InvestmentTransaction[] {
  const mk = (
    id: string,
    accountId: string,
    date: string,
    type: string,
    subtype: string,
    name: string,
    amount: number,
    extra: Partial<InvestmentTransaction> = {},
  ): InvestmentTransaction => {
    const a = ACCOUNTS.find((x) => x.accountId === accountId)!;
    return {
      investmentTransactionId: id,
      itemId: a.itemId,
      accountId,
      accountName: a.name,
      institution: a.institution,
      date,
      type,
      subtype,
      name,
      amount,
      quantity: extra.quantity ?? 0,
      currency: USD,
      ...extra,
    };
  };

  // Plaid sign convention: positive amount = cash leaving the account.
  return [
    mk("mtx-1", "mock-acc-fid-brokerage", daysAgo(2), "buy", "buy", "Bought VTI", 624.8, { securityId: "sec-vti", ticker: "VTI", quantity: 2, price: 312.4 }),
    mk("mtx-2", "mock-acc-fid-brokerage", daysAgo(6), "cash", "dividend", "Dividend VTI", -38.12, { securityId: "sec-vti", ticker: "VTI" }),
    mk("mtx-3", "mock-acc-rh-brokerage", daysAgo(9), "sell", "sell", "Sold NVDA", -364.6, { securityId: "sec-nvda", ticker: "NVDA", quantity: -2, price: 182.3 }),
    mk("mtx-4", "mock-acc-fid-roth", daysAgo(14), "cash", "contribution", "Roth contribution", -500),
    mk("mtx-5", "mock-acc-fid-roth", daysAgo(15), "buy", "buy", "Bought VXUS", 431.1, { securityId: "sec-vxus", ticker: "VXUS", quantity: 6, price: 71.85 }),
    mk("mtx-6", "mock-acc-rh-brokerage", daysAgo(21), "transfer", "transfer", "ACH deposit", -1000),
    mk("mtx-7", "mock-acc-rh-brokerage", daysAgo(22), "buy", "buy", "Bought AMZN", 686.7, { securityId: "sec-amzn", ticker: "AMZN", quantity: 3, price: 228.9 }),
    mk("mtx-8", "mock-acc-fid-roth", daysAgo(30), "cash", "dividend", "Dividend VXUS", -21.4, { securityId: "sec-vxus", ticker: "VXUS" }),
    mk("mtx-9", "mock-acc-rh-brokerage", daysAgo(40), "fee", "miscellaneous fee", "Gold subscription", 5),
    mk("mtx-10", "mock-acc-fid-brokerage", daysAgo(60), "cash", "interest", "SPAXX interest", -6.88, { securityId: "sec-spaxx", ticker: "SPAXX" }),
    mk("mtx-11", "mock-acc-rh-brokerage", daysAgo(75), "buy", "buy", "Bought BTC", 1180.5, { securityId: "sec-btc", ticker: "BTC", quantity: 0.0105, price: 112428.57, fees: 4.2 }),
  ];
}

function filterByAccount<T>(items: T[], accountIds: string[] | undefined, getId: (t: T) => string): T[] {
  if (!accountIds || accountIds.length === 0) return items;
  const allow = new Set(accountIds);
  return items.filter((i) => allow.has(getId(i)));
}

export class MockProvider implements PortfolioProvider {
  readonly kind = "mock" as const;

  async isReady(): Promise<boolean> {
    return true;
  }

  async listLinkedItems(): Promise<LinkedItemInfo[]> {
    return [FIDELITY, ROBINHOOD].map((i) => ({
      ...i,
      linkedAt: daysAgo(30),
      accounts: ACCOUNTS.filter((a) => a.itemId === i.itemId).length,
    }));
  }

  async listAccounts(): Promise<Account[]> {
    return accountsWithBalances();
  }

  async getBalances(opts: QueryOptions = {}): Promise<Account[]> {
    return filterByAccount(accountsWithBalances(), opts.accountIds, (a) => a.accountId);
  }

  async getHoldings(opts: QueryOptions = {}): Promise<HoldingsResult> {
    const holdings = filterByAccount(buildHoldings(), opts.accountIds, (h) => h.accountId);
    const used = new Set(holdings.map((h) => h.securityId));
    return {
      accounts: filterByAccount(accountsWithBalances(), opts.accountIds, (a) => a.accountId),
      holdings,
      securities: SECURITIES.filter((s) => used.has(s.securityId)),
      // Robinhood refreshed more recently than Fidelity, like real Plaid data.
      itemsAsOf: { [FIDELITY.itemId]: hoursAgoIso(9), [ROBINHOOD.itemId]: hoursAgoIso(3) },
    };
  }

  async getInvestmentTransactions(opts: TransactionQueryOptions): Promise<TransactionsResult> {
    const txns = filterByAccount(
      buildTransactions().filter((t) => t.date >= opts.startDate && t.date <= opts.endDate),
      opts.accountIds,
      (t) => t.accountId,
    ).sort((a, b) => b.date.localeCompare(a.date));
    const used = new Set(txns.map((t) => t.securityId).filter(Boolean) as string[]);
    return {
      accounts: filterByAccount(accountsWithBalances(), opts.accountIds, (a) => a.accountId),
      securities: SECURITIES.filter((s) => used.has(s.securityId)),
      transactions: txns,
    };
  }
}
