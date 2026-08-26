// 统一消息协议（ref: technical-plan.md §3.3）
// 用于 Side Panel ↔ Service Worker ↔ Content Script 之间的通信。

export type MessageType =
  | 'PING'
  | 'EXTRACT_PAGE'
  | 'GET_SELECTION'
  | 'ASK_SELECTION'
  | 'GET_ACTIVE_TAB'
  | 'QUERY_DOM'
  | 'GET_HTML'
  | 'GET_SCRIPTS'
  | 'GET_STYLESHEETS'
  | 'GET_COMPUTED_STYLE'
  | 'GET_PAGE_META'
  | 'GET_FORM'
  | 'FILL_FORM'
  | 'PROBE_CLICK_TARGET'
  | 'CAPTURE_SCREENSHOT'
  | 'SET_STYLE'
  | 'MODIFY_DOM'
  | 'CLICK_ELEMENT'
  | 'TYPE_TEXT'
  | 'SELECT_OPTION'
  | 'SCROLL_PAGE'
  | 'NAVIGATE_TAB'
  | 'OPEN_NEW_TAB'
  | 'CLOSE_TAB'
  | 'SET_STORAGE'
  | 'SET_AGENT_OVERLAY'
  | 'CHAT';

export interface Message<T = unknown> {
  /** 请求唯一 ID，便于流式分片匹配 */
  id: string;
  type: MessageType;
  payload?: T;
  /**
   * 本次操作要作用的标签页 ID。由侧边栏在回合开始时解析一次并透传，
   * background.ts 用它代替临时查询"当前激活标签页"，避免等待期间
   * 打开设置页等操作改变激活标签页后，后续工具调用跟错目标
   * （ref: docs/superpowers/specs/2026-07-23-turn-tabid-pinning-and-userscripts-wait-design.md）。
   * GET_ACTIVE_TAB 本身不需要它——它的语义就是"查询当前激活标签页"。
   */
  tabId?: number;
  /** 是否为流式响应 */
  stream?: boolean;
}

export interface MessageResponse<T = unknown> {
  id: string;
  ok: boolean;
  data?: T;
  error?: string;
}

/** 当前激活标签页的基础信息。 */
export interface ActiveTabInfo {
  id: number;
  title?: string;
  url?: string;
}

/** EXTRACT_PAGE 返回的页面数据 */
export interface PageContent {
  title: string;
  url: string;
  lang: string;
  /** 纯文本正文（Phase 1 接入 Readability 优化） */
  text: string;
  /** 提取到的字符数 */
  length: number;
}

/** GET_SELECTION 返回的页面选区数据 */
export interface PageSelection {
  text: string;
}

/** ASK_SELECTION：content script 主动上报"用户点击了划词提问气泡"，携带选中的文本。 */
export interface AskSelectionPayload {
  text: string;
}

export interface QueryDomPayload {
  selector: string;
  limit?: number;
  includeText?: boolean;
}

