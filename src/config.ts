import "dotenv/config";

export type PlaidEnvName = "sandbox" | "production";
export type ProviderKind = "plaid" | "mock";
export type TokenStoreKind = "file" | "secrets-manager";
export type SnapshotStoreKind = "local" | "s3";

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const n = Number(str(name));
  return str(name) && Number.isFinite(n) ? n : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const v = str(name);
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = str(name).toLowerCase();
  if (!v) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`${name} must be one of: ${allowed.join(", ")} (got "${v}")`);
}

// Running inside Lambda flips the storage defaults to the AWS backends, so a
// deployed function never silently falls back to the local filesystem.
const inLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

const plaidClientId = str("PLAID_CLIENT_ID");
const plaidSecret = str("PLAID_SECRET");

export const config = {
  providerKind: (plaidClientId && plaidSecret ? "plaid" : "mock") as ProviderKind,
  plaid: {
    clientId: plaidClientId,
    secret: plaidSecret,
    env: oneOf<PlaidEnvName>("PLAID_ENV", ["sandbox", "production"], "sandbox"),
    products: list("PLAID_PRODUCTS", ["investments"]),
    countryCodes: list("PLAID_COUNTRY_CODES", ["US"]),
  },
  tokens: {
    kind: oneOf<TokenStoreKind>("TOKEN_STORE", ["file", "secrets-manager"], inLambda ? "secrets-manager" : "file"),
    filePath: str("TOKEN_STORE_PATH", "./data/items.json"),
    encryptionKey: str("TOKEN_ENCRYPTION_KEY"),
    // Each linked Item is its own secret under this prefix, so the web app can
    // create new ones without being able to read existing ones.
    secretPrefix: str("PLAID_TOKEN_SECRET_PREFIX", "plaid-agent/items/"),
  },
  snapshots: {
    kind: oneOf<SnapshotStoreKind>("SNAPSHOT_STORE", ["local", "s3"], inLambda ? "s3" : "local"),
    localDir: str("SNAPSHOT_DIR", "./data/store"),
    bucket: str("SNAPSHOT_BUCKET"),
    staleAfterHours: num("STALE_AFTER_HOURS", 12),
  },
  http: {
    port: num("PORT", 3000),
    host: str("HOST", "127.0.0.1"),
    apiKey: str("MCP_API_KEY"),
  },
};

export type AppConfig = typeof config;
