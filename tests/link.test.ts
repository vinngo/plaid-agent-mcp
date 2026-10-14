import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExistingItem, findExistingItem } from "../src/plaid/link.js";
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

test("checkExistingItem fails closed for legacy items when the name lookup failed", () => {
  const legacy = item("item-old", "First Platypus Bank");
  assert.deepEqual(checkExistingItem([legacy], "ins_109508", null), { status: "unverified", legacyItems: [legacy] });
});

test("checkExistingItem still matches by id or name and clears when nothing matches", () => {
  const withId = item("item-new", "First Platypus Bank", "ins_109508");
  assert.deepEqual(checkExistingItem([withId], "ins_109508", null), { status: "linked", item: withId });
  const legacy = item("item-old", "First Platypus Bank");
  assert.deepEqual(checkExistingItem([legacy], "ins_109508", "First Platypus Bank"), { status: "linked", item: legacy });
  assert.deepEqual(checkExistingItem([legacy], "ins_1", "Other Bank"), { status: "clear" });
  // With no legacy items, a failed lookup has nothing left to verify.
  assert.deepEqual(checkExistingItem([item("item-a", "Other Bank", "ins_1")], "ins_109508", null), { status: "clear" });
  assert.deepEqual(checkExistingItem([], "ins_109508", null), { status: "clear" });
});
