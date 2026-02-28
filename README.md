# authe.me — Trust Scoring Plugin for OpenClaw

Real-time trust scoring for OpenClaw agents. Captures every tool call as it happens and computes a composite trust score, with optional reporting to [authe.me](https://authe.me) for tamper-proof audit trails.

## What it does

The plugin hooks into two agent lifecycle events:

- **`after_tool_call`** — captures each tool execution in real time (name, params, result, duration, errors)
- **`agent_end`** — finalizes the run, computes a weighted trust score, and optionally ships the full action log to api.authe.me

### Trust Score Dimensions

| Dimension | Weight | What it measures |
|---|---|---|
| **Reliability** | 30% | Did the run succeed or fail? |
| **Scope adherence** | 30% | Did the agent only use allowed tools? |
| **Cost efficiency** | 20% | Token/cost budget compliance |
| **Latency efficiency** | 20% | Tool call response times vs threshold |

### Example output

Clean run:
```
[authe.me] Trust Score: 100  (reliability=100 | scope=100 | cost=100 | latency=100)
[authe.me] agent=main session=agent:main:main tools=3 violations=0 duration=2063ms
```

With violations:
```
[authe.me] ✓ read_file (150ms)
[authe.me] 🔴 SCOPE VIOLATION: tool "shell_exec" not in allowed list
[authe.me] ✓ write_file (80ms)
[authe.me] Trust Score: 67  (reliability=100 | scope=67 | cost=100 | latency=100)
🟡 [scope_adherence] Tool "shell_exec" not in allowed list
   → Add "shell_exec" to allowedTools or investigate why it was called
```

## Install

```bash
git clone https://github.com/autheme/openclaw-plugin.git
cp -r openclaw-plugin/extensions/autheme ~/.openclaw/extensions/autheme
```

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "autheme": {
        "enabled": true,
        "config": {
          "allowedTools": ["read_file", "write_file", "browser"],
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

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `apiEndpoint` | string | `https://api.authe.me` | API base URL |
| `agentToken` | string | — | JWT token for this agent (get from dashboard) |
| `allowedTools` | string[] | `[]` | Tool allowlist. Empty = all tools allowed |
| `latencyThreshold` | number | `30000` | Flag calls slower than this (ms) |
| `logLocally` | boolean | `true` | Log scores to gateway logs |
| `verbose` | boolean | `false` | Log every individual tool call |

### Local-only mode (no account needed)

Just install and go. Without `agentToken`, the plugin logs trust scores locally and never phones home.

### With remote reporting

1. Sign up at [authe.me](https://authe.me)
2. Register an agent in the dashboard
3. Get the agent token and add it to config:

```json
{
  "autheme": {
    "enabled": true,
    "config": {
      "agentToken": "eyJhbG...",
      "allowedTools": ["read_file", "write_file"],
      "verbose": true
    }
  }
}
```

Actions are hash-chained and stored in a tamper-evident audit trail. Verify integrity anytime at `GET /v1/verify/:agent_id/chain`.

## How it works

1. Agent starts a run
2. Each tool call fires `after_tool_call` — plugin captures the tool name, params, result, duration, and checks scope
3. When the run ends, `agent_end` fires — plugin computes the weighted trust score and logs it
4. If `agentToken` is set, the full action log is posted to `api.authe.me/v1/ingest` with the correct `IngestBatchRequest` format
5. The API computes a SHA-256 hash chain, linking each action to the previous one

## Technical notes

- Zero dependencies beyond the OpenClaw plugin SDK
- Fire-and-forget API calls — never blocks the agent response
- Runs at priority `-10` (after other plugins)
- Stale run state is evicted after 1 hour
- Large tool payloads (>10KB) are truncated before API submission
- Falls back to message-content extraction if `after_tool_call` doesn't fire for some tools

## Related

- [authe.me](https://authe.me) — agent trust scoring platform
- [authe Python SDK](https://pypi.org/project/authe/) — for LangChain, CrewAI, and custom agents
- [OpenClaw Discussion #20575](https://github.com/openclaw/openclaw/discussions/20575) — hook bridge proposal (related to how this plugin captures tool events)

## License

MIT
