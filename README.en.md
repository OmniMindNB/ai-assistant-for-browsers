# Runi

**English** | [中文](README.md)

[🚀 Install Runi from the Chrome Web Store](https://chromewebstore.google.com/detail/dhdgahnfefoojenfojbcdaohbbdoabcd)

> An AI assistant in your browser side panel: autofill forms, automate web pages, and summarize or translate the current page in one sentence — known page actions run automatically; only detected form submissions ask for confirmation each time. Conversation history stays local; after you initiate a request, the current prompt, recent conversation context, and relevant page results are sent directly to your configured provider.

## Before first use

Runi does not include a hosted model; you use your own AI provider and API key. Using DeepSeek as an example:

1. Create and copy an API key on the [DeepSeek Platform](https://platform.deepseek.com/api_keys) (API usage is billed).
2. Open the Runi side panel and use the **Settings** link in the setup banner, or open **Settings** from the top-right menu.
3. Under **Model providers**, select **Add provider** and choose `DeepSeek` under **Quick preset** — the Base URL and model are filled in for you.
4. Paste the key, select **Add**, and return to the side panel to start a conversation.

See the [Provider setup guide](docs/provider-setup.en.md) for more detail and troubleshooting.

## Features

- **Autofill forms and automate pages**: click, type, select, scroll, navigate, and open or switch tabs. Every write is verified before and after, and a write that didn't land is reported as a failure; password and payment fields are never read or filled.
- **Save a task, replay it in one step**: save a successful run as a task, then type `/` and pick it to do the same on a similar page.
- **Summarize and ask**: answers grounded in the page itself; attach text files, images, and PDFs (text extracted locally), or type `@` to reference other tabs (read-only).
- **Ask about selections and shortcuts**: select text and click **Ask Runi**; built-in Summarize page, Translate selection, Fill this form, Polish selection, and Focus mode, plus your own.
- **Understand how a page is built**: reads DOM, HTML, scripts, styles, and computed styles to explain how an effect is implemented.
- **You stay in control**: a Deny-First permission model refuses unknown tools and allows only http(s) navigation; Runi pauses and asks when you touch the mouse or keyboard mid-task; tool calls have a budget.
- **Redaction before sending**: phone numbers, emails, ID numbers, bank card numbers, and your own rules are replaced with a placeholder in full (screenshots are not covered).
- **Local-first**: conversation history and settings stay in your browser; no developer backend, no analytics SDK.
- **Bring your own model**: OpenAI-compatible and Anthropic Messages protocols; configure multiple providers and switch below the composer.

## Permissions

`sidePanel`, `storage`, `scripting`, `activeTab`, `tabs`, `alarms` (only keeps the service worker alive while a task you started is running), `userScripts` (lets the Agent run scripts in an environment isolated from the page; takes effect only after you turn on "Allow User Scripts" on the extension details page), plus the `<all_urls>` host permission.

## Development

```bash
pnpm install   # postinstall runs wxt prepare
pnpm dev       # dev mode with hot reload
pnpm build     # production build -> .output/chrome-mv3
pnpm zip       # package a zip for store upload
pnpm compile   # type check
pnpm test      # run tests
```

For Firefox use `pnpm dev:firefox` / `pnpm build:firefox` / `pnpm zip:firefox`. To load the unpacked extension: `chrome://extensions` → enable Developer mode → Load unpacked → select `.output/chrome-mv3`.

Stack: [WXT](https://wxt.dev/) (Manifest V3, Chrome 138+), React 19, TypeScript, Tailwind CSS v4, [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core), Zustand, Dexie, Vitest. Architecture notes are in [CLAUDE.md](CLAUDE.md); design docs are under [docs/](docs/README.md).

## License

Released under the [MIT License](LICENSE).
