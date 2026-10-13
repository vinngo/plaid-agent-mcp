// Development-only Link helpers, used by scripts/sandbox-link.ts. They are not
// exposed as MCP tools: in the deployed system the Next.js web app owns Plaid
// Link and the public-token exchange, and the MCP server stays read-only.

import { getPlaidClient, toCountryCodes, toProducts } from "../providers/plaid.js";
import { config } from "../config.js";
import { getTokenStore, type StoredItem } from "../storage/tokens.js";

export async function resolveInstitutionName(institutionId: string | null | undefined): Promise<string> {
  if (!institutionId) return "Unknown institution";
  try {
    const res = await getPlaidClient().institutionsGetById({
      institution_id: institutionId,
      country_codes: toCountryCodes(config.plaid.countryCodes),
    });
    return res.data.institution.name;
  } catch {
    return institutionId;
  }
}

/**
 * The already-linked Item for an institution, if any. Matches on institutionId;
 * items stored before the id was recorded fall back to matching by name.
 */
export function findExistingItem(
  items: StoredItem[],
  institutionId: string,
  institutionName: string,
): StoredItem | undefined {
  return (
    items.find((i) => i.institutionId === institutionId) ??
    items.find((i) => !i.institutionId && i.institution === institutionName)
  );
}

export async function exchangePublicToken(
  publicToken: string,
  institutionName?: string,
  institutionId?: string,
): Promise<StoredItem> {
  const exchange = await getPlaidClient().itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchange.data.access_token;
  const itemId = exchange.data.item_id;

  let institution = institutionName ?? "";
  if (!institution) {
    const itemRes = await getPlaidClient().itemGet({ access_token: accessToken });
    institutionId = itemRes.data.item.institution_id ?? institutionId;
    institution = await resolveInstitutionName(institutionId);
  }

  const stored: StoredItem = {
    itemId,
    institution: institution || "Unknown institution",
    institutionId,
    linkedAt: new Date().toISOString(),
    accessToken,
  };
  await getTokenStore().upsert(stored);
  return stored;
}

/** Sandbox-only: create a linked item without going through Link in a browser. */
export async function createSandboxItem(institutionId: string, institutionName?: string): Promise<StoredItem> {
  const pub = await getPlaidClient().sandboxPublicTokenCreate({
    institution_id: institutionId,
    initial_products: toProducts(config.plaid.products),
  });
  const institution = institutionName ?? (await resolveInstitutionName(institutionId));
  return exchangePublicToken(pub.data.public_token, institution, institutionId);
}
