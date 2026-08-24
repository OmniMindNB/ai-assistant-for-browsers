# Runi

**English** | [中文](README.md)

[🚀 Install Runi from the Chrome Web Store](https://chromewebstore.google.com/detail/dhdgahnfefoojenfojbcdaohbbdoabcd)

> A trustworthy browser page agent — asks before the first write action in a turn and reuses that decision only for that turn; answers are grounded in page evidence, not generic guesses. Bring your own model and API key. Persistent conversation history stays local; after you initiate a request, the current prompt, recent conversation context, and relevant page-derived results may be sent directly to your configured provider.

> Your page, your way.

## Core features

- 🔒 **Confirm before acting**: a Deny-First permission model sorts every tool into three tiers — read-only runs directly, write/interactive tools need confirmation, unknown tools are always denied. The first write action in a turn raises a confirmation card, and the decision is reused only for that turn. `browser_navigate` is restricted to http(s) independently in both the permission layer and the background worker, and page-resource fetches reject loopback, private, link-local, and IPv4-mapped IPv6 targets
- 🔍 **Evidence-driven analysis**: reads page text / DOM / HTML / scripts / stylesheets / computed styles / screenshots. `browser_inspect_page_implementation` gathers all of that in a single call plus a keyword-matched `evidenceSummary`, so "how is this implemented" gets an answer citing specific code instead of a generic description
- 🖐️ **Page actions**: once approved, Runi can set styles, modify the DOM, click, type, pick from selects, scroll, navigate, and write storage. Tool calls are budgeted (12 read/analysis calls by default, raised to 24 after you approve a write); when the budget runs out the model gets exactly one more turn to produce a final answer
- 🔑 **Bring your own model**: supports both OpenAI-compatible Chat Completions and the Anthropic Messages protocol, with presets for DeepSeek / OpenAI / Qwen / Zhipu GLM / Moonshot / local Ollama and a fully custom endpoint option. Configure multiple providers and models, and switch between them straight from the composer
- 🗂️ **Local-first**: conversation history lives in local IndexedDB, provider configs and UI preferences in `chrome.storage.local` — never synced to any cloud. There is no developer backend and no analytics or ad SDK
- 📎 **Local file context**: attach up to 5 files per message — text (up to 30,000 characters), images (≤ 5 MB), and PDFs (≤ 20 MB, up to 60,000 characters extracted locally, no OCR). PDFs are parsed locally in a Worker with progress feedback and drag-and-drop support; extracted PDF text is used for one turn only, and history keeps just the file metadata
- ⚡ **Shortcuts**: built-in "Summarize page / Explain selection / Translate selection", each editable, deletable, and restorable to defaults, plus your own custom entries. Every shortcut declares its context scope (current page / selected text / no page context). Type `/` in the composer to bring them up
- 🖱️ **Ask about a selection**: select text on a page and an in-place button appears — one click opens the side panel with the selection quoted
- 🪟 **Per-tab conversations**: the side panel is enabled and bound per tab, so switching back to a tab restores that tab's own conversation
- 🌓 **Interface preferences**: three-state language switch (Follow browser / 中文 / English) and theme (light / dark / follow system); messages can be edited and resent, past conversations browsed, opened, and deleted from a history drawer, and tool calls surface as a live step timeline

## Tech stack

| Aspect | Choice |
|------|------|
| Extension framework | [WXT](https://wxt.dev/) (Manifest V3, `minimum_chrome_version: 138`) |
| UI | React 19 + TypeScript + Tailwind CSS v4 |
| Agent | [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) (tool-call loop; OpenAI-compatible Chat Completions + Anthropic Messages) |
| State | Zustand |
| Storage | Dexie (IndexedDB) + `chrome.storage.local` |
| Page parsing | `@mozilla/readability` (article extraction), `pdfjs-dist` (local PDF text extraction) |
| Rendering | react-markdown + remark-gfm + highlight.js |
| Testing | Vitest (a node-environment `unit` project over `lib/**/*.test.ts`, and a jsdom `ui` project for component tests) |
| Package manager | pnpm |

Requested permissions: `sidePanel`, `storage`, `scripting`, `activeTab`, `tabs`, plus the `<all_urls>` host permission.

## Quick start

```bash
# Install dependencies (postinstall runs wxt prepare)
pnpm install

# Start dev (auto-loads the extension with hot reload)
pnpm dev

# Production build, output in .output/chrome-mv3
pnpm build

# Package an uploadable zip
pnpm zip

# Type check
pnpm compile

# Run tests
pnpm test

# Verify the emitted PDF.js static assets
pnpm verify:pdfjs-assets
```

Firefox targets use `pnpm dev:firefox` / `pnpm build:firefox` / `pnpm zip:firefox` (Chromium remains the primary target).

Load the unpacked extension: in your browser go to `Extensions` → enable `Developer mode` → `Load unpacked` → select `.output/chrome-mv3`.

To talk to a real model during development, fill in a key in [lib/dev-config.ts](lib/dev-config.ts) and set `DEV_PROVIDER.enabled = true` — a provider is then auto-registered on load. **Never commit a real key.**

## Project structure

```
entrypoints/        # Extension entry points
  background.ts     # Service worker: message router, the only context with tabs/scripting permissions
  content.ts        # Content script: article extraction (Readability) / selection / ask-selection bubble
  sidepanel/        # Side panel React app
    store.ts        # Zustand: conversation state, attachments, agent driving
    App.tsx         # Message stream, confirmation card, activity steps
    components/     # Composer, shortcuts, history drawer, attachment chips, …
  options/          # Settings page (provider / appearance / language / shortcuts)
components/         # Shared settings components (reused by the compact in-panel settings)
lib/                # Shared libraries
  messaging.ts      # Unified messaging protocol across the three contexts
  agent/            # Agent loop and tool calls
    agent.ts        # Agent wiring (model / tools / lifecycle hooks / context compaction)
    tools.ts        # browser_* tool definitions (10 read-only + 8 write/interactive)
    permissions.ts  # Deny-First permission tiers (always_allow / confirm / deny)
    confirm-gate.ts # First write in a turn prompts for confirmation; reused for the rest of the turn
    tool-policy.ts  # Tool-call budgets, repeated-failure circuit breaker, forced convergence
    system-prompt.ts        # System prompt (the write-tool list is derived from the permission tables)
    stream-shared.ts        # Protocol-agnostic streaming helpers
    openai-stream.ts        # OpenAI-compatible Chat Completions streamFn
    anthropic-stream.ts     # Anthropic Messages streamFn
    activity-steps.ts       # Per-turn tool-call step timeline
    tab-conversation.ts     # Tab <-> conversation binding
  chat/             # Attachments (text/image/PDF), local PDF extraction and parse queue
  i18n/             # zh / en dictionaries and useTranslation()
  shortcuts.ts      # Shortcut storage and validation (built-in + custom)
  theme.ts          # Light / dark / follow system
  db.ts             # IndexedDB (Dexie) conversation persistence
  settings.ts       # Provider configuration and presets
  page-resource-fetch.ts    # SSRF protection for page-resource fetches
docs/               # Documentation (docs-driven development)
```
