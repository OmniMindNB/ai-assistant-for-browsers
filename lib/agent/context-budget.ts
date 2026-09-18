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
 */

/**
 * 单条只读工具结果在上下文里保留的硬上限（compactAgentMessages 执行）。
 * 这是所有读取路径真正的天花板，`resolveReadMaxChars` 据此夹取。
 */
export const MAX_TOOL_RESULT_CHARS = 30000;

/** 只读工具未指定 maxChars 时的默认读取量。 */
export const DEFAULT_READ_MAX_CHARS = 12000;

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
