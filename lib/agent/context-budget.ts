/**
 * 读取量与上下文规模的唯一真相。
 *
 * 此前这两个数字分居两处、互不知情：`tools.ts` 的 `browser_read_page` 默认读 12000 字符
 * 且对模型填的 maxChars 只有下限没有上限，而 `agent.ts` 的 compactAgentMessages 又会把
 * 任何工具结果切到 30000。于是模型填 60000 时会先拿到一条"正文已截断到 60000 字符"，
 * 再被压缩层切一刀补上一条"工具结果已截断"，两条提示互相矛盾，而模型无从知道真正的
 * 天花板是多少——它只会继续把 maxChars 往上加。
 *
 * 这里的分工与 `system-prompt.ts` 收拢工具预算常量是同一个理由：模型自以为的上限和真正
 * 执行的上限必须来自同一个常量，否则一定会漂移。
 *
 * ⚠️ 数值的锚点是**内容**，不是窗口（2026-09-20 重新推导，ref:
 * docs/superpowers/specs/2026-09-20-context-budget-for-long-window-models-design.md §5）。
 * 早先这套数字是从 `createModel` 声明的 128k 窗口倒推的，而支持范围内模型的窗口下限现在
 * 已是 1M——窗口不再是约束。取而代之的判据是"单条只读结果要能装下最长的一个真实网页
 * 正文"：网页可读正文超过 20 万字符的实际上不存在（典型长文档页 3 万到 8 万）。
 * 没有按窗口比例放大，是因为 1M 下的实际约束变成了首 token 延迟和长上下文的中间遗忘，
 * 而产品取舍是"够用就好：只消灭截断类失效，不主动占满窗口"。
 */

/**
 * 单条只读工具结果在上下文里保留的硬上限（compactAgentMessages 执行）。
 * 这是所有读取路径真正的天花板，`resolveReadMaxChars` 据此夹取。
 * 取值依据见文件头：装得下最长的一个真实网页正文。
 */
export const MAX_TOOL_RESULT_CHARS = 200_000;

/**
 * 只读工具未指定 maxChars 时的默认读取量。
 *
 * `browser_read_page` 改走"整页放得下就整页"之后（page-read-window.ts），这个值只在两种
 * 情况下生效：正文超过 MAX_TOOL_RESULT_CHARS 时的分段起步量，以及 browser_get_html /
 * get_scripts / get_stylesheets（经 read-request.ts）。后三者是低密度内容——HTML 里大部分
 * 是标签和类名——没有证据表明需要跟着上限一起放大。
 */
export const DEFAULT_READ_MAX_CHARS = 24000;

/**
 * 模型填的 maxChars 的下限。模型偶尔会填 10、100 这类值，读回来的正文不足以回答问题，
 * 只会白白多花一轮重读。
 */
export const MIN_READ_MAX_CHARS = 1000;

/**
 * 把模型填的 maxChars 归一到 [MIN_READ_MAX_CHARS, MAX_TOOL_RESULT_CHARS]。
 * 所有只读工具都必须走这里，不要再各自写 `Math.max(1000, raw ?? 12000)`。
 */
export function resolveReadMaxChars(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_READ_MAX_CHARS;
  return Math.min(MAX_TOOL_RESULT_CHARS, Math.max(MIN_READ_MAX_CHARS, Math.floor(raw)));
}

/**
 * 图片在上下文预算里的字符当量。
 *
 * 绝不能按 base64 长度计：一张 1280px 截图的 base64 约 200 万字符
 * （SCREENSHOT_MAX_BYTES 1.5MB × 4/3），按长度计等于每次截图都把窗口清空。而它换算成
 * token 只有一千多，这里按「1 token ≈ 3 字符」的混合中英口径折回字符。
 */
export const IMAGE_CHAR_EQUIVALENT = 5000;

/**
 * 上下文字符预算的高水位 / 低水位，语义与 MAX_CONTEXT_MESSAGES / CONTEXT_RECUT_TARGET
 * 完全对应：超过高水位才重切一次到低水位，两次重切之间窗口起点不动，请求前缀只增不改。
 *
 * 为什么条数之外还要一道字符预算：条数裁剪的隐含前提是「每条消息都不大」，而这个前提有
 * 两个现成的破法——带附件的 user 消息（永远不进摘要压缩），以及只读结果的上限。两者都不会
 * 让条数越线，于是窗口一条都不切，请求直接撞供应商的 400 context length exceeded：失败
 * 发生在服务端，用户等完一整轮却拿不到任何回答。
 *
 * 低水位取 MAX_TOOL_RESULT_CHARS 之上一档，保证一次满额读取加上少量历史仍装得下；
 * 高水位再留一层缓冲。注意两者不再维持旧版 2/3 的比例——锚点换成绝对量之后，比例是
 * 推导的副产物而不是约束。这样做安全，是因为 compactAgentMessages 会把**非最新**的只读
 * 结果压成一行摘要，历史里不可能同时存在两份满额读取。
 *
 * 最坏情况校验（中文最保守口径 1 字符 ≈ 1 token）：350000 + 约 25000 的系统提示词与工具表
 * + 16000 的 maxTokens ≈ 391000 token，仍只占 1M 窗口的四成，agent.test.ts 有对应的不变量用例。
 *
 * ⚠️ 这是兜底，不是日常路径：典型会话只有几千到几万字符，正常运行碰不到高水位。
 */
export const MAX_CONTEXT_CHARS = 350_000;
export const CONTEXT_RECUT_TARGET_CHARS = 250_000;

/**
 * 上下文规模的 token 代理量：文本按字符数，图片按固定当量，工具调用参数按序列化长度。
 *
 * 与 agent.ts 里那个只数文本的 countMessageChars 不是一回事——那个是 perf 遥测，量的是
 * 请求体里的文本体积；这个是预算判据，量的是「折算成 token 有多贵」，所以图片不能按
 * base64 长度计，而工具调用参数必须计（模型可以往 browser_modify_dom 的 html 里塞几万字符）。
 */
export function contextCostChars(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      total += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = (part as { type?: string }).type;
      if (type === 'text') {
        total += String((part as { text?: string }).text ?? '').length;
      } else if (type === 'image') {
        total += IMAGE_CHAR_EQUIVALENT;
      } else if (type === 'toolCall') {
        total += safeArgumentChars((part as { arguments?: unknown }).arguments);
      }
    }
  }
  return total;
}

/** 参数里可能有循环引用或不可序列化的值；量不出来就当 0，绝不能让度量函数自己抛错。 */
function safeArgumentChars(args: unknown): number {
  if (args === undefined || args === null) return 0;
  try {
    return JSON.stringify(args)?.length ?? 0;
  } catch {
    return 0;
  }
}
