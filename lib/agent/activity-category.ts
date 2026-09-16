/**
 * 工具的展示类别：决定活动时间线上画哪个图标。
 *
 * 与 activity-description.ts 是一对平级的模块——那个管"这一步说什么"（要过 i18n），
 * 这个管"这一步画什么"（跟语言无关）。分开也是为了让图标不随文案改动而漂。
 *
 * 类别按**用户关心的差别**划分，不是按 permissions.ts 的读写分级：'write' 和 'interact'
 * 在权限上同属 auto_allow，但用户读时间线时最想认出来的恰恰是"它改了页面内容"与
 * "它点了个按钮"的区别，所以这里拆成两类。
 */
export type ToolCategory =
  | 'read'
  | 'screenshot'
  | 'write'
  | 'interact'
  | 'navigate'
  | 'wait'
  | 'ask'
  | 'report';

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  // 读取：只看不动，包括聚合巡检工具。
  browser_read_page: 'read',
  browser_get_active_tab: 'read',
  browser_query_dom: 'read',
  browser_find_text: 'read',
  browser_inspect_page_implementation: 'read',
  browser_get_html: 'read',
  browser_get_scripts: 'read',
  browser_get_stylesheets: 'read',
  browser_get_computed_style: 'read',
  browser_get_page_meta: 'read',
  browser_get_storage: 'read',
  browser_get_form: 'read',
  browser_list_tabs: 'read',

  browser_screenshot: 'screenshot',

  // 改写：动的是页面内容或存储本身。
  browser_set_style: 'write',
  browser_modify_dom: 'write',
  browser_set_storage: 'write',

  // 交互：动的是控件，模拟用户的手。
  browser_click: 'interact',
  browser_fill_form: 'interact',
  browser_type: 'interact',
  browser_press_key: 'interact',
  browser_select: 'interact',
  browser_scroll: 'interact',

  // 导航：换的是"在哪个页面上"。
  browser_navigate: 'navigate',
  browser_go_back: 'navigate',
  browser_open_tab: 'navigate',
  browser_close_tab: 'navigate',
  browser_switch_tab: 'navigate',

  wait: 'wait',
  browser_wait_for: 'wait',

  ask_user: 'ask',
  report_task_outcome: 'report',
};

/** 未知工具返回 undefined，由调用方决定兜底画什么——这里不猜。 */
export function toolCategory(toolName: string): ToolCategory | undefined {
  return CATEGORY_BY_TOOL[toolName];
}
