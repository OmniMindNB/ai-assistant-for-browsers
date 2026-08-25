// lib/agent/tool-call-repair.ts
// 弱模型响应修复层：把不规范的工具调用捞回可用形态。
//
// Runi 的价值主张是「自带 key、任意 OpenAI 兼容端点」，用户很可能接本地小模型
// （Qwen / GLM / Ollama）。这些模型的 tool call 经常不规范，而修复前的行为是：
//   - 参数 JSON.parse 失败 → 静默变成 {}，工具收到空参数后报一个莫名其妙的错；
//   - 干脆没走 tool_calls、把调用写进正文 → 工具根本不执行，用户看到一坨裸 JSON。
// 这里全部是纯函数，不碰网络层，也不放宽任何权限——捞回来的调用照样走 beforeToolCall 权限门。

/** 双重（乃至多重）stringify 的解包上限，防止畸形输入把递归拖长。 */
const MAX_UNWRAP_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 剥掉 markdown 代码围栏；没有围栏就原样返回。 */
function stripFence(text: string): string {
  const match = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(text.trim());
  return match ? match[1] : text;
}

/** 取首个 `{` 到末个 `}` 的跨度，用于把混在散文里的对象抠出来。 */
function outermostObject(text: string): { json: string; start: number; end: number } | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  return { json: text.slice(start, end + 1), start, end: end + 1 };
}

/**
 * 剥围栏后解析，结果仍是字符串就继续解包（覆盖反复 stringify 的情况）。
 *
 * `extract` 决定是否允许把混在散文里的对象抠出来。salvage 路径必须关掉它：那里需要知道
 * JSON 在原文里的**精确跨度**才能把散文留下，若解析函数自己偷偷抠一次，跨度就丢了。
 */
function parseLoosely(raw: string, extract: boolean, depth = 0): unknown {
  const text = stripFence(raw).trim();
  if (!text) return undefined;

  let parsed = tryParse(text);
  if (parsed === undefined && extract) {
    const extracted = outermostObject(text);
    if (extracted) parsed = tryParse(extracted.json);
  }
  if (typeof parsed === 'string' && depth < MAX_UNWRAP_DEPTH) return parseLoosely(parsed, extract, depth + 1);
  return parsed;
}

/**
 * 修复一次工具调用的参数文本。无法救回时返回 {}，与修复前的行为保持一致——
 * 调用方不需要区分「模型给了空参数」和「参数解析失败」。
 */
export function repairToolArguments(raw: string): Record<string, unknown> {
  const parsed = parseLoosely(raw, true);
  return isPlainObject(parsed) ? parsed : {};
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return repairToolArguments(value);
  return isPlainObject(value) ? value : {};
}

export interface SalvagedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** 摘掉 JSON 之后剩下的可见正文，前后散文保留。 */
  strippedText: string;
}

/**
 * 从一个已解析的对象里认出工具调用。只认两种形态：
 *   A. {"name": "browser_click", "arguments"|"input"|"parameters": {...}}  —— OpenAI / Anthropic 形态
 *   B. {"browser_click": {...}}                                            —— 单键 action 形态
 * 名字不在已知工具表里就一律不认，避免凭空造出一次调用。
 */
function recognizeToolCall(parsed: Record<string, unknown>, known: Set<string>): Omit<SalvagedToolCall, 'strippedText'> | undefined {
  const name = parsed.name;
  if (typeof name === 'string' && known.has(name)) {
    return { name, arguments: normalizeArguments(parsed.arguments ?? parsed.input ?? parsed.parameters) };
  }

  const keys = Object.keys(parsed);
  if (keys.length === 1 && known.has(keys[0])) {
    return { name: keys[0], arguments: normalizeArguments(parsed[keys[0]]) };
  }

  return undefined;
}

/** 摘掉 [start, end) 之后把前后两段接回去，避免留下多余空行。 */
function removeSpan(text: string, start: number, end: number): string {
  const before = text.slice(0, start).trim();
  const after = text.slice(end).trim();
  return [before, after].filter(Boolean).join('\n');
}

/**
 * 模型没走 tool_calls 而把调用写进正文时，把它捞回成一次真正的工具调用。
 * 认不出来就返回 undefined，正文原样交给用户。
 */
export function salvageToolCallFromText(text: string, toolNames: string[]): SalvagedToolCall | undefined {
  if (!text.trim() || toolNames.length === 0) return undefined;
  const known = new Set(toolNames);

  // 候选一：整段正文（剥掉围栏后）就是那个 JSON；候选二：JSON 混在散文中间。
  const whole = { json: text, start: 0, end: text.length };
  const embedded = outermostObject(text);
  const candidates = embedded ? [whole, embedded] : [whole];

  for (const candidate of candidates) {
    const parsed = parseLoosely(candidate.json, false);
    if (!isPlainObject(parsed)) continue;
    const call = recognizeToolCall(parsed, known);
    if (!call) continue;
    return { ...call, strippedText: removeSpan(text, candidate.start, candidate.end) };
  }

  return undefined;
}
