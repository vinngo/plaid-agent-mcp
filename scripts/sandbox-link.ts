/**
 * One-shot helper to link a Plaid *sandbox* institution without a browser.
 *
 *   npm run link:sandbox            # uses default sandbox institution
 *   npm run link:sandbox ins_XXXXX  # link a specific sandbox institution
 *
 * Requires PLAID_CLIENT_ID / PLAID_SECRET with PLAID_ENV=sandbox in your .env.
 */
import { config } from "../src/config.js";
import { createSandboxItem } from "../src/plaid/link.js";
import { extractPlaidError } from "../src/providers/plaid.js";

// First Platypus Bank — the default Plaid sandbox institution (supports investments).
const DEFAULT_INSTITUTION = "ins_109508";

async function main(): Promise<void> {
  if (config.providerKind !== "plaid") {
    console.error("✗ No Plaid credentials found. Set PLAID_CLIENT_ID and PLAID_SECRET in .env first.");
    process.exit(1);
  }
  if (config.plaid.env !== "sandbox") {
    console.error(`✗ PLAID_ENV is '${config.plaid.env}'. This script only works in sandbox.`);
    process.exit(1);
  }

  const institutionId = process.argv[2] ?? DEFAULT_INSTITUTION;
  console.log(`Creating sandbox item for ${institutionId} (products: ${config.plaid.products.join(", ")})…`);

  try {
    const item = await createSandboxItem(institutionId);
    console.log(`✓ Linked "${item.institution}" (item ${item.itemId}).`);
    console.log("  Try it: npm run smoke");
  } catch (err) {
    const info = extractPlaidError(err);
    console.error(`✗ Failed: ${info.message}${info.code ? ` (${info.code})` : ""}`);
    process.exit(1);
  }
}

void main();
