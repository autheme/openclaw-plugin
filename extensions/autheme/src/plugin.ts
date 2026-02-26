/**
 * authe.me OpenClaw Plugin
 *
 * Hooks into OpenClaw lifecycle events (llm_input, llm_output, after_tool_call,
 * message.processed) and:
 *   1. Computes a local trust score (visible in OpenClaw logs)
 *   2. Optionally forwards events to the authe.me API for full dashboard + history
 *
 * Design principles:
 *   - Value locally first: scores and flags print to OpenClaw logs even without an API key
 *   - No account friction: the plugin works standalone, API reporting is opt-in
 *   - Explainable scores: every flag tells you WHAT happened and WHY the score moved
 */

import type {
  PluginBase,
  PluginContext,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookAfterToolCallEvent,
} from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutheMeConfig {
  /** Optional API key — if omitted, plugin runs in local-only mode */
  apiKey?: string;
  /** authe.me ingest endpoint (default: https://dashboard.authe.me/v1/runs/ingest) */
  endpoint?: string;
  /** Agent identifier for multi-agent setups */
  agentId?: string;
  /** Tools the agent is allowed to use — scope violations get flagged */
  allowedTools?: string[];
  /** Cost alert threshold in USD per run (default: 0.50) */
  costAlertThreshold?: number;
  /** Latency alert threshold in ms per LLM call (default: 30000) */
  latencyAlertThreshold?: number;
  /** Print trust score to OpenClaw logs (default: true) */
  logLocally?: boolean;
  /** Enable verbose logging of every action (default: false) */
  verbose?: boolean;
}

interface RunState {
  runId: string;
  sessionKey: string;
  startedAt: number;
  actions: ActionRecord[];
  totalTokens: number;
  totalCost: number;
  toolCalls: string[];
  scopeViolations: string[];
  latencies: number[];
  lastActivityAt: number;
}

interface ActionRecord {
  type: "llm_call" | "tool_call" | "message_complete";
  timestamp: string;
  model?: string;
  tokens?: number;
  cost?: number;
  latencyMs?: number;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  scopeViolation?: boolean;
  metadata?: Record<string, unknown>;
}

interface TrustScore {
  overall: number;
  dimensions: {
    reliability: number;
    scopeAdherence: number;
    costEfficiency: number;
    latencyEfficiency: number;
  };
  flags: TrustFlag[];
}

