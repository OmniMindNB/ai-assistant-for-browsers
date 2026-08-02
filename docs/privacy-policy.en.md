# Runi Privacy Policy

Effective date: 2026-07-27

This policy describes how the Runi browser extension processes data. “Runi” means the extension and its developer.

## 1. Summary

Runi has no developer-operated backend, account service, analytics, or advertising SDK. This does **not** mean that no data leaves your device. When you initiate an AI request, Runi sends recent conversation content and relevant current-page tool results directly from the extension to the AI provider endpoint you configured. The provider, not Runi, receives and processes that request under its own terms and privacy policy.

Provider settings, API keys, interface preferences, and conversation history are stored locally in your browser. Runi does not sell user data.

## 2. Data we process

| Data category | What may be processed | Local handling | External transmission |
|---|---|---|---|
| Current-page identity and content | Page title, URL, language, readable text, selected text, HTML, DOM structure and attributes, page metadata, inline or external scripts and stylesheets, and computed styles, depending on the tools used for your request | Held in runtime memory and tool context; page tool results are not added to Runi’s persistent conversation database | Relevant text and tool results are sent directly to your configured AI provider so it can answer or act on your request |
| Visible-tab screenshot | An image of the visible area of the active target tab, only when the screenshot tool is used | Held transiently as a data URL in tool details and not added to Runi’s persistent conversation database | In version `1.1.0`, the screenshot image bytes are not included in the AI-provider request; the provider receives only a text notice that a screenshot was captured and its data-URL length |
| Conversation content | Your prompts, quick-action prompts, recent conversation history, and AI responses; this content may include personal or confidential information that you choose to enter | Conversation messages are stored in browser-local IndexedDB | The current prompt and recent conversation context are sent directly to your configured AI provider |
| Provider configuration and credentials | Provider name, Base URL, model, protocol, and API key | Stored in `chrome.storage.local` and not synced by Runi | The Base URL selects the destination. The model and request content are sent to that endpoint, and the API key is sent to that endpoint as an authentication header |
| Interface preferences | Language preference and theme preference | Stored in `chrome.storage.local` | Not sent to the AI provider by Runi |
| Session state | The conversation associated with a tab, keyed by tab ID | Stored in `chrome.storage.session`, which is browser-session storage and is not synced by Runi | Not sent as session records to the AI provider |

For Chrome Web Store disclosure purposes, Runi treats `Website content` as collected/processed because relevant current-page content is transmitted off-device to the AI provider selected by the user for the core feature. Runi’s developer does not receive that content through a Runi backend.

## 3. How data is used

Runi processes data only to provide the user-requested core feature: understand the current page, answer page-grounded questions, analyze page implementation, and perform approved page actions. Write tools show a confirmation before they run; one decision is remembered for the current turn.

Runi does not use data for advertising, profiling, credit or eligibility decisions, unrelated product development, or sale to third parties. The configured AI provider may have its own processing, retention, or model-training terms, which you must review separately.

## 4. Privacy disclosure and user-directed requests

The Settings page provides privacy disclosures explaining which data stays in your browser and which data may be sent to your configured AI provider. The same disclosures are maintained in this policy. Runi does not store a separate consent record.

When you initiate an Agent request, you direct Runi to send your current prompt, recent conversation context, API key, and any relevant page-derived results to your configured AI provider as needed to fulfill that request. Read-only page tools may run after you initiate the request. Before the first write action in a turn, Runi asks for confirmation; the decision is remembered only for the current turn.

## 5. Local storage and deletion

- Provider settings, API keys, language, and theme are stored in `chrome.storage.local`.
- Conversation messages are stored in browser-local IndexedDB.
- Tab-to-conversation state is stored temporarily in `chrome.storage.session`.
- Page tool results and screenshot data URLs are not written to Runi’s persistent conversation database.

You can delete individual conversations and remove provider configurations in Runi. Clearing the extension’s browser data or uninstalling Runi removes its local data. Deleting Runi’s local data does not delete copies already processed or retained by your AI provider; use that provider’s controls and policy for those copies.

## 6. Third-party AI providers

You choose and configure the provider endpoint. Runi supports OpenAI-compatible and Anthropic-compatible APIs, including custom or locally hosted endpoints.

For each AI request, Runi connects directly to the configured Base URL and may send the model identifier, system instructions, tool definitions, your current prompt, recent conversation context, and relevant page-derived tool results. The API key is included as an authentication credential for that endpoint. Runi does not proxy these requests through a developer-operated server and cannot control the provider’s security, retention, training, or disclosure practices.

Before using a provider, review its privacy policy and terms. Do not submit page content or conversation content that you are not authorized to share with that provider.

Use an HTTPS Base URL for every remote provider. Runi sends requests to the configured URL as entered and does not upgrade an insecure remote HTTP URL. A loopback HTTP URL such as `http://localhost` may be used for a provider running on the same device.

## 7. Browser permissions

Runi `1.1.0` uses this permission set:

| Permission | Purpose |
|---|---|
| `activeTab` | Supports user-invoked access to the active page |
| `tabs` | Identifies and validates the target tab, reads its title and URL, opens the extension settings page, and performs user-requested navigation |
| `scripting` | Runs packaged read and structured-write functions in the target page |
| `storage` | Stores provider settings, API keys, language and theme preferences, plus temporary session and undo state |
| `sidePanel` | Hosts Runi’s primary interface |
| Host access: `<all_urls>` | Lets the same current-page Agent work on user-selected HTTP and HTTPS sites and fetch page-referenced resources |

Read-only page tools may run after you initiate an Agent request. Page-changing tools require confirmation before the first write action in a turn. Runi does not passively build a browsing-history profile.

## 8. External resources and SSRF protection

For page-implementation analysis, Runi may follow HTTP or HTTPS URLs found in the current page’s `<script src>` and stylesheet `<link href>` elements to retrieve source text. The request goes directly to the referenced resource host, which can receive normal network metadata such as your IP address.

Before fetching, Runi rejects non-HTTP(S) URLs and literal hosts matching localhost, unspecified, loopback, common private-network, link-local, IPv6 unique-local, and IPv4-mapped IPv6 forms of those ranges. Redirects are requested in manual mode. If the browser exposes a redirect target, Runi resolves and validates it before making the next request; if Chrome hides the target as an opaque redirect, Runi rejects the redirect rather than following an address it cannot validate. Allowed source text may be sent to your configured AI provider as part of the requested analysis. These checks reduce server-side request forgery (SSRF) risk but are not a guarantee against every network or DNS-based attack; use Runi on pages and networks you trust.

## 9. Children’s privacy

Runi is not directed to children under 13 and does not knowingly solicit children’s personal information. Runi does not operate accounts or an age-verification service. A parent or guardian who believes a child entered personal information should clear the extension’s local data, contact the configured AI provider about any transmitted copy, and may contact us at the address below.

## 10. Chrome Web Store Limited Use

Runi’s use and transfer of information received from Google APIs complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. Data is used only to provide or improve the user-facing core feature, and transfers are limited to the AI provider selected by the user and resource hosts contacted as necessary for a user-requested operation.

Runi does not sell user data, use it for advertising, use it to determine creditworthiness or lending eligibility, or permit humans to read it through a Runi backend.

## 11. Policy changes

If this policy changes, we will update the effective date and record the change in the project repository. Review the updated policy before continuing to use Runi when a change materially affects what data Runi processes or where it is sent.

## 12. Contact

Questions about this policy can be sent to:

```text
liudong.ucas@gmail.com
```
