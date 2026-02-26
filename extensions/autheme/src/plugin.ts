/**
 * authe.me OpenClaw Plugin
 *
 * Uses the real OpenClaw plugin SDK register(api) pattern.
 * Hooks into agent_end to compute trust scores and optionally report to API.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

interface AgentEndEvent {
  messages: Array<{
    role: string;
    content?: string | Array<{ type: string; name?: string; input?: any; text?: string }>;
  }>;
  success: boolean;
  error?: string;
  durationMs: number;
}

interface HookContext {
  agentId: string;
  sessionKey?: string;
  workspaceDir?: string;
}

interface TrustFlag {
  severity: "info" | "warning" | "critical";
  dimension: string;
  message: string;
  action?: string;
}

const plugin = {
  id: "openclaw-plugin",
  name: "authe.me Trust Scoring",
  description: "Agent trust scoring and observability — local scores in logs, optional dashboard reporting",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const config = (api as any).pluginConfig ?? {};
    const {
      apiKey = "",
      endpoint = "https://dashboard.authe.me/v1/runs/ingest",
      agentId: configAgentId = "default",
      allowedTools = [] as string[],
      costAlertThreshold = 0.50,
      latencyAlertThreshold = 30000,
      logLocally = true,
      verbose = false,
    } = config;

    const logger = api.logger ?? console;

    // ─── agent_end hook ───
    api.on("agent_end", async (event: AgentEndEvent, ctx: HookContext) => {
      try {
        const messages = event.messages ?? [];
        const agentName = ctx.agentId ?? configAgentId;
        const sessionKey = ctx.sessionKey ?? "unknown";
        const runId = `run_${Date.now()}`;

        // Extract tool calls from assistant messages
        const toolCalls: string[] = [];
        const scopeViolations: string[] = [];

        for (const msg of messages) {
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "tool_use" && block.name) {
                toolCalls.push(block.name);
                if (allowedTools.length > 0 && !allowedTools.includes(block.name)) {
                  scopeViolations.push(block.name);
                }
              }
            }
          }
        }

        // ─── Scoring ───
        const flags: TrustFlag[] = [];

        // Reliability
        const reliability = event.success ? 100 : 0;
        if (!event.success) {
          flags.push({
            severity: "critical",
            dimension: "reliability",
            message: `Run failed: ${event.error ?? "unknown error"}`,
            action: "Check model provider status or reduce prompt complexity",
          });
        }

        // Scope adherence
        let scopeAdherence = 100;
        if (allowedTools.length > 0 && scopeViolations.length > 0) {
          const violationRate = scopeViolations.length / Math.max(toolCalls.length, 1);
          scopeAdherence = Math.max(0, Math.round((1 - violationRate) * 100));
          const uniqueViolations = [...new Set(scopeViolations)];
          for (const tool of uniqueViolations) {
            flags.push({
              severity: violationRate > 0.5 ? "critical" : "warning",
              dimension: "scope_adherence",
              message: `Tool "${tool}" not in allowed list`,
              action: `Add "${tool}" to allowedTools config or investigate why it was called`,
            });
          }
        }

        // Latency efficiency
        let latencyEfficiency = 100;
        if (event.durationMs > latencyAlertThreshold) {
          latencyEfficiency = Math.max(0, Math.round(100 * latencyAlertThreshold / event.durationMs));
          flags.push({
            severity: event.durationMs > latencyAlertThreshold * 3 ? "critical" : "warning",
            dimension: "latency_efficiency",
            message: `Run took ${event.durationMs}ms (threshold: ${latencyAlertThreshold}ms)`,
            action: "Check model provider latency or reduce prompt size",
          });
        }

        // Cost — we don't have cost data from agent_end, so default to 100
        const costEfficiency = 100;

        // Overall (weighted)
        const overall = Math.round(
          reliability * 0.3 +
          scopeAdherence * 0.3 +
          costEfficiency * 0.2 +
          latencyEfficiency * 0.2
        );

        // ─── Local logging ───
        if (logLocally) {
          const dims = `reliability=${reliability} | scope=${scopeAdherence} | cost=${costEfficiency} | latency=${latencyEfficiency}`;
          logger.info?.(`[authe.me] Trust Score: ${overall}  (${dims})`);

          for (const flag of flags) {
            const icon = flag.severity === "critical" ? "🔴" : flag.severity === "warning" ? "🟡" : "🔵";
            logger.info?.(`${icon} [${flag.dimension}] ${flag.message}`);
            if (flag.action) {
              logger.info?.(`   → ${flag.action}`);
            }
          }

          if (verbose) {
            logger.info?.(`[authe.me] agent=${agentName} session=${sessionKey} tools=${toolCalls.length} violations=${scopeViolations.length} duration=${event.durationMs}ms`);
          }
        }

        // ─── API reporting (fire-and-forget) ───
        if (apiKey) {
          const payload = {
            agent_id: agentName,
            session_key: sessionKey,
            run_id: runId,
            started_at: new Date(Date.now() - event.durationMs).toISOString(),
            completed_at: new Date().toISOString(),
            actions: toolCalls.map((name, i) => ({
              type: "tool_call",
              timestamp: new Date().toISOString(),
              toolName: name,
              scopeViolation: allowedTools.length > 0 && !allowedTools.includes(name),
            })),
            trust_score: {
              overall,
              dimensions: {
                reliability,
                scope_adherence: scopeAdherence,
                cost_efficiency: costEfficiency,
                latency_efficiency: latencyEfficiency,
              },
              flags,
            },
            summary: {
              total_tokens: 0,
              total_cost: 0,
              tool_calls: toolCalls.length,
              scope_violations: scopeViolations.length,
              avg_latency_ms: event.durationMs,
            },
          };

          fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
          }).catch((err) => {
            if (verbose) {
              logger.warn?.(`[authe.me] API report failed: ${err}`);
            }
          });
        }
      } catch (err) {
        logger.warn?.(`[authe.me] agent_end hook error: ${err}`);
      }
    }, { priority: -10 }); // low priority, run after other plugins

    logger.info?.("[authe.me] Trust scoring plugin registered (hooks: agent_end)");
  },
};

export default plugin;
