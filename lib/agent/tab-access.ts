// 按目标标签页分级的第二道闸门（ref: 2026-09-05-cross-tab-context-design.md §4.2）。
//
// 为什么不塞进 permissions.ts：decideToolPermission 是只看 args 的纯函数，压根不知道这次调用
// 落在哪个 tab 上；把 per-tab 规则塞进去会毁掉"工具分级只有一处事实来源"这条性质。
// 本模块只新增拒绝，不为任何工具放宽既有分级。
import { WRITE_TOOL_NAMES } from './permissions';
import { tabAccessOf, type TrackedTab } from './tab-session';

export type TabAccessDecision = { allowed: true } | { allowed: false; reason: string };

export function decideTabAccess(toolName: string, target: TrackedTab | undefined): TabAccessDecision {
  if (!WRITE_TOOL_NAMES.has(toolName)) return { allowed: true };

  // 解析不出目标意味着会话状态已经不一致，此时放行等于赌一把。保守拒绝。
  if (!target) {
    return {
      allowed: false,
      reason: `无法确认 ${toolName} 的目标标签页，出于安全考虑已拒绝执行。请先用 browser_list_tabs 确认当前可操作的标签页。`,
    };
  }

  if (tabAccessOf(target) === 'read') {
    return {
      allowed: false,
      reason:
        `标签页 ${target.id} 是用户通过 @ 引用进来的只读标签页，不能在上面执行 ${toolName} 这类写操作。`
        + '需要修改页面时，请用 browser_open_tab 另开一个页面去做，或用 ask_user 请用户授权。'
        + '不要重试同一个调用。',
    };
  }

  return { allowed: true };
}
