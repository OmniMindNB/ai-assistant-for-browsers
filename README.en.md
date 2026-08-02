# Runi

**English** | [中文](README.md)

> A trustworthy browser page agent — asks for your confirmation before every page change; answers are grounded in page evidence, not generic guesses. Bring your own model with your own API key; conversation history stays local and is never uploaded.

> Your page, your way.

## Core features

- 🔒 **Confirm before acting**: style/DOM edits, click/type/scroll/navigate, script injection, and other write actions all ask for your confirmation turn by turn before running — a Deny-First permission model + static scanning of injected scripts (AST-based dangerous API detection) + SSRF protection
- 🔍 **Evidence-driven analysis**: automatically reads page text / DOM / scripts / stylesheets / computed styles / screenshots, and when answering "how is this implemented," cites specific code evidence instead of giving a generic description
- 🔑 **Bring your own model**: connect any OpenAI-compatible provider / API key / model — not locked to a single vendor
- 🗂️ **Local-first**: conversation history is stored only in local IndexedDB, never synced to any cloud
- 📄 **Page summarization / comprehension aids**: extract key points, explain terms, and answer questions grounded in page context, all in one click
- ⚡ **Skill system**: turn common actions into reusable, centrally managed Skills

## Tech stack

| Aspect | Choice |
|------|------|
| Extension framework | [WXT](https://wxt.dev/) (Manifest V3) |
| UI | React 18 + TypeScript + Tailwind CSS |
| Agent | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) (tool-call loop, OpenAI-compatible Chat Completions) |
| State | Zustand |
| Storage | Dexie (IndexedDB) + `chrome.storage` |
| Testing | Vitest |
| Package manager | pnpm |

## Quick start

```bash
# Install dependencies
pnpm install

# Start dev (auto-loads the extension with hot reload)
pnpm dev

# Production build, output in .output/chrome-mv3
pnpm build

# Type check
pnpm compile

# Run tests
pnpm test
```

> If Google Chrome isn't installed locally, point the browser binary to Microsoft Edge or another Chromium-based browser in [web-ext.config.ts](web-ext.config.ts).

Load the unpacked extension: in your browser go to `Extensions` → enable `Developer mode` → `Load unpacked` → select `.output/chrome-mv3`.

## Project structure

```
entrypoints/        # Extension entry points
  background.ts     # Service worker: message router, the only context with tabs/scripting permissions
  content.ts        # Content script: page extraction (Readability) / text selection
  sidepanel/        # Side panel React app (chat UI, confirmation card)
  options/          # Settings / provider & API key management
lib/                # Shared libraries
  messaging.ts      # Unified messaging protocol across the three contexts
  agent/            # Agent loop and tool calls
    agent.ts        # Agent wiring (model / tools / lifecycle hooks)
    tools.ts        # browser_* tool definitions (read-only / write)
    permissions.ts  # Deny-First permission tiers (always_allow / confirm / deny)
    confirm-gate.ts # First write in a turn prompts for confirmation; result is reused for the rest of the turn
    stream.ts       # SSE streaming response parsing
  db.ts             # IndexedDB (Dexie)
  settings.ts       # Provider configuration storage
  security.ts       # Static safety scan for injected scripts (acorn AST)
docs/               # Documentation (docs-driven development)
```

## Documentation

This project follows **docs-driven development**: docs come before code, and docs are the single source of truth.

- [Documentation overview](docs/README.md)
- [Product requirements](docs/plan.md)
- [Technical plan](docs/technical-plan.md)
- [Progress board](docs/PROGRESS.md)
- [Architecture Decision Records (ADR)](docs/adr/)

## Development status

🚧 In development — Phase 0/1/2 and Agent Phase B (write/interactive tools + permission confirmation UI) are complete,
Agent Phase A (tool-call loop) is in acceptance testing, and Agent Phase C (CDP / multi-tab / scraping export) hasn't started.
See the [progress board](docs/PROGRESS.md) for details.
