// Local entry point over stdio: `npm run mcp:stdio`. Logs go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "../config.js";
import { defaultDeps } from "../core/deps.js";
import { log } from "../logger.js";
import { buildMcpServer } from "./mcp.js";

const server = buildMcpServer(defaultDeps());
await server.connect(new StdioServerTransport());
log.info("plaid-agent MCP (stdio) ready", { provider: config.providerKind, snapshots: config.snapshots.kind });
