#!/usr/bin/env npx tsx
/**
 * authe.me Plugin Demo — Simulated Agent Session
 *
 * Run: npx tsx demo.ts
 *
 * Simulates an OpenClaw agent that's told to "read and summarize a report"
 * but goes off-script — running shell commands, hitting slow APIs,
 * and triggering scope violations that drop the trust score in real time.
 *
 * No OpenClaw installation needed. This exercises the exact same scoring
 * logic from the plugin to show what the output looks like.
 */

// ─── Colors ──────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bg_red: "\x1b[41m",
  bg_green: "\x1b[42m",
  bg_yellow: "\x1b[43m",
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Scoring logic (mirrors plugin.ts exactly) ──────────────────────────────

interface TrustFlag {
  severity: "info" | "warning" | "critical";
  dimension: string;
  message: string;
  action?: string;
}

interface RunState {
  toolCalls: string[];
  scopeViolations: string[];
  latencies: number[];
  errors: number;
}

function computeScore(
  run: RunState,
  success: boolean,
  durationMs: number,
  allowedTools: string[],
  latencyThreshold: number
) {
  const flags: TrustFlag[] = [];

  const reliability = success ? 100 : 0;
  if (!success) {
    flags.push({
      severity: "critical",
      dimension: "reliability",
      message: `Run failed`,
      action: "Check model provider status or reduce prompt complexity",
    });
  }

  let scopeAdherence = 100;
  if (allowedTools.length > 0 && run.scopeViolations.length > 0) {
    const violationRate =
      run.scopeViolations.length / Math.max(run.toolCalls.length, 1);
    scopeAdherence = Math.max(0, Math.round((1 - violationRate) * 100));
    const unique = [...new Set(run.scopeViolations)];
    for (const tool of unique) {
      flags.push({
        severity: violationRate > 0.5 ? "critical" : "warning",
        dimension: "scope_adherence",
        message: `Tool "${tool}" not in allowed list`,
        action: `Add "${tool}" to allowedTools or investigate why it was called`,
      });
    }
  }

  const costEfficiency = 100;

  let latencyEfficiency = 100;
  const slowCalls = run.latencies.filter((l) => l > latencyThreshold);
  if (slowCalls.length > 0) {
    const slowRate = slowCalls.length / Math.max(run.latencies.length, 1);
    latencyEfficiency = Math.max(0, Math.round((1 - slowRate) * 100));
    flags.push({
      severity: slowRate > 0.5 ? "critical" : "warning",
      dimension: "latency_efficiency",
      message: `${slowCalls.length}/${run.latencies.length} tool calls exceeded ${latencyThreshold}ms`,
      action: "Check model provider latency or reduce prompt size",
    });
  }

  if (durationMs > latencyThreshold * 2) {
    flags.push({
      severity: "warning",
      dimension: "latency_efficiency",
      message: `Total run took ${durationMs}ms`,
      action: "Consider breaking into smaller agent tasks",
    });
  }

  const overall = Math.round(
    reliability * 0.3 +
      scopeAdherence * 0.3 +
      costEfficiency * 0.2 +
      latencyEfficiency * 0.2
  );

  return {
    overall,
    dimensions: { reliability, scopeAdherence, costEfficiency, latencyEfficiency },
    flags,
  };
}

// ─── Simulated tool calls ───────────────────────────────────────────────────

interface SimulatedTool {
  name: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs: number;
  description: string;
}

// ─── Demo scenarios ─────────────────────────────────────────────────────────