interface TrustFlag {
  severity: "info" | "warning" | "critical";
  dimension: string;
  message: string;
  action?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_ENDPOINT = "https://dashboard.authe.me/v1/runs/ingest";
const DEFAULT_COST_THRESHOLD = 0.5;
const DEFAULT_LATENCY_THRESHOLD = 30000;
const STALE_RUN_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default function authemePlugin(config: AutheMeConfig): PluginBase {
  const {
    apiKey,
    endpoint = DEFAULT_ENDPOINT,
    agentId = "default",
    allowedTools = [],
    costAlertThreshold = DEFAULT_COST_THRESHOLD,
    latencyAlertThreshold = DEFAULT_LATENCY_THRESHOLD,
    logLocally = true,
    verbose = false,
  } = config;

  // In-memory run tracking (keyed by sessionKey)
  const runs = new Map<string, RunState>();
  let lastActiveSessionKey: string | null = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getOrCreateRun(sessionKey: string, runId: string): RunState {
    let run = runs.get(sessionKey);
    if (!run || run.runId !== runId) {
      run = {
        runId,
        sessionKey,
        startedAt: Date.now(),
        actions: [],
        totalTokens: 0,
        totalCost: 0,
        toolCalls: [],
        scopeViolations: [],
        latencies: [],
        lastActivityAt: Date.now(),
      };
      runs.set(sessionKey, run);
    }
    run.lastActivityAt = Date.now();
    return run;
  }

  function evictStaleRuns(): void {
    const now = Date.now();
    for (const [key, run] of runs) {
      if (now - run.lastActivityAt > STALE_RUN_TTL_MS) {
        runs.delete(key);
      }
    }
  }

  function resolveSessionKey(context: Record<string, unknown>): string {
    return (
      (context.sessionKey as string) ||
      lastActiveSessionKey ||
      "unknown"
    );
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  function computeScore(run: RunState): TrustScore {
    const flags: TrustFlag[] = [];

    // --- Reliability (did the run complete without errors?) ---
    // For v1 we assume reliability = 100 unless we detect an error stop reason
    const reliability = 100;

    // --- Scope Adherence ---
    let scopeAdherence = 100;
    if (allowedTools.length > 0 && run.scopeViolations.length > 0) {
      const violationRate =
        run.scopeViolations.length / Math.max(run.toolCalls.length, 1);
      scopeAdherence = Math.max(0, Math.round((1 - violationRate) * 100));

      for (const tool of run.scopeViolations) {
        flags.push({
          severity: violationRate > 0.5 ? "critical" : "warning",
          dimension: "scope_adherence",
          message: `Tool "${tool}" not in allowed list`,
          action: `Add "${tool}" to allowedTools config or investigate why it was called`,
        });
      }
    }

    // --- Cost Efficiency ---
    let costEfficiency = 100;
    if (run.totalCost > costAlertThreshold) {
      const overage = run.totalCost / costAlertThreshold;
      costEfficiency = Math.max(0, Math.round(100 / overage));
      flags.push({
        severity: overage > 3 ? "critical" : "warning",
        dimension: "cost_efficiency",
        message: `Run cost $${run.totalCost.toFixed(4)} (threshold: $${costAlertThreshold})`,
        action: "Review token usage — consider shorter prompts or cheaper model for subtasks",
      });
    }

    // --- Latency Efficiency ---
    let latencyEfficiency = 100;
    const slowCalls = run.latencies.filter(
      (l) => l > latencyAlertThreshold
    );
    if (slowCalls.length > 0) {
      const slowRate = slowCalls.length / Math.max(run.latencies.length, 1);
      latencyEfficiency = Math.max(0, Math.round((1 - slowRate) * 100));
      flags.push({
        severity: slowRate > 0.5 ? "critical" : "warning",
        dimension: "latency_efficiency",
        message: `${slowCalls.length}/${run.latencies.length} LLM calls exceeded ${latencyAlertThreshold}ms`,
        action: "Check model provider latency or reduce prompt size",
      });
    }

    // --- Overall (weighted) ---
    const overall = Math.round(
      reliability * 0.3 +
        scopeAdherence * 0.3 +
        costEfficiency * 0.2 +
        latencyEfficiency * 0.2
    );

    return {
      overall,
      dimensions: {
        reliability,
        scope_adherence: score.dimensions.scopeAdherence,
        costEfficiency,
        latencyEfficiency,
      },
      flags,
    };
  }

  // ---------------------------------------------------------------------------
  // Local logging
  // ---------------------------------------------------------------------------

  function logScore(run: RunState, score: TrustScore): void {
    if (!logLocally) return;

    const header = `[authe.me] Trust Score: ${score.overall}`;
    const dims = [
      `  reliability=${score.dimensions.reliability}`,
      `  scope=${score.dimensions.scopeAdherence}`,
      `  cost=${score.dimensions.costEfficiency}`,
      `  latency=${score.dimensions.latencyEfficiency}`,
    ].join(" | ");

    console.log(`${header}  (${dims})`);

    for (const flag of score.flags) {
      const icon =
        flag.severity === "critical"
          ? "🔴"
          : flag.severity === "warning"
            ? "🟡"
            : "🔵";
      console.log(`${icon} [${flag.dimension}] ${flag.message}`);
      if (flag.action) {
        console.log(`   → ${flag.action}`);
      }
    }
  }

  function logAction(label: string, detail: string): void {
    if (!verbose) return;
    console.log(`[authe.me] ${label}: ${detail}`);
  }

  // ---------------------------------------------------------------------------
  // Remote reporting (opt-in)
  // ---------------------------------------------------------------------------

  async function reportToApi(
    run: RunState,
    score: TrustScore
  ): Promise<void> {
    if (!apiKey) return;

    try {
      const payload = {
        agent_id: agentId,
        session_key: run.sessionKey,
        run_id: run.runId,
        started_at: new Date(run.startedAt).toISOString(),
        completed_at: new Date().toISOString(),
        actions: run.actions,
        trust_score: {
          overall: score.overall,
          dimensions: {
            reliability: score.dimensions.reliability,
            scope_adherence: score.dimensions.scopeAdherence,
            cost_efficiency: score.dimensions.costEfficiency,
            latency_efficiency: score.dimensions.latencyEfficiency,
          },
          flags: score.flags,
        },
        summary: {
          total_tokens: run.totalTokens,
          total_cost: run.totalCost,
          tool_calls: run.toolCalls.length,
          scope_violations: run.scopeViolations.length,
          avg_latency_ms: run.latencies.length
            ? Math.round(
                run.latencies.reduce((a, b) => a + b, 0) /
                  run.latencies.length
              )
            : 0,
        },
      };

      // Fire-and-forget — never block the agent
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      }).catch((err) => {
        if (verbose) {
          console.error(`[authe.me] API report failed: ${err.message}`);
        }
      });
    } catch {
      // Silently swallow — observability should never break the agent
    }
  }

