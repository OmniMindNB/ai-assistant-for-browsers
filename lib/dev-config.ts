// ⚠️ 本地开发测试专用：在此填入测试 API Key（如 DeepSeek，兼容 OpenAI 接口）。
//
// 用法：
//   1. 将下面的 `enabled` 改为 true；
//   2. 在 `apiKey` 中填入你的测试 Key；
//   3. 运行 `pnpm dev`，首次打开侧边栏会自动创建一个名为 "DeepSeek (Dev)" 的
//      Provider 并设为当前 Provider，即可直接开始对话测试。
//
// 注意：
//   - 此文件仅用于开发自测，请勿提交真实 Key 到版本库（请保持 enabled=false 或
//     提交前清空 apiKey）。
//   - 正式使用请在扩展「设置」页面配置 Provider（不要在代码里硬编码 Key）。

import type { ProviderConfig } from './settings';

export interface DevProvider extends ProviderConfig {
  /** 是否启用此开发配置 */
  enabled: boolean;
}

export const DEV_PROVIDER: DevProvider = {
  enabled: true, // ← 改为 true 启用下面的开发配置
  id: 'dev-deepseek',
  name: 'DeepSeek (Dev)',
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: 'sk-3d0923dd2a7a45eea9b6c0ef2ebf6369', // ← 在这里填入你的测试 API Key
  model: 'deepseek-chat',
};
