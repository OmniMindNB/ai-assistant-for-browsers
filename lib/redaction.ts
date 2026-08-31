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
