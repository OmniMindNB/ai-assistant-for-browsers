// 每个标签页暂存 browser_get_form 发放的字段句柄表：fieldId → 定位路径 + 期望结构。
// 持久化到 browser.storage.session（而非模块级变量）：MV3 service worker 会被回收，
// 模块级变量活不过这次回收，只有 storage.session 能跨重启存活且不落盘。
// 写法仿 lib/agent/tab-pending-ask.ts。
import type { FormFieldKind } from '@/lib/messaging';
import type { FormFieldPathStep } from './form-schema';

export interface FormFieldHandle {
  path: FormFieldPathStep[];
  /** 写入前用来做字面比对的期望结构，不符即 mismatch（ref: Spec-0005 §写入校验矩阵）。 */
  expect: { tag: string; type?: string; name?: string; label?: string };
  sensitive: boolean;
  kind: FormFieldKind;
}

export interface FormFieldTable {
  /** 发放句柄时页面的 URL，写入时比对，用于识别「表已过期」。 */
  url: string;
  fields: Record<string, FormFieldHandle>;
}

function storageKey(tabId: number): string {
  return `runi:tab-form-fields:${tabId}`;
}

export async function getFormFieldsForTab(tabId: number): Promise<FormFieldTable | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as FormFieldTable | undefined;
}

/** 写入失败（如配额超限）时静默降级：不抛出、不阻塞调用方，这次的句柄表就当没发放。 */
export async function setFormFieldsForTab(tabId: number, table: FormFieldTable): Promise<void> {
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: table });
  } catch {
    // 静默降级，见上方注释
  }
}

export async function clearFormFieldsForTab(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}
