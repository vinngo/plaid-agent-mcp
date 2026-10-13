// MCP server over the tool registry, for local development. The agent talks to
// this over stdio or streamable HTTP; in AWS the same tools sit behind Gateway.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, runTool, type ToolDeps } from "../core/tools.js";

export function buildMcpServer(deps: ToolDeps): Server {
  const server = new Server(
    { name: "plaid-agent-portfolio", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Read-only access to the user's Fidelity and Robinhood accounts via Plaid. Check snapshot_status first; " +
        "pull_holdings / pull_transactions write CSV snapshots and return S3 keys for sandbox analysis.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.name !== "pull_holdings" && t.name !== "pull_transactions", openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const outcome = await runTool(req.params.name, req.params.arguments ?? {}, deps);
    const payload = outcome.ok ? outcome.data : { error: outcome.error };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: !outcome.ok };
  });

  return server;
}
