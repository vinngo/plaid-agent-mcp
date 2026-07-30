# poke-plaid-mcp

A custom [MCP](https://modelcontextprotocol.io) server that hooks your investment
portfolio into [Poke](https://poke.com) via [Plaid](https://plaid.com).

> **Why this exists.** Poke can't see your Wealthsimple / brokerage portfolio —
> there's no public API and no built-in Plaid integration:
>
> So here it is. Link any brokerage/retirement account through Plaid once, point
> Poke at this server, and ask things like *"what's my portfolio worth?"*,
> *"what are my biggest winners?"*, or *"how much did I get in dividends this month?"*.

It works in two modes:

- **Mock mode** (default, no credentials needed) — serves a realistic sample
  Wealthsimple-style portfolio so you can wire up Poke and try every tool *right now*.
- **Plaid mode** — set `PLAID_CLIENT_ID` / `PLAID_SECRET` and link your real accounts.

---

## Tools exposed to Poke

| Tool | What it does |
| --- | --- |
| `check_connection` | Confirms the data source is connected and lists linked institutions. |
| `list_accounts` | All linked investment/brokerage/retirement accounts + last-known balances. |
| `get_balances` | Up-to-date balances (forces a fresh read from the institution when supported). |
| `portfolio_summary` | Net-worth-style snapshot: total value + unrealized gain/loss by currency, per-account breakdown, allocation by asset type, and top holdings. |
| `list_holdings` | Every position: ticker, name, quantity, price, market value, cost basis, unrealized gain/loss. Filter by account / min value; sort by value or gain. |
| `list_investment_transactions` | Buys, sells, dividends, contributions, fees, transfers over a date range. |
| `get_dividend_income` | Total dividends over a period, broken down by security and currency, plus each payment. |

All tools are **read-only** and never move money.

---

## Quick start (mock mode — 60 seconds)

```bash
npm install
npm run dev
```

The server starts on `http://localhost:3000`. Verify it end-to-end:

```bash
npm run test:mcp    # boots the server, drives it with a real MCP client, calls every tool
```

Then [connect it to Poke](#connecting-to-poke). Everything works with sample data
until you add Plaid credentials.

---

## Using your real portfolio (Plaid)

### 1. Get Plaid API keys

Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com) and grab
your **client_id** and **sandbox/production secret** from *Developers → Keys*.
Investments data requires the **Investments** product (request access in the
dashboard if it isn't already enabled).

### 2. Configure

```bash
cp .env.example .env
```

Fill in at least:

```ini
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret
PLAID_ENV=sandbox            # or: production
PLAID_PRODUCTS=investments
PLAID_COUNTRY_CODES=US,CA    # CA covers Wealthsimple
TOKEN_ENCRYPTION_KEY=<a long random string>   # encrypts access tokens at rest
MCP_API_KEY=<a random string>                  # require this key on the /mcp endpoint
```

### 3. Link an account

```bash
npm run dev
```

Open **http://localhost:3000/setup**, click **Connect**, and complete Plaid Link.
Your bank credentials go straight to Plaid — never to this server. The resulting
access token is encrypted and stored in `./data/items.json`.

> **Sandbox shortcut (no browser):** with `PLAID_ENV=sandbox` you can link a test
> institution from the CLI:
> ```bash
> npm run link:sandbox            # default sandbox institution
> npm run link:sandbox ins_XXXXX  # a specific one
> ```

You can link multiple institutions; all of them are aggregated across every tool.

---

## Connecting to Poke

Poke talks to this server over **Streamable HTTP at `/mcp`**. Pick one:

### Option A — Local tunnel (recommended for personal use)

Keeps your financial data and Plaid tokens on your machine. Start the server, then
in another terminal:

```bash
npx poke@latest tunnel http://localhost:3000/mcp -n "Plaid Portfolio"
```

Leave both running. Poke syncs the tools automatically. Say *"check my portfolio
connection"* in Poke to confirm.

### Option B — Hosted server

Deploy somewhere public (see [Deployment](#deployment)), then add it at
[poke.com/integrations/new](https://poke.com/integrations/new):

- **Name:** `Plaid Portfolio`
- **MCP Server URL:** `https://your-host.example.com/mcp`
- **API Key:** the value of `MCP_API_KEY` (sent as a Bearer token)

…or via the CLI:

```bash
npx poke@latest mcp add https://your-host.example.com/mcp -n "Plaid Portfolio" -k "$MCP_API_KEY"
```

### Option C — Shareable recipe (Poke Kitchen)

To package this for others, create a recipe at [poke.com/kitchen](https://poke.com/kitchen)
with this server as a required MCP integration and some onboarding context
(e.g. first message: *"What's my portfolio worth?"*).

---

## Deployment

Any host that runs a Node service works (Fly.io, Render, Railway, a VPS, …).

```bash
docker build -t poke-plaid-mcp .
docker run -p 3000:3000 --env-file .env -v "$PWD/data:/app/data" poke-plaid-mcp
```

The image sets `HOST=0.0.0.0` and `NODE_ENV=production`, so it **won't start without
`MCP_API_KEY`** (by design). For a hosted deployment set: `MCP_API_KEY`,
`TOKEN_ENCRYPTION_KEY`, `SETUP_TOKEN`, and `PUBLIC_BASE_URL=https://your-host`.
Then link accounts at `https://your-host/setup?token=YOUR_SETUP_TOKEN`.

> Persist `/app/data` (the volume above) so your linked-account tokens survive
> restarts. On platforms with an ephemeral filesystem, use a mounted disk/volume.

---

## Configuration reference

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/MCP port. |
| `HOST` | `127.0.0.1` | Bind interface. Loopback by default (LAN-safe, works with `poke tunnel`). Set `0.0.0.0` for containers/hosting. |
| `NODE_ENV` | `development` | In `production`, the server refuses to start if bound publicly without `MCP_API_KEY`, or using Plaid without `TOKEN_ENCRYPTION_KEY`. |
| `PUBLIC_BASE_URL` | `http://localhost:PORT` | Also seeds the Host/Origin allowlist. Set to your public URL when hosted. |
| `MCP_API_KEY` | *(empty)* | If set, `/mcp` requires `Authorization: Bearer <key>` (or `x-api-key`). **Required for internet-facing use.** |
| `SETUP_TOKEN` | *(empty)* | Token required to use `/setup*` (pass as `?token=`). **Required to expose setup on a public host.** |
| `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | *(empty)* | Extra allowlist entries (loopback + `PUBLIC_BASE_URL` are always allowed). |
| `ALLOW_ANY_HOST` | `false` | Disable Host-header allowlisting (behind a Host-rewriting proxy). Origin checks stay on. |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | *(empty)* | Leave blank for mock mode. |
| `PLAID_ENV` | `sandbox` | `sandbox` or `production`. |
| `PLAID_PRODUCTS` | `investments` | Comma-separated Plaid products. |
| `PLAID_COUNTRY_CODES` | `US,CA` | Comma-separated country codes. |
| `PLAID_APP_NAME` | `Poke Portfolio` | Shown in Plaid Link. |
| `TOKEN_STORE_PATH` | `./data/items.json` | Where encrypted tokens live. |
| `TOKEN_ENCRYPTION_KEY` | *(empty)* | AES-256-GCM key for tokens at rest. Required in production w/ Plaid. |

---

## Security

This server touches your financial data, so it's locked down by default:

- **Read-only.** No tool can move money — only account/holding/transaction reads.
- **Loopback by default.** Binds to `127.0.0.1`, so a local install is never exposed
  to your LAN. `poke tunnel` still reaches it. Hosting requires `HOST=0.0.0.0`.
- **`/mcp` auth** via `MCP_API_KEY` (timing-safe Bearer check). In `production`, the
  server refuses to start if bound publicly without a key.
- **`/setup*` auth** via `SETUP_TOKEN`. Without a token, setup is only reachable from
  localhost (and disabled entirely on a public host).
- **DNS-rebinding / cross-origin protection.** Requests with a disallowed `Origin`
  are rejected, and the `Host` header is allowlisted — a malicious website in your
  browser can't drive the server. Server-to-server callers (Poke, the tunnel) are
  unaffected.
- **Tokens encrypted at rest** with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`); token file
  is written `0600`. The `data/` dir is git-ignored — never commit it.
- **Secrets are redacted** from logs. Your bank login is entered in Plaid Link and
  never touches this server. TLS is provided by the tunnel / your host.
- `npm audit`: 0 known vulnerabilities.

For an internet-facing deployment, set **all** of: `HOST=0.0.0.0`, `NODE_ENV=production`,
`MCP_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `SETUP_TOKEN`, and `PUBLIC_BASE_URL`.

---

## How it works

```
Poke ──HTTP(S) /mcp──▶  Express + MCP (Streamable HTTP, stateless)
                             │
                             ▼
                        PortfolioProvider
                        ┌────────────┴────────────┐
                     PlaidProvider            MockProvider
                     (real Plaid API)      (sample portfolio)
```

The MCP tool layer is provider-agnostic: it always receives normalized
holdings/accounts/transactions, so swapping mock ↔ Plaid changes nothing about the
tools Poke sees.

### Project structure

```
src/
  index.ts              # bootstrap
  server.ts             # Express app: /mcp (auth), /health, /setup
  mcp.ts                # MCP server + tool definitions
  portfolio-math.ts     # portfolio + dividend aggregation (pure functions)
  config.ts             # env config, mock/plaid mode selection
  logger.ts             # redacting JSON logger
  store.ts              # encrypted access-token storage
  providers/
    types.ts            # normalized domain types + PortfolioProvider interface
    plaid.ts            # Plaid client, normalization, Link helpers
    mock.ts             # realistic sample data
    index.ts            # provider selection
  routes/link.ts        # Plaid Link setup endpoints
  public/setup.html     # Plaid Link setup UI
scripts/
  sandbox-link.ts       # link a Plaid sandbox institution (no browser)
  test-mcp.ts           # end-to-end MCP smoke test
```

---

## Notes on Wealthsimple

Wealthsimple has no public portfolio API, which is the whole reason for this server.
Plaid's coverage of Wealthsimple's *investments* data varies by account type and
region — if Plaid can link your Wealthsimple account with the Investments product,
this server surfaces it. If not, you can link any other Plaid-supported brokerage,
and the mock mode always works for building/testing the Poke experience.

## License

MIT