export interface DomNodeSummary {
  index: number;
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

export interface QueryDomResult {
  selector: string;
  count: number;
  truncated: boolean;
  nodes: DomNodeSummary[];
}

export interface GetHtmlPayload {
  selector?: string;
  maxChars?: number;
}

export interface GetHtmlResult {
  selector: string;
  count: number;
  html: string;
  length: number;
  truncated: boolean;
}

export interface GetScriptsPayload {
  includeInline?: boolean;
  includeExternal?: boolean;
  maxChars?: number;
}

export interface PageScriptInfo {
  index: number;
  src?: string;
  type?: string;
  async: boolean;
  defer: boolean;
  text?: string;
  length: number;
  truncated: boolean;
  error?: string;
}

export interface GetScriptsResult {
  count: number;
  scripts: PageScriptInfo[];
  truncated: boolean;
}

export interface GetStylesheetsPayload {
  includeInline?: boolean;
  includeExternal?: boolean;
  maxChars?: number;
}

export interface PageStylesheetInfo {
  index: number;
  href?: string;
  ownerTag?: string;
  text?: string;
  length: number;
  truncated: boolean;
  error?: string;
}

export interface GetStylesheetsResult {
  count: number;
  stylesheets: PageStylesheetInfo[];
  truncated: boolean;
}

export interface GetComputedStylePayload {
  selector: string;
  props?: string[];
}

export interface GetComputedStyleResult {
  selector: string;
  found: boolean;
  styles: Record<string, string>;
}

export interface PageMetaResult {
  title: string;
  url: string;
  lang: string;
  charset: string;
  viewport?: string;
  scripts: number;
  stylesheets: number;
  frameworkHints: string[];
}

export interface CaptureScreenshotPayload {
  format?: 'png' | 'jpeg';
  quality?: number;
}

export interface CaptureScreenshotResult {
  dataUrl: string;
}

export interface SetStylePayload {
  selector: string;
  styles: Record<string, string>;
}

export interface SetStyleResult {
  selector: string;
  matched: number;
}

export interface ModifyDomPayload {
  selector: string;
  action: 'remove' | 'setText' | 'setHtml' | 'setAttribute' | 'addClass' | 'removeClass';
  value?: string;
  attribute?: string;
}

export interface ModifyDomResult {
  selector: string;
  matched: number;
  action: ModifyDomPayload['action'];
}

export interface ClickElementPayload {
  selector?: string;
  index?: number;
  /** browser_get_form 发放的字段句柄，优先于 selector。 */
  fieldId?: string;
}

export interface ClickElementResult {
  selector: string;
  matched: number;
  clickedIndex: number | null;
  status: 'ok' | 'not_found' | 'not_clickable' | 'not_writable' | 'invalid_value' | 'blocked_sensitive';
  detail?: string;
  /** 句柄表已失效（页面已导航或 storage 丢失），模型必须重新调用 browser_get_form。 */
  fieldsTableStale?: boolean;
  /** 被点元素的可见文案，供模型确认自己点中的是不是想点的东西。页面可控，已净化截断。 */
  label?: string;
  /** 命中 <a target="_blank">：当前标签页不会变化，必须点破，否则模型会一直等它变。 */
  opensNewTab?: boolean;
  /** 本次点击之后页面新出现的可交互元素（下拉建议、展开的菜单项等）。句柄表已同步刷新。 */
  newFields?: FormFieldDescriptor[];
}

export interface TypeTextPayload {
  selector: string;
  index?: number;
  text: string;
  replace?: boolean;
}

export interface TypeTextResult {
  selector: string;
  matched: boolean;
  value: string;
  status: 'ok' | 'not_found' | 'not_clickable' | 'not_writable' | 'invalid_value' | 'blocked_sensitive';
  detail?: string;
  actualValue?: string;
  /** 本次输入之后页面新出现的可交互元素（典型如自动补全下拉）。句柄表已同步刷新。 */
  newFields?: FormFieldDescriptor[];
}

export interface SelectOptionPayload {
  selector: string;
  index?: number;
  value: string;
}

export interface SelectOptionResult {
  selector: string;
  matched: boolean;
  value: string;
  status: 'ok' | 'not_found' | 'not_clickable' | 'not_writable' | 'invalid_value' | 'blocked_sensitive';
  detail?: string;
  actualValue?: string;
}

export interface ScrollPagePayload {
  selector?: string;
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
}

export interface ScrollPageResult {
  selector?: string;
  x: number;
  y: number;
  /** 垂直方向的实际位移，正数向下。滚不动时为 0。 */
  scrolledBy: number;
  /** 视口上方 / 下方尚未查看的像素数，用来告诉模型「还剩多少没看」。 */
  pixelsAbove: number;
  pixelsBelow: number;
  /** 换算「约几屏」用；取不到时为 0，文案会省略屏数提示。 */
  viewportHeight: number;
}

export interface NavigateTabPayload {
  url: string;
}

export interface NavigateTabResult {
  /** 跳转结束后的实际地址；与 requestedUrl 不同即发生过重定向。 */
  url: string;
  /** 调用方请求的地址，仅在与 url 不同时才有意义。 */
  requestedUrl?: string;
  /** 落地页标题，页面可控，已净化截断。 */
  title?: string;
}

export interface OpenNewTabPayload {
  url: string;
}

export interface OpenNewTabResult {
  id: number;
  /** 落地页地址；跳转过程中可能发生重定向。 */
  url: string;
  /** 落地页标题，页面可控，已净化截断。 */
  title?: string;
}

export interface CloseTabResult {
  closed: true;
  tabId: number;
}

export interface SetStoragePayload {
  area: 'local' | 'session';
  key: string;
  value: string | null;
}

export interface SetStorageResult {
  area: 'local' | 'session';
  key: string;
}

/**
 * 执行期遮罩的开关。label 必须由侧边栏本地化好再传下来——内容脚本跑在每个页面里，
 * 不能为几句文案把完整 i18n 字典打进产物（同 entrypoints/content.ts 顶部的说明）。
 */
export interface SetAgentOverlayPayload {
  active: boolean;
  label?: string;
}

export interface SetAgentOverlayResult {
  active: boolean;
}

export type FormFieldKind =
  | 'text' | 'textarea' | 'select' | 'checkbox' | 'radio'
  | 'contenteditable' | 'file' | 'submit' | 'button' | 'link' | 'unsupported';

export interface FormFieldDescriptor {
  fieldId: string;
  kind: FormFieldKind;
  type?: string;
  name?: string;
  label?: string;
  /** 仅 kind === 'link' 时有值。 */
  href?: string;
  placeholder?: string;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  /** 敏感字段不返回值，只给 valueState。 */
  value?: string;
  valueState: 'filled' | 'empty';
  checked?: boolean;
  options?: { value: string; label: string; selected: boolean }[];
  sensitive: boolean;
  writable: boolean;
  clickable: boolean;
  fingerprint: string;
  formId?: string;
  validationMessage?: string;
  /** 相对上一次快照新出现的元素（下拉建议、展开的菜单项等）。首次读取该页面时不标记。 */
  isNew?: boolean;
}

export interface GetFormPayload {
  selector?: string;
  includeHidden?: boolean;
}

export interface GetFormResult {
  forms: { formId: string; name?: string; action?: string; method?: string; submitFieldIds: string[] }[];
  fields: FormFieldDescriptor[];
  orphanFieldIds: string[];
  /** 如实上报「这里有内容但我看不见」，避免模型在主框架里反复试探。 */
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
}

export interface FillFormPayload {
  fields: { fieldId: string; value?: string; checked?: boolean }[];
  /** 可选：填完后点击这个按钮，与填写共用同一次确认。 */
  submit?: { fieldId: string };
}

export interface FillFormFieldOutcome {
  fieldId: string;
  status: 'ok' | 'mismatch' | 'not_found' | 'not_writable' | 'invalid_value' | 'blocked_sensitive';
  detail?: string;
  /** 写后回读的实际值；敏感字段永不回传。 */
  actualValue?: string;
}

export interface FillFormResult {
  outcomes: FillFormFieldOutcome[];
  submitted?: { fieldId: string; status: 'ok' | 'not_found' | 'mismatch' | 'not_clickable' };
  /** 句柄表已失效（页面导航或 storage 丢失），模型必须重新调用 browser_get_form。 */
  fieldsTableStale?: boolean;
  /** 本次写入之后页面新出现的可交互元素（下拉建议、展开的菜单项等）。句柄表已同步刷新。 */
  newFields?: FormFieldDescriptor[];
}

export interface ProbeClickTargetPayload {
  /** browser_click 走这条：直接用选择器定位。 */
  selector?: string;
  index?: number;
  /** browser_fill_form 的 submit 走这条：用句柄定位提交按钮。 */
  submitFieldId?: string;
  /** 需要补齐 label 的字段，供确认卡片展示（args 里只有 fieldId）。 */
  fieldIds?: string[];
}

export interface ProbeClickTargetResult {
  isSubmit: boolean;
  formAction?: string;
  fieldCount?: number;
  fieldLabels?: { fieldId: string; label?: string }[];
}

/** 生成唯一消息 ID */
export function newMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 类型安全地发送一条运行时消息并等待响应 */
export async function sendMessage<TReq = unknown, TRes = unknown>(
  type: MessageType,
  payload?: TReq,
  tabId?: number,
): Promise<MessageResponse<TRes>> {
  const message: Message<TReq> = { id: newMessageId(), type, payload, tabId };
  return browser.runtime.sendMessage(message) as Promise<MessageResponse<TRes>>;
}
