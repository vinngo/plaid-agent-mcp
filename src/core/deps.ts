import { config } from "../config.js";
import { getProvider } from "../providers/index.js";
import { getSnapshotStore } from "../storage/snapshots.js";
import type { ToolDeps } from "./tools.js";

/** Wires tools to the backends chosen by config (mock/Plaid, local/S3, file/Secrets Manager). */
export function defaultDeps(): ToolDeps {
  return {
    provider: getProvider(),
    snapshots: getSnapshotStore(),
    staleAfterHours: config.snapshots.staleAfterHours,
    now: () => new Date(),
  };
}
