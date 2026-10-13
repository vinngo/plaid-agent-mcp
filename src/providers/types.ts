// Normalized, provider-agnostic portfolio types. Both the Plaid provider and
// the mock provider return these shapes so the MCP tool layer never has to know
// which backend produced the data.

export interface Account {
  itemId: string;
  accountId: string;
  institution: string;
  name: string;
  officialName?: string;
  mask?: string;
  type: string; // e.g. "investment", "depository"
  subtype?: string; // e.g. "brokerage", "ira", "tfsa"
  currentBalance?: number;
  availableBalance?: number;
  currency?: string;
}

export interface Security {
  securityId: string;
  name?: string;
  ticker?: string;
  type?: string; // equity, etf, mutual fund, cash, fixed income, ...
  closePrice?: number;
  closePriceAsOf?: string;
  currency?: string;
  isCashEquivalent?: boolean;
}

export interface Holding {
  itemId: string;
  accountId: string;
  accountName: string;
  institution: string;
  securityId: string;
  ticker?: string;
  name?: string;
  type?: string;
  quantity: number;
  price: number; // per-share price in account currency
  priceAsOf?: string;
  value: number; // market value = quantity * price
  costBasis?: number; // total cost basis for the position
  currency?: string;
  unrealizedGain?: number; // value - costBasis
  unrealizedGainPct?: number; // unrealizedGain / costBasis
  isCashEquivalent?: boolean;
}

export interface InvestmentTransaction {
  investmentTransactionId: string;
  itemId: string;
  accountId: string;
  accountName: string;
  institution: string;
  securityId?: string;
  ticker?: string;
  name?: string; // description
  date: string; // YYYY-MM-DD
  type: string; // buy, sell, cash, fee, transfer, cancel
  subtype: string; // dividend, contribution, interest, ...
  quantity: number;
  amount: number; // positive = money out of account (buy), negative = money in
  price?: number;
  fees?: number;
  currency?: string;
}

export interface HoldingsResult {
  accounts: Account[];
  holdings: Holding[];
  securities: Security[];
  /** itemId -> when the provider last refreshed investments data (ISO). */
  itemsAsOf: Record<string, string>;
}

export interface TransactionsResult {
  accounts: Account[];
  securities: Security[];
  transactions: InvestmentTransaction[];
}

export interface LinkedItemInfo {
  itemId: string;
  institution: string;
  linkedAt: string;
  accounts: number;
}

export interface QueryOptions {
  /** Restrict to a subset of normalized account IDs. */
  accountIds?: string[];
}

export interface TransactionQueryOptions extends QueryOptions {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

/**
 * A source of investment-portfolio data. Implemented by PlaidProvider (real)
 * and MockProvider (sample data for local testing / pre-Plaid onboarding).
 */
export interface PortfolioProvider {
  readonly kind: "plaid" | "mock";

  /** True once at least one institution has been linked and is queryable. */
  isReady(): Promise<boolean>;

  /** Metadata about linked institutions (for diagnostics / setup checks). */
  listLinkedItems(): Promise<LinkedItemInfo[]>;

  listAccounts(): Promise<Account[]>;

  /** Real-time balances (forces a refresh when the backend supports it). */
  getBalances(opts?: QueryOptions): Promise<Account[]>;

  getHoldings(opts?: QueryOptions): Promise<HoldingsResult>;

  getInvestmentTransactions(opts: TransactionQueryOptions): Promise<TransactionsResult>;
}
