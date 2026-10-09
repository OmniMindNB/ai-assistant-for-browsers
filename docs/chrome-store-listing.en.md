# Runi Chrome Web Store Listing — English

Paste-ready fields for the `en` localization of the Chrome Web Store listing. Simplified Chinese is the default Store language.

## Name

The Chrome Web Store title comes from the manifest and cannot be edited in the Dashboard: keep this identical to `extName` in `public/_locales/en/messages.json`; a change only takes effect with a new package upload.

```text
Runi - AI Browser Agent: Autofill Forms, Automate Pages, Summarize
```

## Short description

Keep identical to `extDescription` (the manifest caps it at 132 characters).

```text
AI side panel agent: autofill forms, click through web pages, summarize and translate, replay saved tasks. Works with your own key.
```

## Category

```text
Productivity
```

## Single purpose

```text
Runi is one controllable AI sidebar agent that helps the user understand and work with the current web page and user-selected files, automatically performs known page actions, and confirms detected form submissions.
```

## Detailed description

```text
Runi is an AI assistant in your browser side panel that doesn't just answer questions — it works on the page for you: filling forms, clicking buttons, paging through results, and organizing data. Say what you want in one sentence and let it do the rest.

Your page, your way.

WHAT IT DOES

• Autofill forms: say "fill in this form with these details" and Runi finds the fields, fills them, then reads each one back to verify the value actually landed. Dropdowns, radio buttons, and custom-built widgets are handled too.
• Automate web pages: click, type, select, scroll, paginate, and open new tabs, chaining multi-step actions together. Great for admin-panel data entry, bulk settings, and repetitive web chores.
• Save a task, replay it in one step: save any successful run as a shortcut, then pick it with / on a similar page to do it again — no need to describe it twice.
• Summarize and ask: summarize the current page or ask questions answered from the page itself. Attach text files, images, and PDFs to a request.
• Translate and polish selections: select text on any page and click the Ask Runi bubble to translate, explain, or rewrite it.
• Work across tabs: type @ to pick other tabs and send their content together for comparison or roundups.
• Organize page data: turn lists and tables on the page into the format you need; for large jobs the Agent can run a script to do it in one step.
• Understand how a page is built: developers can have it inspect DOM, styles, scripts, and computed styles to explain how a page works or why it renders wrong.
• Look at screenshots: with an image-capable model, it can judge layout, button states, and canvas-rendered content from a screenshot.

YOU STAY IN CONTROL

• Detected form submissions always pause for your approval, every time.
• Take over at any moment: when Runi detects your own mouse or keyboard input, it pauses and asks whether to continue or stop.
• Password and payment fields are never read and never filled.
• Automatic redaction before anything is sent: phone number, email, ID number, and bank card rules are built in, and you can add your own. A match is replaced with a placeholder in full.

BRING YOUR OWN MODEL

Works with DeepSeek, OpenAI, and any OpenAI-compatible or Anthropic (Claude)-compatible API, including custom endpoints. Runi itself is free; model usage is billed by the provider you choose.

Get started in three steps (DeepSeek as an example):
1. Sign in to the DeepSeek Platform, then create and copy an API key.
2. Open the Runi side panel, use the Settings link in the setup banner, select Add provider under Model providers, and choose DeepSeek from Quick preset (Base URL and model are filled in for you).
3. Paste the key, select Add, and return to the side panel to start a conversation.

PRIVACY

Runi is local-first: provider settings, API keys, interface preferences, and conversation history are stored in your browser; PDF text is extracted locally and is not persisted as PDF content. Runi has no developer-operated backend, analytics, or advertising SDK. When you initiate an Agent request, you direct Runi to transmit your API key, current prompt, recent conversation context, relevant current-page tool results, and the contents of files you selected for that request directly from the extension to the AI provider endpoint you configured as needed to fulfill that request. That provider processes the request under its own terms and privacy policy. Runi reads or changes a page only after you open the product and initiate an action.

GOOD TO KNOW

• Known page actions run automatically; detected form submissions ask for approval every time.
• Running scripts requires "Allow User Scripts" on the extension details page. Scripts run in an environment isolated from the page, where the script's own network APIs are blocked; this does not stop page navigation or requests made through page elements, and form submissions a script triggers are not covered by the approval step.
• Screenshots are images and are not covered by the text redaction rules.
```

## Screenshot captions

1. `Understand any page — Summaries and answers grounded in the current page.`
2. `See the evidence — Inspect DOM, styles, scripts, and computed behavior.`
3. `You stay in control — Detected form submissions always pause for your approval.`
4. `Ask across pages and files — Attach text, images, and PDFs to the current request.`

## Currently deployed privacy-policy URL

```text
https://omnimindnb.github.io/ai-assistant-for-browsers/privacy-policy/
```

## Support contact

```text
liudong.ucas@gmail.com
```
