# ðŸŽ¢ FreeRide

### Stop paying for AI. Start riding free.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![NanoClaw Compatible](https://img.shields.io/badge/NanoClaw-Compatible-blue.svg)](https://github.com/NanoClaw/NanoClaw)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-30%2B%20Free%20Models-orange.svg)](https://openrouter.ai)

---

**FreeRide** gives you unlimited free AI in [NanoClaw](https://github.com/NanoClaw/NanoClaw) by automatically managing OpenRouter's free models.

```
You: *hits rate limit*
FreeRide: "I got you." *switches to next best model*
You: *keeps coding*
```

## The Problem

You're using NanoClaw. You love it. But:

- ðŸ’¸ API costs add up fast
- ðŸš« Free models have rate limits
- ðŸ˜¤ Manually switching models is annoying
- ðŸ¤· You don't know which free model is actually good

## The Solution

One command. Free AI. Forever.

```bash
freeride auto
```

That's it. FreeRide:

1. **Finds** the 30+ free models on OpenRouter
2. **Ranks** them by quality (context length, capabilities, speed)
3. **Sets** the best one as your primary
4. **Configures** smart fallbacks for when you hit rate limits
5. **Preserves** your existing NanoClaw config

## Installation

```bash
npx clawhub@latest install freeride
cd /home/node/.claude/workspace/skills/free-ride
pip install -e .
```

That's it. `freeride` and `freeride-watcher` are now available as global commands.

## Quick Start

### 1. Get a Free OpenRouter Key

Go to [openrouter.ai/keys](https://openrouter.ai/keys) â†’ Create account â†’ Generate key

No credit card. No trial. Actually free.

### 2. Set Your Key

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
```

Or add it to your NanoClaw config:

```bash
NanoClaw config set env.OPENROUTER_API_KEY "sk-or-v1-..."
```

### 3. Run FreeRide

```bash
freeride auto
```

### 4. Restart NanoClaw

```bash
NanoClaw gateway restart
```

### 5. Verify It Works

Message your agent on WhatsApp/Telegram/Discord or the dashboard:

```
You:    /status
Agent:  (shows the free model name + token count)
```

Done. You're now running on free AI with automatic fallbacks.

## What You Get

```
Primary Model: openrouter/nvidia/nemotron-3-nano-30b-a3b:free (256K context)

Fallbacks:
  1. openrouter/free          â† Smart router (auto-picks best available)
  2. qwen/qwen3-coder:free    â† Great for coding
  3. stepfun/step-3.5:free    â† Fast responses
  4. deepseek/deepseek:free   â† Strong reasoning
  5. mistral/mistral:free     â† Reliable fallback
```

When you hit a rate limit, NanoClaw automatically tries the next model. You keep working. No interruptions.

## Commands

| Command | What it does |
|---------|--------------|
| `freeride auto` | Auto-configure best model + fallbacks |
| `freeride list` | See all 30+ free models ranked |
| `freeride switch <model>` | Use a specific model |
| `freeride status` | Check your current setup |
| `freeride fallbacks` | Update fallbacks only |
| `freeride refresh` | Force refresh model cache |

### Pro Tips

```bash
# Already have a model you like? Just add fallbacks:
freeride auto -f

# Want more fallbacks for maximum uptime?
freeride auto -c 10

# Coding? Switch to the best coding model:
freeride switch qwen3-coder

# See what's available:
freeride list -n 30

# Always restart NanoClaw after changes:
NanoClaw gateway restart
```

## How It Ranks Models

FreeRide scores each model (0-1) based on:

| Factor | Weight | Why |
|--------|--------|-----|
| Context Length | 40% | Longer = handle bigger codebases |
| Capabilities | 30% | Vision, tools, structured output |
| Recency | 20% | Newer models = better performance |
| Provider Trust | 10% | Google, Meta, NVIDIA, etc. |

The **smart fallback** `openrouter/free` is always first - it auto-selects based on what your request needs.

## Testing with Your NanoClaw Agent

After running `freeride auto` and `NanoClaw gateway restart`:

```bash
# Check NanoClaw sees the models
NanoClaw models list

# Validate config
NanoClaw doctor --fix

# Open the dashboard and chat
NanoClaw dashboard
# Or message your agent on WhatsApp/Telegram/Discord
```

Useful agent commands to verify:

| Command | What it tells you |
|---------|-------------------|
| `/status` | Current model + token usage |
| `/model` | Available models (your free models should be listed) |
| `/new` | Start fresh session with the new model |

## Watcher (Auto-Rotation)

FreeRide includes a watcher daemon that monitors for rate limits and automatically rotates models:

```bash
# Run once (check + rotate if needed)
freeride-watcher

# Run as daemon (continuous monitoring)
freeride-watcher --daemon

# Force rotate to next model
freeride-watcher --rotate

# Check watcher status
freeride-watcher --status

# Clear rate limit cooldowns
freeride-watcher --clear-cooldowns
```

## FAQ

**Is this actually free?**

Yes. OpenRouter provides free tiers for many models. You just need an account (no credit card).

**What about rate limits?**

That's the whole point. FreeRide configures multiple fallbacks. When one model rate-limits you, NanoClaw automatically switches to the next.

**Will it mess up my NanoClaw config?**

No. FreeRide only touches `agents.defaults.model` and `agents.defaults.models`. Your gateway, channels, plugins, workspace, customInstructions - all preserved.

**Which models are free?**

Run `freeride list` to see current availability. It changes, which is why FreeRide exists.

**Do I need to restart NanoClaw after changes?**

Yes. Run `NanoClaw gateway restart` after any FreeRide command that changes your config.

## The Math

| Scenario | Monthly Cost |
|----------|--------------|
| GPT-4 API | $50-200+ |
| Claude API | $50-200+ |
| NanoClaw + FreeRide | **$0** |

You're welcome.

## Requirements

- [NanoClaw](https://github.com/NanoClaw/NanoClaw) installed (Node â‰¥22)
- Python 3.8+
- Free OpenRouter account ([get key](https://openrouter.ai/keys))

## Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  You         â”‚ â”€â”€â†’ â”‚  FreeRide    â”‚ â”€â”€â†’ â”‚  OpenRouter API  â”‚
â”‚  "freeride   â”‚     â”‚              â”‚     â”‚  (30+ free       â”‚
â”‚   auto"      â”‚     â”‚  â€¢ Fetch     â”‚     â”‚   models)        â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â”‚  â€¢ Rank      â”‚     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                     â”‚  â€¢ Configure â”‚
                     â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜
                            â”‚
                            â–¼
                     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                     â”‚ /home/node/.claude/ â”‚
                     â”‚ CLAUDE.mdâ”‚
                     â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜
                            â”‚
                     NanoClaw gateway restart
                            â”‚
                            â–¼
                     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                     â”‚  NanoClaw    â”‚
                     â”‚  (free AI!)  â”‚
                     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

## Contributing

Found a bug? Want a feature? PRs welcome.

```bash
cd /home/node/.claude/workspace/skills/free-ride

# Test commands
freeride list
freeride status
freeride auto --help
```

## Related Projects

- [NanoClaw](https://github.com/NanoClaw/NanoClaw) - The AI coding agent
- [OpenRouter](https://openrouter.ai) - The model router
- [ClawHub](https://github.com/clawhub) - Skill marketplace

## License

MIT - Do whatever you want.

---

<p align="center">
  <b>Stop paying. Start riding.</b>
  <br>
  <br>
  <a href="https://github.com/Shaivpidadi/FreeRide">â­ Star us on GitHub</a>
  Â·
  <a href="https://openrouter.ai/keys">ðŸ”‘ Get OpenRouter Key</a>
  Â·
  <a href="https://github.com/NanoClaw/NanoClaw">ðŸ¦ž Install NanoClaw</a>
</p>
