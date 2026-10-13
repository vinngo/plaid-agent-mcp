/**
 * Emit the AgentCore Gateway Lambda target's inline tool schema from the tool
 * registry, so tool definitions live in exactly one place.
 *
 *   npm run gateway:schema   ->  gateway/tools.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { TOOLS } from "../src/core/tools.js";

const schema = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
mkdirSync("gateway", { recursive: true });
writeFileSync("gateway/tools.json", `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Wrote gateway/tools.json (${schema.length} tools: ${schema.map((t) => t.name).join(", ")})`);
