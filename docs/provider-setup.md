# Provider 配置指南

Runi 采用 BYOK（Bring Your Own Key）方式工作，不提供内置托管模型。安装扩展后，必须先配置至少一个 AI Provider 和 API Key，才能发起对话。

[English](provider-setup.en.md)

## DeepSeek 配置示例

### 1. 获取 API Key

1. 打开 [DeepSeek 开放平台的 API Keys 页面](https://platform.deepseek.com/api_keys)并登录。
2. 创建一个新的 API Key，并立即复制保存。不要把真实密钥发到 issue、聊天记录或截图中。
3. 确认 DeepSeek 账户余额可用。API 调用由 DeepSeek 按其当前规则计费，与 Runi 无关。

### 2. 打开 Provider 设置

1. 点击浏览器工具栏中的 Runi 图标，打开侧边栏。
2. 如果尚未配置 Provider，侧边栏顶部会显示提示，点击其中的“设置”。也可以打开右上角菜单并选择“设置”。
3. 设置页默认打开“模型 Provider”。点击“添加 Provider”。

### 3. 填写 DeepSeek 配置

在“快速预设”中选择 `DeepSeek`。Runi 会自动填写：

| 字段 | 值 |
|------|----|
| Provider 名称 | `DeepSeek` |
| Base URL | `https://api.deepseek.com` |
| 协议 | `OpenAI Chat Completions` |
| 默认模型 | `deepseek-v4-pro` |

只需在 `API Key` 中粘贴刚创建的密钥，然后点击“添加”。

Base URL 只填写基础地址，不要追加 `/chat/completions`；Runi 会在发送请求时补全路径。DeepSeek 预设还提供 `deepseek-v4-flash` 供切换。模型名称和可用性可能变化，请以 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/)为准。

### 4. 验证配置

1. 返回 Runi 侧边栏。
2. 检查输入框下方的模型选择器是否显示 `DeepSeek / deepseek-v4-pro`。
3. 发送一条简单消息，例如“总结当前页面”。收到回答即表示配置可用。

如果配置了多个 Provider 或模型，可点击输入框下方的模型选择器随时切换。

## 常见问题

- **提示未配置 Provider 或缺少 API Key**：返回设置页，确认 Provider 已保存，并显示“已配置 API Key”。
- **返回 401 或 403**：重新检查 API Key 是否完整、有效，是否误带空格，以及账户是否允许 API 访问。
- **返回 404**：确认协议为 `OpenAI Chat Completions`、Base URL 为 `https://api.deepseek.com`，模型名存在于当前 DeepSeek API。不要在 Base URL 后重复添加 `/chat/completions`。
- **提示余额或计费问题**：登录 DeepSeek 开放平台检查余额和计费状态。
- **网络请求失败**：确认当前网络可以访问所配置的 Provider 端点；Runi 不通过开发者服务器中转请求。

## 数据与密钥

Provider 设置和 API Key 保存在浏览器本地的 `chrome.storage.local` 中，不会同步到 Runi 的开发者服务器。Runi 不运营开发者后端。

当你主动发起请求时，API Key、当前提示词、近期对话上下文、相关页面结果以及该请求中选择的文件内容，会按完成请求的需要由扩展直接发送到所配置的 Provider，并受该 Provider 的条款和隐私政策约束。完整说明见[隐私政策](privacy-policy.md)。

## 其他 Provider

OpenAI、通义千问、智谱 GLM、Moonshot 和本地 Ollama 也有内置预设。配置流程相同：选择预设、核对官方端点和模型、填写 API Key 并保存。使用自定义或中转端点时，请从服务方获取与所选协议匹配的 Base URL、模型名称和密钥。
