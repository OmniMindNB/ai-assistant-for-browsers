import { describe, it, expect } from 'vitest';
import { READ_ONLY_TOOL_NAMES, AUTO_APPROVE_TOOL_NAMES } from './permissions';
import { toolCategory, type ToolCategory } from './activity-category';

describe('toolCategory', () => {
  // 这条是给未来的自己留的闸门：permissions.ts 的两个 Set 是工具的权威清单，
  // 新增一个工具却忘了归类，这里就会红——而不是等到界面上冒出一个没有图标的步骤。
  it('covers every tool registered in permissions.ts', () => {
    const all = [...READ_ONLY_TOOL_NAMES, ...AUTO_APPROVE_TOOL_NAMES];
    const uncategorized = all.filter((name) => toolCategory(name) === undefined);
    expect(uncategorized).toEqual([]);
  });

  it('groups read-only inspection tools under read', () => {
    expect(toolCategory('browser_read_page')).toBe<ToolCategory>('read');
    expect(toolCategory('browser_get_form')).toBe<ToolCategory>('read');
    expect(toolCategory('browser_query_dom')).toBe<ToolCategory>('read');
    expect(toolCategory('browser_inspect_page_implementation')).toBe<ToolCategory>('read');
  });

  // 改页面和操作页面分开：前者动的是内容，后者动的是控件。用户读这条时间线时
  // 最在意的正是"它改了什么"，跟"它点了什么"不该共用一个图标。
  it('separates content writes from interaction', () => {
    expect(toolCategory('browser_modify_dom')).toBe<ToolCategory>('write');
    expect(toolCategory('browser_set_style')).toBe<ToolCategory>('write');
    expect(toolCategory('browser_set_storage')).toBe<ToolCategory>('write');
    expect(toolCategory('browser_click')).toBe<ToolCategory>('interact');
    expect(toolCategory('browser_fill_form')).toBe<ToolCategory>('interact');
    expect(toolCategory('browser_type')).toBe<ToolCategory>('interact');
    expect(toolCategory('browser_scroll')).toBe<ToolCategory>('interact');
  });

  it('groups tab and address-bar movement under navigate', () => {
    expect(toolCategory('browser_navigate')).toBe<ToolCategory>('navigate');
    expect(toolCategory('browser_open_tab')).toBe<ToolCategory>('navigate');
    expect(toolCategory('browser_switch_tab')).toBe<ToolCategory>('navigate');
    expect(toolCategory('browser_go_back')).toBe<ToolCategory>('navigate');
  });

  it('gives the waiting, asking and reporting tools their own categories', () => {
    expect(toolCategory('wait')).toBe<ToolCategory>('wait');
    expect(toolCategory('browser_wait_for')).toBe<ToolCategory>('wait');
    expect(toolCategory('ask_user')).toBe<ToolCategory>('ask');
    expect(toolCategory('report_task_outcome')).toBe<ToolCategory>('report');
    expect(toolCategory('browser_screenshot')).toBe<ToolCategory>('screenshot');
  });

  it('returns undefined for an unknown tool rather than guessing', () => {
    expect(toolCategory('browser_do_something_new')).toBeUndefined();
  });
});
