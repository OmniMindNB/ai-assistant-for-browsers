// 页面内容脱敏管线：命中敏感信息后替换为完全占位符，不保留任何原始字符
// （ref: docs/superpowers/specs/2026-08-31-page-redaction-pipeline-design.md）。
// 与 lib/shortcuts.ts 同构：chrome.storage.local，不同步到云端。

export interface RedactionRule {
  id: string;
  /** 展示名，同时是占位符文案来源（"手机号" -> "[手机号已脱敏]"）。内置规则的 label 固定中文，不走 i18n。 */
  label: string;
  /** 正则表达式源（不含 flags），运行时以 'g' 编译。 */
  pattern: string;
  enabled: boolean;
  /** true = 内置四类，不可删除，可禁用；false = 用户自定义，可删除可编辑。 */
  builtin: boolean;
}

export interface RedactionSettings {
  enabled: boolean;
  rules: RedactionRule[];
}

export const REDACTION_STORAGE_KEY = 'runi:redaction';

// 顺序即应用顺序：idcard 排在 bankcard 之前，让 18 位数字优先命中更具体的"身份证号"标签
// ——两者的正则都会匹配 18 位数字串，这是已知的简化取舍，不影响脱敏结果本身的正确性。
export const BUILTIN_REDACTION_RULES: RedactionRule[] = [
  { id: 'phone', label: '手机号', pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', enabled: true, builtin: true },
  {
    id: 'email',
    label: '邮箱',
    pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}',
    enabled: true,
    builtin: true,
  },
  { id: 'idcard', label: '身份证号', pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', enabled: true, builtin: true },
  { id: 'bankcard', label: '银行卡号', pattern: '(?<!\\d)\\d{16,19}(?!\\d)', enabled: true, builtin: true },
];

export function defaultRedactionSettings(): RedactionSettings {
  return { enabled: true, rules: BUILTIN_REDACTION_RULES.map((rule) => ({ ...rule })) };
}

export function redactText(text: string, settings: RedactionSettings): string {
  if (!settings.enabled || !text) return text;
  let result = text;
  for (const rule of settings.rules) {
    if (!rule.enabled) continue;
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, 'g');
    } catch {
      // 用户写坏的自定义正则：静默跳过，不影响其余规则或整体调用方（如页面读取）。
      continue;
    }
    result = result.replace(regex, `[${rule.label}已脱敏]`);
  }
  return result;
}

export function newRedactionRuleId(): string {
  return `redaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RedactionPreviewSegment {
  text: string;
  matched: boolean;
}

export interface RedactionPreviewResult {
  /** false 仅表示正则语法当前不合法（用户还在输入）；跟保存时的校验是同一套 `new RegExp`。 */
  ok: boolean;
  segments: RedactionPreviewSegment[];
  matchCount: number;
}

/**
 * 给设置页"添加自定义规则"表单用的实时预览：把 pattern 套到用户粘贴的样例文本上，
 * 标出命中的片段，让用户在保存前就能看出规则是不是匹配到了预期之外/之内的内容——
 * 不复用 redactText() 是因为那里返回的是替换后的占位符文本，看不出"具体命中了哪一段"。
 */
export function previewRedactionMatches(pattern: string, sample: string): RedactionPreviewResult {
  if (!sample) return { ok: true, segments: [], matchCount: 0 };
  if (!pattern.trim()) return { ok: true, segments: [{ text: sample, matched: false }], matchCount: 0 };

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch {
    return { ok: false, segments: [{ text: sample, matched: false }], matchCount: 0 };
  }

  const segments: RedactionPreviewSegment[] = [];
  let lastIndex = 0;
  let matchCount = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sample)) !== null) {
    if (match[0].length === 0) {
      // 零宽匹配（比如误写成只含前瞻，或像 'x*' 在没有 x 的位置也能命中空串）既不推进
      // lastIndex 也不计入结果，只手动步进一位避免死循环——否则每次重复检测到同一个
      // 位置都会当成"新的未匹配片段"重复入队，产生重叠、错误的分段。
      regex.lastIndex += 1;
      continue;
    }
    if (match.index > lastIndex) segments.push({ text: sample.slice(lastIndex, match.index), matched: false });
    segments.push({ text: match[0], matched: true });
    matchCount += 1;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < sample.length) segments.push({ text: sample.slice(lastIndex), matched: false });

  return { ok: true, segments, matchCount };
}

function isValidRedactionSettings(value: unknown): value is RedactionSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.enabled === 'boolean' && Array.isArray(candidate.rules);
}

export async function loadRedactionSettings(): Promise<RedactionSettings> {
  const result = await browser.storage.local.get(REDACTION_STORAGE_KEY);
  const stored = result[REDACTION_STORAGE_KEY];
  if (isValidRedactionSettings(stored)) return stored;
  const defaults = defaultRedactionSettings();
  await saveRedactionSettings(defaults);
  return defaults;
}

export async function saveRedactionSettings(settings: RedactionSettings): Promise<void> {
  await browser.storage.local.set({ [REDACTION_STORAGE_KEY]: settings });
}
