/**
 * One-shot helper to link a Plaid *sandbox* institution without a browser.
 *
 *   npm run link:sandbox            # uses default sandbox institution
 *   npm run link:sandbox ins_XXXXX  # link a specific sandbox institution
 *   npm run link:sandbox -- --force # link again even if already linked
 *
 * Refuses to link an institution that is already in the token store: a
 * duplicate Item doubles every account and holding and uses up an Item slot.
 *
 * Requires PLAID_CLIENT_ID / PLAID_SECRET with PLAID_ENV=sandbox in your .env.
 */
import { config } from "../src/config.js";
import { checkExistingItem, createSandboxItem, lookupInstitutionName } from "../src/plaid/link.js";
import { extractPlaidError } from "../src/providers/plaid.js";
import { getTokenStore } from "../src/storage/tokens.js";

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

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const institutionId = args.find((a) => !a.startsWith("--")) ?? DEFAULT_INSTITUTION;

  try {
    const institutionName = await lookupInstitutionName(institutionId);
    const check = checkExistingItem(await getTokenStore().list(), institutionId, institutionName);
    if (check.status === "linked" && !force) {
      console.error(
        `✗ "${check.item.institution}" is already linked (item ${check.item.itemId}). ` +
          "Linking it again would duplicate every account. Re-run with --force to link anyway.",
      );
      process.exit(1);
    }
    if (check.status === "unverified" && !force) {
      const legacy = check.legacyItems.map((i) => `"${i.institution}" (item ${i.itemId})`).join(", ");
      console.error(
        `✗ Couldn't look up the name of ${institutionId} from Plaid, so it can't be checked against items ` +
          `stored without an institution id: ${legacy}. Re-run when Plaid is reachable, or with --force to link anyway.`,
      );
      process.exit(1);
    }

    console.log(`Creating sandbox item for ${institutionId} (products: ${config.plaid.products.join(", ")})…`);
    const item = await createSandboxItem(institutionId, institutionName ?? undefined);
    console.log(`✓ Linked "${item.institution}" (item ${item.itemId}).`);
    console.log("  Try it: npm run smoke");
  } catch (err) {
    const info = extractPlaidError(err);
    console.error(`✗ Failed: ${info.message}${info.code ? ` (${info.code})` : ""}`);
    process.exit(1);
  }
}

void main();
