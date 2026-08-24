# Provider Setup Guide

Runi uses BYOK (Bring Your Own Key) and does not include a hosted model. After installing the extension, configure at least one AI provider and API key before starting a conversation.

[中文](provider-setup.md)

## DeepSeek example

### 1. Get an API key

1. Open the [DeepSeek Platform API Keys page](https://platform.deepseek.com/api_keys) and sign in.
2. Create a new API key and copy it immediately. Never put a real key in an issue, chat transcript, or screenshot.
3. Make sure your DeepSeek account has an available balance. DeepSeek bills API usage under its current pricing; these charges are separate from Runi.

### 2. Open provider settings

1. Select the Runi icon in the browser toolbar to open the side panel.
2. If no provider is configured, use the **Settings** link in the banner. You can also open the top-right menu and select **Settings**.
3. Settings opens on **Model providers**. Select **Add provider**.

### 3. Enter the DeepSeek configuration

Choose `DeepSeek` under **Quick preset**. Runi fills in:

| Field | Value |
|------|------|
| Provider name | `DeepSeek` |
| Base URL | `https://api.deepseek.com` |
| API type | `OpenAI Chat Completions` |
| Default model | `deepseek-v4-pro` |

Paste the key into **API Key**, then select **Add**.

Enter only the Base URL; do not append `/chat/completions`. Runi adds the request path when sending a message. The DeepSeek preset also offers `deepseek-v4-flash`. Model names and availability can change, so refer to the [official DeepSeek API documentation](https://api-docs.deepseek.com/).

### 4. Verify the configuration

1. Return to the Runi side panel.
2. Check that the model selector below the composer shows `DeepSeek / deepseek-v4-pro`.
3. Send a simple request such as “Summarize this page.” A response confirms that the configuration works.

If you configure multiple providers or models, use the model selector below the composer to switch between them.

## Troubleshooting

- **Runi says no provider or API key is configured**: return to Settings, make sure the provider was saved, and check that it shows **API key configured**.
- **401 or 403 response**: check that the API key is complete and valid, contains no accidental whitespace, and belongs to an account with API access.
- **404 response**: confirm that the API type is `OpenAI Chat Completions`, the Base URL is `https://api.deepseek.com`, and the model is currently available from DeepSeek. Do not add `/chat/completions` twice.
- **Balance or billing error**: sign in to the DeepSeek Platform and check the account balance and billing status.
- **Network request failed**: make sure your network can reach the configured provider endpoint. Runi does not relay requests through a developer-operated server.

## Data and API keys

Provider settings and API keys are stored locally in `chrome.storage.local`; they are not synced to a Runi developer server. Runi has no developer-operated backend.

When you initiate a request, the extension sends the API key, current prompt, recent conversation context, relevant page-derived results, and files selected for that request directly to the configured provider as needed to fulfill the request. The provider handles that data under its own terms and privacy policy. See the [privacy policy](privacy-policy.en.md) for the complete disclosure.

## Other providers

Runi also includes presets for OpenAI, Qwen, Zhipu GLM, Moonshot, and local Ollama. The setup flow is the same: select a preset, verify its endpoint and model against the provider's official documentation, enter an API key, and save. For a custom or relay endpoint, obtain a Base URL, model name, and key that match the selected API type from that service.
