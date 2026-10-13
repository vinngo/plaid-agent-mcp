// Snapshot layout from the spec:
//
//   snapshots/<YYYY-MM-DDTHHMM>/holdings.csv
//   snapshots/<YYYY-MM-DDTHHMM>/transactions.csv
//   snapshots/<YYYY-MM-DDTHHMM>/accounts.json
//   latest.json   pointer to the newest snapshot of each kind
//
// Holdings and transactions are pulled independently, so latest.json tracks
// each kind separately rather than pointing at one folder.

import type { SnapshotStore } from "../storage/snapshots.js";
import type { AccountMeta } from "./canonical.js";

export const LATEST_KEY = "latest.json";

export interface HoldingsPointer {
  key: string;
  accounts_key: string;
  pulled_at: string;
  row_count: number;
  total_value: number;
  accounts: AccountMeta[];
}

export interface TransactionsPointer {
  key: string;
  pulled_at: string;
  start_date: string;
  end_date: string;
  row_count: number;
}

export interface Latest {
  version: 1;
  holdings?: HoldingsPointer;
  transactions?: TransactionsPointer;
}

/** 2026-10-13T22:41:07Z -> 2026-10-13T2241 (UTC). */
export function snapshotId(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

export async function readLatest(store: SnapshotStore): Promise<Latest> {
  const raw = await store.get(LATEST_KEY);
  if (!raw) return { version: 1 };
  try {
    const parsed = JSON.parse(raw) as Latest;
    return parsed && parsed.version === 1 ? parsed : { version: 1 };
  } catch {
    return { version: 1 };
  }
}

// Read-modify-write without locking: fine for one user, but two concurrent
// pulls of different kinds could drop one pointer. Re-pulling fixes it.
export async function updateLatest(store: SnapshotStore, patch: Partial<Omit<Latest, "version">>): Promise<Latest> {
  const next: Latest = { ...(await readLatest(store)), ...patch, version: 1 };
  await store.put(LATEST_KEY, `${JSON.stringify(next, null, 2)}\n`, "application/json");
  return next;
}
