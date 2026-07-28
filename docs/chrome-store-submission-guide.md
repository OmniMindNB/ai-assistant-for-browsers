# Chrome Web Store `1.1.0` 更新操作指南

最后更新：2026-07-28

本指南用于更新**现有的 Aluminum Chrome Web Store 商品**，版本迁移为 `1.0.0 → 1.1.0`。必须继续使用现有商品 ID，不要新建另一个商品。

## 1. 准备并核验上传包

在仓库根目录运行：

```bash
pnpm compile
pnpm test
pnpm build
pnpm zip
```

上传前确认：

- 产物为 `.output/aluminum-1.1.0-chrome.zip`。
- 产物 `manifest.json` 中 `version` 为 `1.1.0`，`default_locale` 为 `en`。
- 权限仍为 `sidePanel`、`storage`、`scripting`、`activeTab`、`tabs`、`userScripts`，主机访问权限仍为 `<all_urls>`。
- `_locales/en/` 与 `_locales/zh_CN/` 均已包含在 ZIP 中。
- ZIP 不包含 API Key、个人邮箱截图、测试账号信息或无关文件。

## 2. 更新现有商品的软件包

1. 登录 Chrome Web Store Developer Dashboard。
2. 打开现有 Aluminum 商品，核对现有商品 ID 和当前发布状态。
3. 在该商品的 Package 页面上传 `.output/aluminum-1.1.0-chrome.zip`。
4. 不要通过任何“新商品”流程重复发布 Aluminum。
5. 上传后再次检查 Dashboard 解析出的版本号和权限差异；如果出现计划外的新权限，停止并回到源码核查。

## 3. 填写默认英文商品详情

英文是默认 Store 语言。

1. 从 [chrome-store-listing.en.md](chrome-store-listing.en.md) 粘贴名称、简短说明、类别、单一用途和详细说明。
2. 类别选择 `Productivity`。
3. 上传英文素材目录 `docs/store-assets/en/` 中的文件：
   - `promo-small-440x280.png`
   - `screenshot-01-summary.png`
   - `screenshot-02-evidence.png`
   - `screenshot-03-confirm.png`
   - `screenshot-04-undo.png`
4. 按英文 listing 文档中的顺序填写四条截图说明。
5. 隐私政策默认路由使用 `https://omnimindnb.github.io/aluminum-legal/`。
6. 支持邮箱使用 `liudong.ucas@gmail.com`。

如果 `docs/store-assets/en/` 尚未生成或图片尺寸不正确，停止；先完成本发布计划的本地化素材任务。

## 4. 添加 `zh_CN` 本地化

1. 在 Store listing 的本地化管理中添加 `zh_CN`。
2. 从 [chrome-store-listing.zh-CN.md](chrome-store-listing.zh-CN.md) 粘贴名称、简短说明、类别、单一用途和详细说明。
3. 上传简体中文素材目录 `docs/store-assets/zh-CN/` 中的文件：
   - `promo-small-440x280.png`
   - `screenshot-01-summary.png`
   - `screenshot-02-evidence.png`
   - `screenshot-03-confirm.png`
   - `screenshot-04-undo.png`
4. 按中文 listing 文档中的顺序填写四条截图说明。
5. 中文隐私政策路由为 `https://omnimindnb.github.io/aluminum-legal/zh-CN/`。

如果 `docs/store-assets/zh-CN/` 尚未生成、图片混有英文界面或尺寸不正确，停止；不要用英文素材代替中文本地化素材。

## 5. 填写 Privacy practices

1. 从 [chrome-store-permission-justifications.md](chrome-store-permission-justifications.md) 复制单一用途及每项权限说明。
2. 确认权限清单与 Dashboard 实际显示完全一致。
3. 数据收集总问题选择“是”，并将 `Website content` 标记为收集/处理，用途说明使用权限文档中的可粘贴文案。
4. 如果实时表单沿用 Chrome Web Store 政策中“域名或 URL 属于 web browsing activity”的定义，将 `Web history` 或对应类别标记为收集/处理，并使用权限文档中的说明。
5. 在实时表单中逐项检查 `Personally identifiable information`、`Personal communications` 和 `Authentication information` 的当前定义：
   - 对话和页面内容可能包含用户主动输入或选择的个人信息。
   - 近期对话会直接发送到用户配置的 AI Provider。
   - API Key 仅保存在本机，并作为认证凭据直接发送到已配置的 Provider 端点。
6. 不得因为 Aluminum 没有开发者后端就填写“完全不收集数据”。
7. 仅在实时声明与实际数据流一致时，勾选“不出售数据”“不用于广告”“不用于信贷判断”“不用于与单一用途无关的用途”等承诺。

## 6. 核验双语隐私政策

发布草稿前分别打开并核对：

- 英文 `/`：`https://omnimindnb.github.io/aluminum-legal/`
- 简体中文 `/zh-CN/`：`https://omnimindnb.github.io/aluminum-legal/zh-CN/`

两条路由必须：

- 均可公开访问且使用 HTTPS。
- 结构等价，并包含直接传输到用户配置 AI Provider 的说明。
- 明确 Aluminum 不运营开发者后端，但不声称“没有任何数据离开设备”。
- 包含可用的语言切换和支持邮箱。

任一路由尚未发布或内容与仓库政策文档不一致时，停止并先完成法律站点发布任务。

## 7. 最终草稿检查

- 软件包版本、默认语言、权限和商品 ID 均正确。
- 英文默认 listing 与 `zh_CN` listing 都已保存。
- 两套本地化素材均来自对应目录，尺寸和语言正确。
- 四条截图说明与图片顺序一致。
- 截图不含 API Key、邮箱、浏览器个人资料、无关标签页或第三方受保护内容。
- Privacy practices 的 `Website content` 披露已保存。
- 已按实时定义复核并披露当前页面 URL 与资源 URL 对应的 `Web history` 或 web browsing activity 类别。
- 已按实时 Dashboard 定义复核可能包含个人信息的对话内容及 API Key 类别。
- 英文 `/` 与中文 `/zh-CN/` 隐私政策均已上线。
- 支持邮箱可用。

## 8. 硬停止

保存 Dashboard 草稿并导出或记录最终检查结果。**不要点击 `Submit for review`。**

只有在用户查看完整发布清单并在新的明确指令中确认后，才能执行 `Submit for review`；当前任务必须在该按钮之前停止。
