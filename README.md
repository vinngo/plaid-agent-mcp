# plaid-agent-mcp

Read-only Plaid investment tools for the plaid-agent: a personal Q&A agent over
Fidelity and Robinhood accounts. Tools pull data from Plaid, write canonical CSV
snapshots, and hand the agent S3 keys instead of rows, so bulk data never passes
through the model's context.

Forked from [zayedu/poke-plaid-mcp](https://github.com/zayedu/poke-plaid-mcp) (MIT).

## Layout

```
src/core/        tool registry, canonical CSV schema, snapshot layout, summary
src/adapters/    mcp.ts (shared server) · http.ts · stdio.ts · lambda.ts (Gateway)
src/providers/   Plaid and mock data sources behind one interface
src/storage/     tokens: encrypted file | Secrets Manager · snapshots: local dir | S3
src/plaid/       dev-only Link helpers for scripts/sandbox-link.ts (not exposed as tools)
```

Every tool is defined once in `src/core/tools.ts`. Locally it's served over MCP;
in AWS the same code runs as one Lambda behind AgentCore Gateway, and
`gateway/tools.json` (generated) is the target's inline schema.

## Tools

| Tool | Returns |
|---|---|
| `snapshot_status` | Age and key of the latest holdings/transactions snapshots, per-account Plaid `as_of`, stale flag. Never calls Plaid. |
| `list_accounts` | Investment accounts with broker, type, mask, balance (inline JSON) |
| `portfolio_summary` | Total value, cash, allocation, top holdings, unrealized gain over positions with cost basis (inline JSON) |
| `pull_holdings` | Writes `holdings.csv` + `accounts.json`; returns `{s3_key, as_of, row_count, total_value}` |
| `pull_transactions(start_date?, end_date?)` | Writes `transactions.csv` (default last 90 days); returns `{s3_key, as_of, row_count}` |

Snapshot layout (same keys locally and in S3):

```
snapshots/<YYYY-MM-DDTHHMM>/holdings.csv
snapshots/<YYYY-MM-DDTHHMM>/transactions.csv
snapshots/<YYYY-MM-DDTHHMM>/accounts.json
latest.json        newest holdings and transactions pointers
```

Only Plaid accounts of type `investment` appear in `list_accounts`,
`accounts.json` and `snapshot_status`. Checking, credit and loan accounts on the
same login are dropped, and so are depository accounts such as a Fidelity cash
management account. Money-market sweeps inside a brokerage account still appear
as holdings.

`holdings.csv`: `as_of, broker, account_id, account_type, ticker, security_name,
security_type, quantity, price, market_value, cost_basis` (empty when unknown).

`transactions.csv`: `date, broker, account_id, ticker, type, quantity, price,
amount, fees, subtype, description`. `type` is buy, sell, dividend, interest,
fee, transfer or other. `amount` keeps Plaid's sign: positive means cash left the
account.

## Run locally

```bash
npm install
npm test             # all tools through both adapters, on mock data
npm run smoke        # call every tool once and print results + the CSV
npm run dev          # streamable HTTP at http://127.0.0.1:3000/mcp
npm run mcp:stdio    # same tools over stdio
```

No `.env` needed for mock mode. For Plaid Sandbox, set `PLAID_CLIENT_ID`,
`PLAID_SECRET` and `TOKEN_ENCRYPTION_KEY`, then `npm run link:sandbox`.

## Deploy (AgentCore Gateway)

```bash
npm run build:lambda     # dist-lambda/index.mjs, handler = index.handler (Node 20+)
npm run gateway:schema   # gateway/tools.json for the Lambda target
```

Inside Lambda the defaults switch to `TOKEN_STORE=secrets-manager` and
`SNAPSHOT_STORE=s3`; set `SNAPSHOT_BUCKET`, `PLAID_CLIENT_ID`, `PLAID_SECRET`,
`PLAID_ENV`. The function role needs:

- `secretsmanager:ListSecrets` (account-wide; metadata only) and
  `secretsmanager:GetSecretValue` on `plaid-agent/items/*`
- `s3:GetObject` / `s3:PutObject` on `snapshots/*` and `latest.json`
- outbound HTTPS to `*.plaid.com` only (see VPC note below)

Tokens are one secret per linked Item so the web app can write tokens without
being able to read existing ones. Each secret carries an `institution-id` tag,
which the web app reads to refuse linking an institution twice. Its role needs:

- `secretsmanager:CreateSecret` and `secretsmanager:TagResource` on
  `plaid-agent/items/*` (tags are set in `CreateSecret`, which requires both)
- `secretsmanager:ListSecrets` (account-wide; metadata only, no secret values)

`npm run link:sandbox` writes the same tag, so Items linked from either side
are visible to the duplicate check. Run it with credentials that also allow
`TagResource`.

## Changes from upstream

- Removed Poke integration, Render deploy, Dockerfile, the Express setup/Link
  routes and `PLAID_ITEMS` env seeding. Link now belongs to the web app.
- Token storage: encrypted local file (dev) or Secrets Manager, one secret per Item.
  The local store no longer falls back to a hard-coded key.
- Replaced `list_holdings` / `list_investment_transactions` / `get_balances` /
  `get_dividend_income` / `check_connection` with the snapshot tools above.
- Fixed unrealized gain in the portfolio summary: upstream summed value over all
  positions but cost over only those with a basis, counting the rest as pure gain.
- Mock data is now Fidelity + Robinhood in USD, including a position with no
  cost basis.

## Not done yet

- VPC + egress restriction so the Lambda can only reach Plaid, S3 and Secrets Manager.
- Infrastructure as code (Gateway, Lambda, bucket, roles).
- Fork audit before real accounts: pin a commit, `npm audit`, review egress and logging.
