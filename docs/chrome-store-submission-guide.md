# Chrome Web Store 上架操作指南

最后更新：2026-07-21

本指南覆盖代码之外的上架流程：开发者账号注册、素材准备、Dashboard 表单填写、提交与审核
跟进。代码层的合规修复见 [Spec-0002](specs/0002-chrome-web-store-remote-code-compliance.md)
（已实现并合并）。文档层的权限/隐私材料已提前准备好，见
[chrome-store-permission-justifications.md](chrome-store-permission-justifications.md) 和
[privacy-policy.md](privacy-policy.md)。

## 提交前必须先做的一件事

在开始下面的流程之前，先完成 Spec-0002 的**人工验证**（`browser_inject_script` 迁移到
`chrome.userScripts` 后，只能在真实 Chrome 浏览器里手动验证，没有工具能代替）。**这一步已在
2026-07-24 完成并通过**——详见
[2026-07-23-turn-tabid-pinning-and-userscripts-wait.md](superpowers/plans/2026-07-23-turn-tabid-pinning-and-userscripts-wait.md)
Task 9 Step 2 的完整记录。行为已从最初"开关关闭时一次性报错"升级为"等待+每 2.5 秒自动重试、最多
等 3 分钟，期间可取消"，具体验证过的路径：

1. 开关关闭时触发 `browser_inject_script`（如"给页面加阅读模式"）→ 侧边栏显示等待中提示，重试
   次数递增；点「🔧 前往开启」新开设置页，开启开关后**无需切回原标签页或重新提问**，等待条自动
   消失且页面改造生效；`browser_revert_changes` 能正确还原原网页。
2. 等待期间点「取消等待」/ 全局「停止」→ 等待卡片立刻消失，不再重试。
3. 等待期间直接「新建对话」（孤儿轮询检查）→ 等待条立刻消失，不再有迟到的重试请求。

如果后续改动了 `lib/agent/tools.ts` 里的等待重试逻辑，需要重新走一遍上述验证，避免这个核心功能在
提交后才发现坏了——那会浪费一轮审核周期（可能是几天到几周）。

## 第 1 步：注册开发者账号

1. 访问 Chrome Web Store Developer Dashboard，用你打算长期维护这个扩展的 Google 账号登录。
2. 支付一次性 **5 美元**注册费（终身有效，覆盖你未来发布的所有扩展，不是按扩展收费）。
3. 账号设置里会要求填写"Trader"（贸易者）身份声明——这是欧盟《数字服务法》(DSA) 驱动的新
   要求，如实填写"我不是以贸易者身份发布此扩展"（个人非商业开发者通常选此项）即可，除非你是
   以公司实体注册。
4. 可选但推荐：完成邮箱验证和开发者身份验证，有助于获得"Established Publisher"标识，减少
   用户对权限较广的扩展的信任门槛（本扩展请求 `<all_urls>`，身份可信度会被更严格地考察）。

## 第 2 步：准备上架素材

代码里已有的 `public/icons/icon-{16,32,48,128}.png` 满足扩展本身的图标要求，但 Store **listing
页面**还需要额外的营销素材，这些不在代码仓库里，需要单独制作：

| 素材 | 尺寸 | 是否必需 | 说明 |
|---|---|---|---|
| 小型宣传图 | 440×280 px | **必需** | PNG/JPEG，展示在搜索结果和分类页 |
| 截图 | 1280×800 px（或 640×400） | **必需**，1~5 张 | 建议至少 3 张：对话总结场景、页面改造确认卡片场景、撤销条场景——展示"每次改动都需确认+可撤销"这个安全卖点 |
| Marquee 宣传图 | 1400×560 px | 可选 | 只有想被 Chrome 编辑精选（marquee 首页推荐）才需要，可以先跳过 |

准备时优先呈现「确认卡片」「撤销条」这类体现安全设计的界面截图——这与你在
`docs/privacy-policy.md` 里强调的"不收集数据、本地优先"叙事一致，也有助于审核员快速理解
功能边界。

## 第 3 步：撰写 Listing 文案

- **名称**：`Aluminum`（已在 manifest 中）。
- **简介 / 详细描述**：用一句话讲清"单一目的"（Single Purpose Policy 要求）——建议类似
  "AI 助手侧边栏：总结、问答、并在你确认后自动化改造当前网页"，避免把"总结/问答"和
  "自动化改造/脚本注入"描述成两个不相关的功能堆砌，而是统一叙述为"一个 AI 助手覆盖的连续
  能力"，呼应审核时对 Single Purpose 的检查。
