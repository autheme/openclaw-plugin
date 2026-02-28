/**
 * authe.me OpenClaw Plugin v0.2.0
 *
 * Real-time agent trust scoring and observability.
 * Hooks into agent lifecycle to capture every tool call, LLM request,
 * and scope violation — then reports to api.authe.me with hash-chained audit trails.
 *
 * Hooks used:
 *   - after_tool_call: captures each tool execution (name, params, result, duration, errors)
 *   - agent_end: finalizes the run, computes trust score, and ships to API
 *
 * Local-first: always logs to OpenClaw's subsystem logger.
 * Optional remote: if apiKey + agentToken are set, reports to api.authe.me.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

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

interface CapturedAction {
  type: string;
  tool: string;
  status: string;
  durationMs: number;
  scopeMatch: boolean;
  timestamp: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  sessionId: string;
}

// ─── In-memory run state (per session) ───────────────────────────────────────

const activeRuns = new Map<string, {
  sessionKey: string;
  startedAt: number;
  actions: CapturedAction[];
  toolCalls: string[];
  scopeViolations: string[];
  latencies: number[];
  errors: number;
}>();

// ─── Plugin ──────────────────────────────────────────────────────────────────

const plugin = {
  id: "autheme",
  name: "authe.me Trust Scoring",
  description: "Real-time agent trust scoring and tamper-proof audit trails",

  register(api: OpenClawPluginApi) {
    const config = (api as any).pluginConfig ?? {};
    const {
      apiEndpoint = "https://api.authe.me",
      agentToken = "",
      allowedTools = [] as string[],
      latencyThreshold = 30000,
      logLocally = true,
      verbose = false,
    } = config;

    const logger = api.logger ?? console;

    // ─── after_tool_call: capture every tool execution in real time ───────

    api.on("after_tool_call", async (event: ToolCallEvent, ctx: HookContext) => {
      try {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const toolName = event.toolName ?? "unknown";

        // Get or create run state
        if (!activeRuns.has(sessionKey)) {
          activeRuns.set(sessionKey, {
            sessionKey,
            startedAt: Date.now(),
            actions: [],
            toolCalls: [],
            scopeViolations: [],
            latencies: [],
            errors: 0,
          });
        }

        const run = activeRuns.get(sessionKey)!;
        const duration = event.durationMs ?? 0;
        const isError = !!event.error;
        const scopeMatch = allowedTools.length === 0 || allowedTools.includes(toolName);

        // Track
        run.toolCalls.push(toolName);
        run.latencies.push(duration);
        if (isError) run.errors++;
        if (!scopeMatch) run.scopeViolations.push(toolName);

        // Capture action for API submission
        run.actions.push({
          type: "tool_call",
          tool: toolName,
          status: isError ? "error" : "success",
          durationMs: duration,
          scopeMatch,
          timestamp: new Date().toISOString(),
          input: sanitize(event.params),
          output: isError
            ? { error: event.error }
            : sanitize(event.result),
          sessionId: sessionKey,
        });

        // Real-time scope violation alert
        if (!scopeMatch && logLocally) {
          logger.warn?.(
            `[authe.me] 🔴 SCOPE VIOLATION: tool "${toolName}" not in allowed list`
          );
        }

        if (verbose && logLocally) {
          const status = isError ? "✗" : "✓";
          logger.info?.(
            `[authe.me] ${status} ${toolName} (${duration}ms)${!scopeMatch ? " [SCOPE VIOLATION]" : ""}`
          );
        }
      } catch (err) {
        logger.warn?.(`[authe.me] after_tool_call hook error: ${err}`);
      }
    }, { priority: -10 });

    // ─── agent_end: finalize run, compute score, report ──────────────────

    api.on("agent_end", async (event: AgentEndEvent, ctx: HookContext) => {
      try {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const agentName = ctx.agentId ?? "default";
        const run = activeRuns.get(sessionKey);

        // Also extract tool calls from message content (fallback for tools
        // that might not fire after_tool_call, e.g. if the bridge gap exists)
        const messageTools = extractToolsFromMessages(event.messages);
        const additionalTools: string[] = [];

        if (run) {
          for (const t of messageTools) {
            if (!run.toolCalls.includes(t)) {
              additionalTools.push(t);
              run.toolCalls.push(t);
              const scopeMatch = allowedTools.length === 0 || allowedTools.includes(t);
              if (!scopeMatch) run.scopeViolations.push(t);
              run.actions.push({
                type: "tool_call",
                tool: t,
                status: "success",
                durationMs: 0,
                scopeMatch,
                timestamp: new Date().toISOString(),
                input: {},
                output: {},
                sessionId: sessionKey,
              });
            }
          }
        }

        // Compute trust score
        const flags: TrustFlag[] = [];
        const totalTools = run?.toolCalls.length ?? messageTools.length;
        const totalViolations = run?.scopeViolations.length ?? 0;
        const totalErrors = run?.errors ?? (event.success ? 0 : 1);
        const totalLatencies = run?.latencies ?? [];

        // Reliability (30%)
        const reliability = event.success ? 100 : 0;
        if (!event.success) {
          flags.push({
            severity: "critical",
            dimension: "reliability",
            message: `Run failed: ${event.error ?? "unknown error"}`,
            action: "Check model provider status or reduce prompt complexity",
          });
        }

        // Scope adherence (30%)
        let scopeAdherence = 100;
        if (allowedTools.length > 0 && totalViolations > 0) {
          const violationRate = totalViolations / Math.max(totalTools, 1);
          scopeAdherence = Math.max(0, Math.round((1 - violationRate) * 100));
          const unique = [...new Set(run?.scopeViolations ?? [])];
          for (const tool of unique) {
            flags.push({
              severity: violationRate > 0.5 ? "critical" : "warning",
              dimension: "scope_adherence",
              message: `Tool "${tool}" not in allowed list`,
              action: `Add "${tool}" to allowedTools or investigate why it was called`,
            });
          }
        }

        // Cost efficiency (20%) — placeholder until llm_output provides token data
        const costEfficiency = 100;

        // Latency efficiency (20%)
        let latencyEfficiency = 100;
        const slowCalls = totalLatencies.filter((l) => l > latencyThreshold);
        if (slowCalls.length > 0) {
          const slowRate = slowCalls.length / Math.max(totalLatencies.length, 1);
          latencyEfficiency = Math.max(0, Math.round((1 - slowRate) * 100));
          flags.push({
            severity: slowRate > 0.5 ? "critical" : "warning",
            dimension: "latency_efficiency",
            message: `${slowCalls.length}/${totalLatencies.length} tool calls exceeded ${latencyThreshold}ms`,
            action: "Check model provider latency or reduce prompt size",
          });
        }

        // Overall run duration check
        if (event.durationMs > latencyThreshold * 2) {
          flags.push({
            severity: "warning",
            dimension: "latency_efficiency",
            message: `Total run took ${event.durationMs}ms`,
            action: "Consider breaking into smaller agent tasks",
          });
        }

        // Weighted overall
        const overall = Math.round(
          reliability * 0.30 +
          scopeAdherence * 0.30 +
          costEfficiency * 0.20 +
          latencyEfficiency * 0.20
        );

        // ─── Local logging ───
        if (logLocally) {
          const dims = [
            `reliability=${reliability}`,
            `scope=${scopeAdherence}`,
            `cost=${costEfficiency}`,
            `latency=${latencyEfficiency}`,
          ].join(" | ");

          logger.info?.(`[authe.me] Trust Score: ${overall}  (${dims})`);
          logger.info?.(
            `[authe.me] agent=${agentName} session=${sessionKey} tools=${totalTools} violations=${totalViolations} duration=${event.durationMs}ms`
          );

          for (const flag of flags) {
            const icon =
              flag.severity === "critical" ? "🔴" :
              flag.severity === "warning" ? "🟡" : "🔵";
            logger.info?.(`${icon} [${flag.dimension}] ${flag.message}`);
            if (flag.action) logger.info?.(`   → ${flag.action}`);
          }
        }

        // ─── API reporting ───
        if (agentToken && run && run.actions.length > 0) {
          const payload = {
            agent_id: agentName,
            actions: run.actions.map((a) => ({
              session_id: a.sessionId,
              type: a.type as string,
              tool: a.tool,
              input: a.input,
              output: a.output,
              status: a.status as string,
              duration_ms: a.durationMs,
              timestamp: a.timestamp,
              signature: "",
            })),
          };

          fetch(`${apiEndpoint}/v1/ingest`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${agentToken}`,
            },
            body: JSON.stringify(payload),
          })
            .then(async (res) => {
              if (verbose && logLocally) {
                const body = await res.json().catch(() => ({}));
                logger.info?.(
                  `[authe.me] API report: ${res.status} — inserted ${(body as any).inserted ?? "?"} actions`
                );
              }
            })
            .catch((err) => {
              if (verbose && logLocally) {
                logger.warn?.(`[authe.me] API report failed: ${err}`);
              }
            });
        }

        // Cleanup run state
        activeRuns.delete(sessionKey);

        // Evict stale runs (older than 1 hour)
        const now = Date.now();
        for (const [key, r] of activeRuns) {
          if (now - r.startedAt > 3600000) activeRuns.delete(key);
        }
      } catch (err) {
        logger.warn?.(`[authe.me] agent_end hook error: ${err}`);
      }
    }, { priority: -10 });

    logger.info?.(
      "[authe.me] Trust scoring plugin registered (hooks: after_tool_call, agent_end)"
    );
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractToolsFromMessages(
  messages: AgentEndEvent["messages"]
): string[] {
  const tools: string[] = [];
  for (const msg of messages ?? []) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.name) {
          tools.push(block.name);
        }
      }
    }
  }
  return tools;
}

function sanitize(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  try {
    const str = JSON.stringify(data);
    // Truncate large payloads to avoid bloating the API
    if (str.length > 10000) {
      return { _truncated: true, _size: str.length };
    }
    return data as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default plugin;
