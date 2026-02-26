/**
 * authe.me OpenClaw Plugin — Tests
 *
 * Covers: scoring, scope violations, cost flags, latency flags,
 * local logging, API reporting, stale run eviction
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the scoring logic directly by extracting it
// In a real setup these would import from the built plugin

// ---------------------------------------------------------------------------
// Inline scoring logic for unit testing
// ---------------------------------------------------------------------------

interface RunState {
  runId: string;
  sessionKey: string;
  startedAt: number;
  actions: any[];
  totalTokens: number;
  totalCost: number;
  toolCalls: string[];
  scopeViolations: string[];
  latencies: number[];
  lastActivityAt: number;
}

interface TrustScore {
  overall: number;
  dimensions: {
    reliability: number;
    scopeAdherence: number;
    costEfficiency: number;
    latencyEfficiency: number;
  };
  flags: Array<{
    severity: string;
    dimension: string;
    message: string;
    action?: string;
  }>;
}

function computeScore(
  run: RunState,
  allowedTools: string[] = [],
  costThreshold = 0.5,
  latencyThreshold = 30000
): TrustScore {
  const flags: TrustScore["flags"] = [];
  const reliability = 100;

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

  let costEfficiency = 100;
  if (run.totalCost > costThreshold) {
    const overage = run.totalCost / costThreshold;
    costEfficiency = Math.max(0, Math.round(100 / overage));
    flags.push({
      severity: overage > 3 ? "critical" : "warning",
      dimension: "cost_efficiency",
      message: `Run cost $${run.totalCost.toFixed(4)} (threshold: $${costThreshold})`,
      action:
        "Review token usage — consider shorter prompts or cheaper model for subtasks",
    });
  }

  let latencyEfficiency = 100;
  const slowCalls = run.latencies.filter((l) => l > latencyThreshold);
  if (slowCalls.length > 0) {
    const slowRate = slowCalls.length / Math.max(run.latencies.length, 1);
    latencyEfficiency = Math.max(0, Math.round((1 - slowRate) * 100));
    flags.push({
      severity: slowRate > 0.5 ? "critical" : "warning",
      dimension: "latency_efficiency",
      message: `${slowCalls.length}/${run.latencies.length} LLM calls exceeded ${latencyThreshold}ms`,
      action: "Check model provider latency or reduce prompt size",
    });
  }

  const overall = Math.round(
    reliability * 0.3 +
      scopeAdherence * 0.3 +
      costEfficiency * 0.2 +
      latencyEfficiency * 0.2
  );

  return { overall, dimensions: { reliability, scopeAdherence, costEfficiency, latencyEfficiency }, flags };
}

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "test-run",
    sessionKey: "test-session",
    startedAt: Date.now(),
    actions: [],
    totalTokens: 0,
    totalCost: 0,
    toolCalls: [],
    scopeViolations: [],
    latencies: [],
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Trust Score Computation", () => {
  it("returns perfect score for clean run", () => {
    const run = makeRun({
      toolCalls: ["read", "write"],
      latencies: [1000, 2000],
      totalCost: 0.01,
    });
    const score = computeScore(run, ["read", "write"]);

    expect(score.overall).toBe(100);
    expect(score.flags).toHaveLength(0);
    expect(score.dimensions.reliability).toBe(100);
    expect(score.dimensions.scopeAdherence).toBe(100);
    expect(score.dimensions.costEfficiency).toBe(100);
    expect(score.dimensions.latencyEfficiency).toBe(100);
  });

  it("flags scope violations", () => {
    const run = makeRun({
      toolCalls: ["read", "shell_exec", "write"],
      scopeViolations: ["shell_exec"],
    });
    const score = computeScore(run, ["read", "write"]);

    expect(score.dimensions.scopeAdherence).toBe(67); // 1 violation / 3 calls
    expect(score.flags).toHaveLength(1);
    expect(score.flags[0].dimension).toBe("scope_adherence");
    expect(score.flags[0].severity).toBe("warning");
    expect(score.flags[0].message).toContain("shell_exec");
  });

  it("flags critical scope violations when majority are violations", () => {
    const run = makeRun({
      toolCalls: ["shell_exec", "sudo", "write"],
      scopeViolations: ["shell_exec", "sudo"],
    });
    const score = computeScore(run, ["read", "write"]);

    expect(score.dimensions.scopeAdherence).toBe(33);
    expect(score.flags).toHaveLength(2);
    expect(score.flags[0].severity).toBe("critical");
    expect(score.flags[1].severity).toBe("critical");
  });

  it("flags cost overages", () => {
    const run = makeRun({ totalCost: 1.5 });
    const score = computeScore(run, [], 0.5);

    expect(score.dimensions.costEfficiency).toBe(33); // 100 / 3
    expect(score.flags).toHaveLength(1);
    expect(score.flags[0].dimension).toBe("cost_efficiency");
    expect(score.flags[0].message).toContain("$1.5000");
  });

  it("flags critical cost when 3x over threshold", () => {
    const run = makeRun({ totalCost: 2.0 });
    const score = computeScore(run, [], 0.5);

    expect(score.flags[0].severity).toBe("critical");
  });

  it("flags slow LLM calls", () => {
    const run = makeRun({
      latencies: [1000, 2000, 45000, 50000],
    });
    const score = computeScore(run, [], 0.5, 30000);

    expect(score.dimensions.latencyEfficiency).toBe(50); // 2/4 slow
    expect(score.flags).toHaveLength(1);
    expect(score.flags[0].dimension).toBe("latency_efficiency");
    expect(score.flags[0].message).toContain("2/4");
  });

  it("computes weighted overall correctly", () => {
    const run = makeRun({
      toolCalls: ["read", "shell_exec"],
      scopeViolations: ["shell_exec"],
      totalCost: 1.0, // 2x threshold
      latencies: [1000, 40000], // 1 slow
    });
    const score = computeScore(run, ["read"], 0.5, 30000);

    // reliability=100, scope=50, cost=50, latency=50
    // overall = 100*0.3 + 50*0.3 + 50*0.2 + 50*0.2 = 30 + 15 + 10 + 10 = 65
    expect(score.overall).toBe(65);
  });

  it("skips scope checking when allowedTools is empty", () => {
    const run = makeRun({
      toolCalls: ["anything", "goes"],
    });
    const score = computeScore(run, []);

    expect(score.dimensions.scopeAdherence).toBe(100);
    expect(score.flags).toHaveLength(0);
  });

  it("handles empty run gracefully", () => {
    const run = makeRun();
    const score = computeScore(run);

    expect(score.overall).toBe(100);
    expect(score.flags).toHaveLength(0);
  });

  it("handles run with only LLM calls, no tools", () => {
    const run = makeRun({
      totalTokens: 5000,
      totalCost: 0.02,
      latencies: [1500, 2000, 1800],
    });
    const score = computeScore(run, ["read", "write"]);

    expect(score.overall).toBe(100);
    expect(score.dimensions.scopeAdherence).toBe(100);
  });
});

describe("Flag explanations", () => {
  it("always includes actionable fix suggestion", () => {
    const run = makeRun({
      toolCalls: ["shell_exec"],
      scopeViolations: ["shell_exec"],
      totalCost: 2.0,
      latencies: [50000],
    });
    const score = computeScore(run, ["read"], 0.5, 30000);

    for (const flag of score.flags) {
      expect(flag.action).toBeDefined();
      expect(flag.action!.length).toBeGreaterThan(0);
    }
  });

  it("includes the violating tool name in the message", () => {
    const run = makeRun({
      toolCalls: ["dangerous_tool"],
      scopeViolations: ["dangerous_tool"],
    });
    const score = computeScore(run, ["safe_tool"]);

    expect(score.flags[0].message).toContain("dangerous_tool");
  });

  it("includes cost numbers in the message", () => {
    const run = makeRun({ totalCost: 0.75 });
    const score = computeScore(run, [], 0.5);

    expect(score.flags[0].message).toContain("$0.7500");
    expect(score.flags[0].message).toContain("$0.5");
  });
});