  // ---------------------------------------------------------------------------
  // Hook handlers
  // ---------------------------------------------------------------------------

  return {
    name: "autheme",
    version: "0.1.0",

    hooks: {
      /**
       * llm_input — fires before every LLM call.
       * We start tracking the run and record the timestamp for latency measurement.
       */
      llm_input(event: PluginHookLlmInputEvent, context: PluginContext): void {
        evictStaleRuns();

        const sessionKey = resolveSessionKey(context as Record<string, unknown>);
        const runId = (context as Record<string, unknown>).runId as string || `run_${Date.now()}`;
        lastActiveSessionKey = sessionKey;

        const run = getOrCreateRun(sessionKey, runId);

        // Stash the start time on the context for latency calc in llm_output
        (context as Record<string, unknown>).__autheme_llm_start = Date.now();
        (context as Record<string, unknown>).__autheme_session_key = sessionKey;
        (context as Record<string, unknown>).__autheme_run_id = runId;

        logAction("llm_input", `model=${event.model} session=${sessionKey}`);
      },

      /**
       * llm_output — fires after every LLM call.
       * We record tokens, cost, latency, and check for error stop reasons.
       */
      llm_output(event: PluginHookLlmOutputEvent, context: PluginContext): void {
        const sessionKey =
          (context as Record<string, unknown>).__autheme_session_key as string ||
          resolveSessionKey(context as Record<string, unknown>);
        const runId =
          (context as Record<string, unknown>).__autheme_run_id as string || `run_${Date.now()}`;
        const startTime =
          (context as Record<string, unknown>).__autheme_llm_start as number || Date.now();

        const run = getOrCreateRun(sessionKey, runId);
        const latencyMs = Date.now() - startTime;

        const tokens =
          (event.usage?.inputTokens || 0) + (event.usage?.outputTokens || 0);
        const cost = event.usage?.cost || 0;

        run.totalTokens += tokens;
        run.totalCost += cost;
        run.latencies.push(latencyMs);

        run.actions.push({
          type: "llm_call",
          timestamp: new Date().toISOString(),
          model: event.model,
          tokens,
          cost,
          latencyMs,
          metadata: {
            inputTokens: event.usage?.inputTokens,
            outputTokens: event.usage?.outputTokens,
            stopReason: event.stopReason,
          },
        });

        logAction(
          "llm_output",
          `model=${event.model} tokens=${tokens} cost=$${cost.toFixed(4)} latency=${latencyMs}ms`
        );
      },

      /**
       * after_tool_call — fires after every tool execution.
       * We check scope adherence against allowedTools config.
       */
      after_tool_call(
        event: PluginHookAfterToolCallEvent,
        context: PluginContext
      ): void {
        const sessionKey = resolveSessionKey(context as Record<string, unknown>);
        const runId =
          (context as Record<string, unknown>).__autheme_run_id as string ||
          `run_${Date.now()}`;

        const run = getOrCreateRun(sessionKey, runId);
        const toolName = event.toolName || event.name || "unknown";

        run.toolCalls.push(toolName);

        // Scope check
        let scopeViolation = false;
        if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
          run.scopeViolations.push(toolName);
          scopeViolation = true;
        }

        run.actions.push({
          type: "tool_call",
          timestamp: new Date().toISOString(),
          toolName,
          toolParams: event.input as Record<string, unknown>,
          scopeViolation,
        });

        logAction(
          "tool_call",
          `tool=${toolName}${scopeViolation ? " ⚠️ SCOPE VIOLATION" : ""}`
        );
      },

      /**
       * message.processed — fires when a full message cycle completes.
       * We compute the trust score, log it locally, and optionally report to API.
       */
      "message.processed"(
        _event: unknown,
        context: PluginContext
      ): void {
        const sessionKey = resolveSessionKey(context as Record<string, unknown>);
        const run = runs.get(sessionKey);
        if (!run || run.actions.length === 0) return;

        const score = computeScore(run);
        logScore(run, score);
        reportToApi(run, score);
      },
    },
  };
}
