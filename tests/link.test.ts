import { test } from "node:test";
import assert from "node:assert/strict";
import { findExistingItem } from "../src/plaid/link.js";
import type { StoredItem } from "../src/storage/tokens.js";

const item = (itemId: string, institution: string, institutionId?: string): StoredItem => ({
  itemId,
  institution,
  institutionId,
  linkedAt: "2026-10-13T00:00:00.000Z",
  accessToken: `access-${itemId}`,
});

test("findExistingItem matches on institutionId", () => {
  const items = [item("item-a", "Other Bank", "ins_1"), item("item-b", "Renamed Bank", "ins_109508")];
  assert.equal(findExistingItem(items, "ins_109508", "First Platypus Bank")?.itemId, "item-b");
});

test("findExistingItem falls back to name for items stored without an id", () => {
  const items = [item("item-old", "First Platypus Bank")];
  assert.equal(findExistingItem(items, "ins_109508", "First Platypus Bank")?.itemId, "item-old");
});

test("findExistingItem returns undefined when nothing matches", () => {
  const items = [item("item-a", "Other Bank", "ins_1"), item("item-b", "Another Bank")];
  assert.equal(findExistingItem(items, "ins_109508", "First Platypus Bank"), undefined);
  // A same-named item with a different recorded id is a different institution.
  assert.equal(findExistingItem([item("item-c", "First Platypus Bank", "ins_2")], "ins_109508", "First Platypus Bank"), undefined);
});