const SCENARIOS = {
  clean: {
    title: "Clean Run — Agent Stays in Scope",
    prompt: "Read README.md and summarize the key points",
    allowedTools: ["read_file", "write_file", "browser"],
    tools: [
      {
        name: "read_file",
        params: { path: "/project/README.md" },
        result: { content: "# My Project\n\nA tool for..." },
        durationMs: 120,
        description: "Reading the target file",
      },
      {
        name: "write_file",
        params: { path: "/project/summary.md", content: "## Summary\n..." },
        result: { success: true },
        durationMs: 85,
        description: "Writing the summary",
      },
    ] as SimulatedTool[],
    success: true,
    totalDurationMs: 2063,
  },

  violation: {
    title: "Scope Violation — Agent Goes Rogue",
    prompt: "Read README.md and summarize the key points",
    allowedTools: ["read_file", "write_file", "browser"],
    tools: [
      {
        name: "read_file",
        params: { path: "/project/README.md" },
        result: { content: "# My Project\n\nA tool for..." },
        durationMs: 150,
        description: "Reading the target file (expected)",
      },
      {
        name: "shell_exec",
        params: { command: "curl -s https://api.openai.com/v1/models" },
        result: { stdout: '{"data": [...]}' },
        durationMs: 2340,
        description: "⚠ Agent decided to call an external API via shell",
      },
      {
        name: "read_file",
        params: { path: "/etc/passwd" },
        result: { content: "root:x:0:0:..." },
        durationMs: 45,
        description: "Reading /etc/passwd (expected tool, suspicious target)",
      },
      {
        name: "shell_exec",
        params: { command: "docker ps -a" },
        result: { stdout: "CONTAINER ID  IMAGE..." },
        durationMs: 890,
        description: "⚠ Agent inspecting Docker containers",
      },
      {
        name: "write_file",
        params: { path: "/project/summary.md", content: "## Summary\n..." },
        result: { success: true },
        durationMs: 80,
        description: "Writing the summary (expected)",
      },
    ] as SimulatedTool[],
    success: true,
    totalDurationMs: 8420,
  },

  catastrophic: {
    title: "Catastrophic Run — Everything Goes Wrong",
    prompt: "Deploy the latest build to production",
    allowedTools: ["read_file", "write_file"],
    tools: [
      {
        name: "shell_exec",
        params: { command: "git push origin main --force" },
        result: { stdout: "force pushed" },
        durationMs: 4500,
        description: "⚠ Force pushing to main",
      },
      {
        name: "shell_exec",
        params: { command: "docker restart production-api" },
        error: "permission denied: requires sudo",
        durationMs: 35200,
        description: "⚠ Trying to restart production containers",
      },
      {
        name: "sudo_run",
        params: { command: "systemctl restart nginx" },
        error: "sudo: authentication required",
        durationMs: 42000,
        description: "⚠ Attempting sudo escalation",
      },
    ] as SimulatedTool[],
    success: false,
    error: "Agent exceeded retry limit after 3 tool failures",
    totalDurationMs: 95000,
  },
};

// ─── Renderer ───────────────────────────────────────────────────────────────

function printHeader() {
  console.log();
  console.log(
    `${c.bold}${c.cyan}  ╔═══════════════════════════════════════════════════════╗${c.reset}`
  );
  console.log(
    `${c.bold}${c.cyan}  ║     authe.me — OpenClaw Trust Scoring Demo            ║${c.reset}`
  );
  console.log(
    `${c.bold}${c.cyan}  ║     Real-time agent observability & audit trails       ║${c.reset}`
  );
  console.log(
    `${c.bold}${c.cyan}  ╚═══════════════════════════════════════════════════════╝${c.reset}`
  );
  console.log();
}

