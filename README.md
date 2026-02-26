# authe.me — Trust Scoring Plugin for OpenClaw

Real-time trust scoring for OpenClaw agents. Hooks into the agent lifecycle to compute a composite trust score after every run, with optional reporting to a remote API.

## What it does

After each agent run completes, the plugin evaluates four dimensions and produces a weighted trust score (0–100):

| Dimension | Weight | What it measures |
|---|---|---|
| **Reliability** | 30% | Did the run succeed or fail? |
| **Scope adherence** | 30% | Did the agent only use allowed tools? |
| **Cost efficiency** | 20% | Token/cost budget compliance |
| **Latency efficiency** | 20% | Response time vs. threshold |

Scores and flags are logged locally via OpenClaw's subsystem logger. If an API key is configured, run data is also posted to a remote endpoint for historical tracking.

```
[authe.me] Trust Score: 100  (reliability=100 | scope=100 | cost=100 | latency=100)
[authe.me] agent=main session=agent:main:main tools=0 violations=0 duration=2063ms
```

When scope violations occur:

```
[authe.me] Trust Score: 73  (reliability=100 | scope=50 | cost=100 | latency=70)
🟡 [scope_adherence] Tool "dangerous_exec" not in allowed list
   → Add "dangerous_exec" to allowedTools config or investigate why it was called
🟡 [latency_efficiency] Run took 45000ms (threshold: 30000ms)
   → Check model provider latency or reduce prompt size
```

## Install

Clone this repo and add the plugin path to your OpenClaw config:

```bash
git clone https://github.com/autheme/openclaw-plugin.git
```

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-plugin/extensions/autheme"
      ]
    },
    "entries": {
      "openclaw-plugin": {
        "enabled": true,
        "config": {
          "agentId": "my-agent",
          "allowedTools": ["read", "write", "search", "fetch"],
          "latencyAlertThreshold": 30000,
          "verbose": true
        }
      }
    }
  }
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

Verify the plugin loaded:

```bash
openclaw plugins doctor
```

You should see `authe.me Trust Scoring` with status `loaded`.

## Configuration

All config fields are optional. The plugin works in local-only mode with zero config.

| Field | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string | — | API key for remote reporting. Omit for local-only logging. |
| `endpoint` | string | `https://api.authe.me/v1/runs/ingest` | Remote API endpoint |
| `agentId` | string | `"default"` | Agent identifier for reporting |
| `allowedTools` | string[] | `[]` | Tool allowlist. Empty = all tools allowed. |
| `costAlertThreshold` | number | `0.50` | Cost alert threshold (USD) |
| `latencyAlertThreshold` | number | `30000` | Latency alert threshold (ms) |
| `logLocally` | boolean | `true` | Log trust scores to OpenClaw logger |
| `verbose` | boolean | `false` | Log additional context (agent, session, tool counts) |

## How it works

The plugin uses OpenClaw's typed hook system via `api.on("agent_end", handler)`. This hook fires after every completed agent run through the gateway, receiving the full message history, success status, and duration.

The scoring pipeline:

1. Extract tool calls from assistant messages (blocks with `type: "tool_use"`)
2. Check each tool against the `allowedTools` list
3. Compute dimension scores based on success, violations, and latency
4. Log results locally and optionally POST to the remote API

The plugin runs at priority `-10` (after all other plugins) and is fire-and-forget — it never blocks or modifies the agent's response.

**Important:** Hooks only fire through the gateway. Runs with `--local` bypass the hook system.

## Remote API

When `apiKey` is set, the plugin reports each run to the configured endpoint. The payload includes the trust score, individual dimension scores, flags, tool call details, and timing data.

The remote API stores runs with SHA-256 hash chains for tamper detection. Each run's hash incorporates the previous run's hash, creating an append-only audit trail.

## Requirements

- OpenClaw 2026.1.30+
- Gateway mode (hooks don't fire in `--local` mode)

## License

MIT
