# authe.me OpenClaw Extension

See the [main README](../../README.md) for full documentation.

## Quick start

```bash
cp -r extensions/autheme ~/.openclaw/extensions/autheme
```

Add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "autheme": { "enabled": true }
    }
  }
}
```

Restart: `openclaw gateway restart`
