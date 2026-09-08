// browser_find_text 的参数解析、文本匹配语义与句柄表合并——纯函数，不碰 DOM、不发消息。
//
// find-text-dom.ts 的注入函数因 executeScript 的序列化约束（见该文件顶部注释）无法在
// 运行时调用这里的任何函数，只能各自内联同款归一化/匹配逻辑——这里的 normalizeFindText/
// matchesFindText 是给 background.ts 和这份测试用的规范定义，不是给注入函数复用的。
import type { FormFieldPathStep } from './form-schema';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';

export type FindTextMode = 'contains' | 'exact';

export interface FindTextParams {
  text: string;
  mode: FindTextMode;
  limit: number;
}

export const DEFAULT_FIND_TEXT_LIMIT = 10;
export const MAX_FIND_TEXT_LIMIT = 20;

export function parseFindTextParams(
  params: unknown,
): { ok: true; params: FindTextParams } | { ok: false; error: string } {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return { ok: false, error: '必须提供 text。' };

  const mode: FindTextMode = record.mode === 'exact' ? 'exact' : 'contains';
  const rawLimit = record.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(MAX_FIND_TEXT_LIMIT, Math.max(1, Math.floor(rawLimit)))
      : DEFAULT_FIND_TEXT_LIMIT;

  return { ok: true, params: { text, mode, limit } };
}

// 与 find-text-dom.ts 内联的同款归一化保持一致：连续空白压成单空格、首尾去空白。
export function normalizeFindText(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function matchesFindText(candidateNormalized: string, queryNormalized: string, mode: FindTextMode): boolean {
  if (!candidateNormalized || !queryNormalized) return false;
  const candidate = candidateNormalized.toLowerCase();
  const query = queryNormalized.toLowerCase();
  return mode === 'exact' ? candidate === query : candidate.includes(query);
}

export interface FindTextHandleInput {
  path: FormFieldPathStep[];
  tag: string;
  type?: string;
  name?: string;
  href?: string;
  frameId: number;
  frameOrigin: string;
}

/**
 * 从上一张句柄表里挑出该留给下一张表的 t* 条目——mergeFindTextHandles 的对称面。
 *
 * background 的 snapshotFields 每次都整表重建，只装它自己发的 f、s 两种前缀；而它在每次
 * 成功写操作之后都会被 collectNewFieldsAfterWrite 悄悄重跑一遍。没有这一步，模型上一轮
 * browser_find_text 拿到的一整批 t* 会在它点掉其中一个之后集体消失，剩下的再点就是
 * 「未知的 fieldId」——而那次重采模型根本不知道发生过。
 *
 * 模型主动重新调用 browser_get_form 时整表覆写（含 t*）是另一回事，那是它自己表示
 * 「页面状态已经变了」，旧的文字句柄本就不该继续被信任（ref: tab-form-fields.ts）。
 */
export function keepFindTextHandles(
  previous: FormFieldTable | undefined,
  currentUrl: string,
): Record<string, FormFieldHandle> {
  if (!previous || previous.url !== currentUrl) return {};
  const kept: Record<string, FormFieldHandle> = {};
  for (const [fieldId, handle] of Object.entries(previous.fields)) {
    if (fieldId.startsWith('t')) kept[fieldId] = handle;
  }
  return kept;
}

// 把这一轮 find_text 命中并入现有句柄表：保留 f*/s*（browser_get_form 发放的句柄），
// 只替换上一轮 find_text 自己发放的 t*——这一轮的命中集合已经变了，旧的不该继续被信任，
// 与 browser_get_form 每次整表覆写是同一个理由（ref: 设计文档 §4.4）。
//
// 换了页面（existing.url 与 currentUrl 不符）时连 f*/s* 也不保留：它们本就对着别的页面，
// 硬并入只会在下次写入时统一因 url 不符判 stale，保留没有意义。
export function mergeFindTextHandles(
  existing: FormFieldTable | undefined,
  currentUrl: string,
  hits: FindTextHandleInput[],
): FormFieldTable {
  const keepExisting = existing !== undefined && existing.url === currentUrl;
  const fields: Record<string, FormFieldHandle> = {};

  if (keepExisting) {
    for (const [fieldId, handle] of Object.entries(existing!.fields)) {
      if (!fieldId.startsWith('t')) fields[fieldId] = handle;
    }
  }

  hits.forEach((hit, index) => {
    fields[`t${index + 1}`] = {
      path: hit.path,
      // applyFormFill 的 matchesExpect 比对 tag/type/name/href（不比对 label）：漏填
      // type/name 会让一个本身带这些属性的真实元素在写入前被误判成 mismatch。
      expect: { tag: hit.tag, type: hit.type, name: hit.name, href: hit.href },
      sensitive: false,
      // 不是真的可点击控件，只是借用同一张句柄表让 browser_click 能定位到它——
      // 只要不是 'scrollable'，planFieldClick 就会放行；kind 的具体取值本身不会被
      // applyFormFill 的提交分支读取（它只用 path/expect），选 'button' 只是为了在
      // 旁人读句柄表时语义上说得通（ref: lib/agent/fill-form-request.ts 的
      // planFieldClick / planFieldScroll）。
      kind: 'button',
      // 与 snapshotFields 同一惯例：句柄表里的 frameOrigin 无论主/子帧都完整保存，
      // 是否在写入时转发由 resolveExpectOrigin/isChildFrameHandle 决定，不在这里过滤
      // （ref: fill-form-request.ts "2026-09-05 final review Important #1"）。
      frameId: hit.frameId,
      frameOrigin: hit.frameOrigin,
    };
  });

  return {
    url: currentUrl,
    fields,
    fingerprints: keepExisting ? existing!.fingerprints : undefined,
  };
}
