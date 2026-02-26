# authe.me — OpenClaw Trust Scoring Plugin

Agent observability for OpenClaw. Hooks into lifecycle events, scores each run across 4 dimensions, and flags problems in your logs.

Works locally with zero config. Optionally sends data to [dashboard.authe.me](https://dashboard.authe.me) for history and fleet views.

## What it does

On every message cycle, the plugin:

1. **Captures** LLM calls (model, tokens, cost, latency) and tool executions
2. **Scores** the run across 4 dimensions: reliability, scope adherence, cost efficiency, latency efficiency
3. **Flags** specific problems with explanations and suggested fixes
4. **Logs** the score directly in your OpenClaw output

```
[authe.me] Trust Score: 72  (reliability=100 | scope=50 | cost=85 | latency=75)
🟡 [scope_adherence] Tool "shell_exec" not in allowed list
   → Add "shell_exec" to allowedTools config or investigate why it was called
🟡 [latency_efficiency] 2/5 LLM calls exceeded 30000ms
   → Check model provider latency or reduce prompt size
```

## Install

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "autheme": {
        "enabled": true,
        "config": {
          "agentId": "my-agent",
          "allowedTools": ["read", "write", "search", "browser"],
          "costAlertThreshold": 0.50,
          "latencyAlertThreshold": 30000,
          "logLocally": true,
          "verbose": false
        }
      }
    }
  }
}
```

That's it. No API key needed. Scores appear in your logs immediately.

## Optional: Dashboard reporting

To send run data to the authe.me dashboard for history, trends, and fleet-level views:

```json
{
  "plugins": {
    "entries": {
      "autheme": {
        "enabled": true,
        "config": {
          "apiKey": "your-autheme-api-key",
          "agentId": "my-agent",
          "allowedTools": ["read", "write", "search"]
        }
      }
    }
  }
}
```

Get an API key at [dashboard.authe.me](https://dashboard.authe.me).

API reporting is fire-and-forget (async, batched) and never blocks the agent.

## Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiKey` | string | — | authe.me API key. Omit for local-only mode |
| `endpoint` | string | `https://api.authe.me/v1/actions` | API ingest endpoint |
| `agentId` | string | `"default"` | Identifier for this agent (useful for fleets) |
| `allowedTools` | string[] | `[]` | Tools the agent may use. Empty = no scope checking |
| `costAlertThreshold` | number | `0.50` | USD cost per run before flagging |
| `latencyAlertThreshold` | number | `30000` | ms per LLM call before flagging |
| `logLocally` | boolean | `true` | Print scores to OpenClaw logs |
| `verbose` | boolean | `false` | Log every individual action |

## Scoring dimensions

| Dimension | What it measures | How it's computed |
|-----------|-----------------|-------------------|
| **Reliability** | Did the run complete without errors? | 100 unless error stop reason detected |
| **Scope adherence** | Did the agent stay within allowed tools? | `(1 - violations/totalToolCalls) × 100` |
| **Cost efficiency** | Was the run cost reasonable? | `100 / (cost / threshold)` when over threshold |
| **Latency efficiency** | Were LLM calls fast enough? | `(1 - slowCalls/totalCalls) × 100` |

**Overall** = reliability × 0.3 + scope × 0.3 + cost × 0.2 + latency × 0.2

## What gets sent to the API (when enabled)

```json
{
  "agent_id": "my-agent",
  "session_key": "agent:main:main",
  "run_id": "run_1234567890",
  "started_at": "2026-02-26T10:00:00Z",
  "completed_at": "2026-02-26T10:00:05Z",
  "actions": [
    {
      "type": "llm_call",
      "timestamp": "2026-02-26T10:00:01Z",
      "model": "claude-sonnet-4-5-20250929",
      "tokens": 1247,
      "cost": 0.0031,
      "latencyMs": 2400
    },
    {
      "type": "tool_call",
      "timestamp": "2026-02-26T10:00:03Z",
      "toolName": "shell_exec",
      "scopeViolation": true
    }
  ],
  "trust_score": {
    "overall": 72,
    "dimensions": {
      "reliability": 100,
      "scopeAdherence": 50,
      "costEfficiency": 85,
      "latencyEfficiency": 75
    },
    "flags": [
      {
        "severity": "warning",
        "dimension": "scope_adherence",
        "message": "Tool \"shell_exec\" not in allowed list",
        "action": "Add \"shell_exec\" to allowedTools or investigate"
      }
    ]
  },
  "summary": {
    "total_tokens": 1247,
    "total_cost": 0.0031,
    "tool_calls": 1,
    "scope_violations": 1,
    "avg_latency_ms": 2400
  }
}
```

Privacy: only action metadata is sent. Message content is never captured or transmitted.

## Disable

Set `"enabled": false` in your plugin config or remove the entry entirely.

## License

MIT
