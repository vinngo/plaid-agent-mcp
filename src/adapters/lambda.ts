// AgentCore Gateway Lambda target. One function serves every tool:
//   - event   = the tool's arguments
//   - context.clientContext.custom.bedrockAgentCoreToolName = "<target>___<tool>"
// See https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html
//
// Gateway has no isError flag for Lambda targets, so expected failures are
// returned as { error: {...} } for the agent to read; unexpected ones throw.

import type { Context } from "aws-lambda";
import { defaultDeps } from "../core/deps.js";
import { runTool, type ToolDeps } from "../core/tools.js";
import { log } from "../logger.js";

const DELIMITER = "___";
let deps: ToolDeps | null = null; // reused across warm invocations

export function toolNameFrom(context: Pick<Context, "clientContext">): string | undefined {
  const cc = context.clientContext as unknown as { Custom?: Record<string, string>; custom?: Record<string, string> } | undefined;
  const full = cc?.Custom?.bedrockAgentCoreToolName ?? cc?.custom?.bedrockAgentCoreToolName;
  if (!full) return undefined;
  const i = full.indexOf(DELIMITER);
  return i >= 0 ? full.slice(i + DELIMITER.length) : full;
}

export async function handler(event: unknown, context: Context, injected?: ToolDeps): Promise<unknown> {
  const tool = toolNameFrom(context);
  if (!tool) {
    return { error: { message: "Missing bedrockAgentCoreToolName in client context.", code: "BAD_INVOCATION" } };
  }
  const d = injected ?? (deps ??= defaultDeps());
  const started = Date.now();
  const outcome = await runTool(tool, event ?? {}, d);
  log.info("tool call", { tool, ok: outcome.ok, ms: Date.now() - started, ...(outcome.ok ? {} : { code: outcome.error.code }) });
  return outcome.ok ? outcome.data : { error: outcome.error };
}