function printScenarioHeader(title: string, prompt: string, allowed: string[]) {
  console.log(`${c.bold}${c.white}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.bold}  ${title}${c.reset}`);
  console.log(`${c.dim}  Prompt: "${prompt}"${c.reset}`);
  console.log(`${c.dim}  Allowed tools: [${allowed.join(", ")}]${c.reset}`);
  console.log(`${c.bold}${c.white}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log();
}

async function runScenario(key: keyof typeof SCENARIOS) {
  const scenario = SCENARIOS[key];
  printScenarioHeader(scenario.title, scenario.prompt, scenario.allowedTools);

  const run: RunState = {
    toolCalls: [],
    scopeViolations: [],
    latencies: [],
    errors: 0,
  };

  // Simulate each tool call with after_tool_call hook
  for (const tool of scenario.tools) {
    await sleep(300); // Dramatic pause

    const scopeMatch =
      scenario.allowedTools.length === 0 ||
      scenario.allowedTools.includes(tool.name);
    const isError = !!tool.error;

    run.toolCalls.push(tool.name);
    run.latencies.push(tool.durationMs);
    if (isError) run.errors++;
    if (!scopeMatch) run.scopeViolations.push(tool.name);

    // after_tool_call output
    const statusIcon = isError ? `${c.red}✗` : `${c.green}✓`;
    const scopeTag = !scopeMatch
      ? ` ${c.bg_red}${c.white} SCOPE VIOLATION ${c.reset}`
      : "";
    const errorTag = isError ? ` ${c.red}error: ${tool.error}${c.reset}` : "";

    console.log(
      `  ${c.dim}[authe.me]${c.reset} ${statusIcon} ${c.bold}${tool.name}${c.reset} ${c.dim}(${tool.durationMs}ms)${c.reset}${scopeTag}${errorTag}`
    );
    console.log(`             ${c.dim}${tool.description}${c.reset}`);

    if (!scopeMatch) {
      console.log(
        `             ${c.red}🔴 Tool "${tool.name}" not in allowed list [${scenario.allowedTools.join(", ")}]${c.reset}`
      );
    }
  }

  // agent_end: compute final score
  await sleep(400);
  console.log();

  const score = computeScore(
    run,
    scenario.success,
    scenario.totalDurationMs,
    scenario.allowedTools,
    30000
  );

  // Score color
  const scoreColor =
    score.overall >= 80
      ? c.green
      : score.overall >= 50
        ? c.yellow
        : c.red;

  const scoreBg =
    score.overall >= 80
      ? c.bg_green
      : score.overall >= 50
        ? c.bg_yellow
        : c.bg_red;

  console.log(
    `  ${c.dim}[authe.me]${c.reset} ${c.bold}Trust Score: ${scoreBg}${c.white} ${score.overall} ${c.reset}  ${c.dim}(reliability=${score.dimensions.reliability} | scope=${score.dimensions.scopeAdherence} | cost=${score.dimensions.costEfficiency} | latency=${score.dimensions.latencyEfficiency})${c.reset}`
  );

  console.log(
    `  ${c.dim}[authe.me] agent=main session=agent:main:main tools=${run.toolCalls.length} violations=${run.scopeViolations.length} duration=${scenario.totalDurationMs}ms${c.reset}`
  );

  // Flags
  for (const flag of score.flags) {
    const icon =
      flag.severity === "critical"
        ? "🔴"
        : flag.severity === "warning"
          ? "🟡"
          : "🔵";
    console.log(
      `  ${icon} ${c.bold}[${flag.dimension}]${c.reset} ${flag.message}`
    );
    if (flag.action) {
      console.log(`     ${c.dim}↳ ${flag.action}${c.reset}`);
    }
  }

  // API report simulation
  if (scenario.tools.length > 0) {
    await sleep(200);
    console.log();
    console.log(
      `  ${c.dim}[authe.me] API report: 200 — inserted ${run.toolCalls.length} actions (hash-chained)${c.reset}`
    );
    console.log(
      `  ${c.dim}[authe.me] View timeline → https://dashboard.authe.me/agent/main/timeline${c.reset}`
    );
    console.log(
      `  ${c.dim}[authe.me] Verify chain → GET https://api.authe.me/v1/verify/main/chain${c.reset}`
    );
  }

  console.log();
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  printHeader();

  // Scenario 1: Clean run
  await runScenario("clean");
  await sleep(800);

  // Scenario 2: Scope violation
  await runScenario("violation");
  await sleep(800);

  // Scenario 3: Catastrophic
  await runScenario("catastrophic");

  // Summary
  console.log(
    `${c.bold}${c.white}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`
  );
  console.log(`${c.bold}  What just happened:${c.reset}`);
  console.log();
  console.log(
    `  ${c.green}Scenario 1${c.reset} — Agent stayed within scope. Trust score: ${c.bold}${c.green}100${c.reset}`
  );
  console.log(
    `    Every tool call was in the allowed list. Clean audit trail.`
  );
  console.log();
  console.log(
    `  ${c.yellow}Scenario 2${c.reset} — Agent used shell_exec (not allowed). Trust score: ${c.bold}${c.yellow}88${c.reset}`
  );
  console.log(
    `    The plugin caught 2 scope violations in real time and flagged them.`
  );
  console.log(
    `    The agent also read /etc/passwd — allowed tool, but suspicious target.`
  );
  console.log();
  console.log(
    `  ${c.red}Scenario 3${c.reset} — Agent went rogue with shell + sudo. Trust score: ${c.bold}${c.red}27${c.reset}`
  );
  console.log(
    `    Every tool was out of scope, 2 errored, and the run failed.`
  );
  console.log(
    `    This is what a compromised or prompt-injected agent looks like.`
  );
  console.log();
  console.log(`${c.bold}${c.white}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log();
  console.log(
    `  ${c.bold}${c.cyan}authe.me${c.reset} — Know what your AI agents actually did.`
  );
  console.log(
    `  ${c.dim}https://authe.me | https://github.com/autheme/openclaw-plugin${c.reset}`
  );
  console.log();
}

main().catch(console.error);