- **类别**：建议选择"Productivity"或"Workflow & Planning"（不要选和实际功能无关的类目，
  Google 会检查类目与实际功能是否匹配）。
- **语言**：中文为主，如面向更广用户可补一份英文描述（本项目文档已是中英双语材料，可直接
  复用 `docs/chrome-store-permission-justifications.md` 里已经写好的英文措辞风格）。

## 第 4 步：打包扩展

```bash
pnpm zip
```

这会跑 `wxt zip`，产出可直接上传的 `.zip`（通常在 `.output/` 目录下，文件名类似
`aluminum-1.0.0-chrome.zip`）。上传前建议再跑一次：

```bash
pnpm compile && pnpm test && pnpm build
```

确认三者都通过，再基于最新 `pnpm build` 产物打包，避免上传一个包含未验证改动的包。

## 第 5 步：填写 Dashboard 表单

在 Developer Dashboard 创建新条目，上传 zip 后，重点是「Privacy practices」标签页，这是审核
最容易卡住的部分：

1. **Permissions justification（权限用途说明）**：Dashboard 会要求为每条权限单独填写用途。
   直接复制 [chrome-store-permission-justifications.md](chrome-store-permission-justifications.md)
   里对应权限的中/英文文案（`activeTab`、`tabs`、`scripting`、`storage`、`sidePanel`、
   `userScripts`、`host_permissions: <all_urls>` 均已写好）。
2. **Data collection disclosure（数据使用披露问卷）**：按该文档"关于数据使用披露表单"一节
   给出的勾选建议填写（Website content 勾"是"并注明用途，其余勾"否"）。
3. **隐私政策 URL**：填入 `https://omnimindnb.github.io/aluminum-legal/`（渲染后的 GitHub
   Pages 页面，**不要**填 GitHub 仓库里 `.md` 文件的 blob 链接，那只显示源码）。
4. **单一目的说明**：如果 Dashboard 单独询问"这个扩展的单一目的是什么"，用第 3 步里写的
   那句话，保持和 Listing 描述一致，避免自相矛盾。

## 第 6 步：提交与审核预期

- 本扩展声明了 `host_permissions: ["<all_urls>"]`。这是触发人工深度审核（Track 2）的最强
  信号之一——Dashboard 提交时通常会直接提示"此权限组合需要深度审核，可能延迟发布"。据观察，
  仅请求 `activeTab` 的扩展可能几分钟到一小时内通过自动审核，而带 `<all_urls>` 的扩展常见
  审核周期是**几天到数周**，2026 年因提交量上升审核队列本身也变长了。据此规划时间：**不要**
  假设能在 2026-08-01 政策强制生效前来得及首次提交并通过审核——这次代码迁移的目的是让扩展在
  提交时就合规，而不是卡着截止日期抢发布。
- 如果审核员发来邮件要求补充说明（常见问题：为什么需要 `<all_urls>`、`userScripts` 具体怎么
  使用、为什么要注入脚本到页面），直接引用 `docs/chrome-store-permission-justifications.md`
  和 [Spec-0002](specs/0002-chrome-web-store-remote-code-compliance.md) 里的说明来回复即可——
  这些材料已经是为审核场景准备的。
- 如果被拒绝，Dashboard 会给出具体政策条款引用；先对照
  [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
  确认理解拒绝原因，再决定是申诉还是调整后重新提交，避免盲目重复提交同一版本。

## 第 7 步：发布后

- Dashboard 里可选择 Public（公开可搜索）/ Unlisted（仅知道链接可安装）/ Private（仅指定
  账号可见）。首次发布建议先选 Unlisted，邀请几个真实用户试用几天确认无异常后再切换 Public，
  这样万一发现问题可以先撤下而不影响公开可见度和评分。
- 后续如果修改了 `manifest.permissions` 或 `host_permissions`（例如以后要收窄 `<all_urls>`
  的范围），提交更新版本时权限变化会再次触发人工审核，同样需要更新
  `chrome-store-permission-justifications.md` 并同步到 Dashboard 的说明文本。

## 参考资料

- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [Supplying Images](https://developer.chrome.com/docs/webstore/images)
- [Creating a great listing page](https://developer.chrome.com/docs/webstore/best-listing)
- [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)
