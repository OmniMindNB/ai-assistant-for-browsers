// 统一消息协议（ref: technical-plan.md §3.3）
// 用于 Side Panel ↔ Service Worker ↔ Content Script 之间的通信。

export type MessageType =
  | 'PING'
  | 'EXTRACT_PAGE'
  | 'GET_SELECTION'
  | 'ASK_SELECTION'
  | 'AGENT_TAKEOVER'
  | 'GET_ACTIVE_TAB'
  | 'GET_TAB_URL'
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
  | 'PRESS_KEY'
  | 'PROBE_KEY_TARGET'
  | 'SCROLL_PAGE'
  | 'WAIT_FOR'
  | 'NAVIGATE_TAB'
  | 'OPEN_NEW_TAB'
  | 'CLOSE_TAB'
  | 'SET_STORAGE'
  | 'GET_STORAGE'
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

/**
 * AGENT_TAKEOVER：content script 主动上报"执行期遮罩还挂着时，用户自己点了/敲了页面"。
 * 与 ASK_SELECTION 一样不携带 tabId——语义就是"当前这个 tab"，身份取自 sender.tab.id。
 * 没有 payload：需要的信息只有"哪个 tab、什么时候"，后者由 background 记录，
 * 免得把页面里可被伪造的时间戳当权威。
 */
export interface AgentTakeoverPayload {
  /** 触发接管的输入类型，仅用于日志/未来的文案区分；不参与任何判定。 */
  via?: 'click' | 'keydown';
}

export interface AgentTakeoverResult {
  recorded: boolean;
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
  /** 同一选择器在其它帧的命中；不含主框架（主框架命中就是本对象的顶层字段）。 */
  frames?: { origin: string; result: Omit<QueryDomResult, 'frames'> }[];
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
  /** 同一选择器在其它帧的命中；不含主框架（主框架命中就是本对象的顶层字段）。 */
  frames?: { origin: string; result: Omit<GetHtmlResult, 'frames'> }[];
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
  /** 同一选择器在其它帧的命中；不含主框架（主框架命中就是本对象的顶层字段）。 */
  frames?: { origin: string; result: Omit<GetComputedStyleResult, 'frames'> }[];
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
  /** 已缩放重编码后的 data URL。 */
  dataUrl: string;
  /** 不含 data URL 前缀的 base64 载荷，供直接构造 ImageContent。 */
  base64: string;
  mimeType: string;
  width: number;
  height: number;
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
  /** browser_get_form 的 scrollableContainers 里的 fieldId；优先于 selector。 */
  fieldId?: string;
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
  /** 视口（或容器）上方 / 下方尚未查看的像素数，用来告诉模型「还剩多少没看」。 */
  pixelsAbove: number;
  pixelsBelow: number;
  /** 换算「约几屏」用；取不到时为 0，文案会省略屏数提示。 */
  viewportHeight: number;
  /** 实际发生滚动的是内层容器而非整个窗口时才有值。 */
  container?: { tag: string; label?: string };
  /** 仅 fieldId 模式会失败；window/selector 模式不设置此字段（向后兼容，等价于成功）。 */
  status?: 'ok' | 'not_found' | 'mismatch';
  /** 句柄表已失效（页面导航或 storage 丢失），模型必须重新调用 browser_get_form。 */
  fieldsTableStale?: boolean;
}

/**
 * browser_wait_for 的载荷。字段与 lib/agent/wait-dom.ts 的 WaitForInput 同构，
 * 但独立声明——messaging 是被 agent 层依赖的下层，不反向 import agent 模块。
 */
export interface WaitForPayload {
  kind: 'appear' | 'disappear' | 'textContains' | 'domIdle';
  selector?: string;
  text?: string;
  idleMs: number;
  timeoutMs: number;
}

export interface WaitForResult {
  met: boolean;
  elapsedMs: number;
  /** appear/disappear 命中时匹配到的元素数。 */
  matched?: number;
  /** 页面内报告的错误（例如非法选择器）——模型可以修正参数，值得抛出。 */
  error?: string;
  /**
   * 执行环境本身不可用（executeScript 失败：页面已关闭/导航中/被 CSP 拒绝等），
   * 与 error 是两码事——这不是模型能修正的参数错误，和超时同属"没等到"，
   * 不该让整轮任务报错。
   */
  unavailable?: boolean;
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

export interface GetStoragePayload {
  /** 缺省两个存储区都读——多数情况下一次往返就够，省掉"先猜在哪个区"的额外一轮。 */
  area?: 'local' | 'session';
  /** 传了就是取值模式：只返回这一个键的完整值；不传则列出全部键（值按清单上限截断）。 */
  key?: string;
  maxChars?: number;
}

/**
 * 页面里读出来的原始键值。敏感判定与截断都在扩展侧完成（lib/agent/storage-read.ts），
 * 因此这里是未经处理的原文，绝不能直接交给模型。
 */
export interface GetStorageResult {
  areas: {
    area: 'local' | 'session';
    entries: { key: string; value: string }[];
    error?: string;
  }[];
}

/**
 * 执行期遮罩的开关。label 必须由侧边栏本地化好再传下来——内容脚本跑在每个页面里，
 * 不能为几句文案把完整 i18n 字典打进产物（同 entrypoints/content.ts 顶部的说明）。
 */
export interface SetAgentOverlayPayload {
  active: boolean;
  label?: string;
  /**
   * 是否显示模拟光标动画。省略等同 true（今天的行为不变）。子帧写操作要传 false——
   * 顶层 content script 收不到子帧派发的 runi:cursor-move，光标动画只会停在原地/不对位，
   * 精确位置改由帧内自己画的高亮框给出（ref: 设计文档 §6）。
   */
  cursor?: boolean;
}

export interface SetAgentOverlayResult {
  active: boolean;
}

export type FormFieldKind =
  | 'text' | 'textarea' | 'select' | 'checkbox' | 'radio'
  | 'contenteditable' | 'file' | 'submit' | 'button' | 'link' | 'unsupported'
  | 'scrollable';

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
  /** 仅由 computed cursor 命中的通用可交互元素（非语义标签/role/tabindex）。用于观察召回质量与快速回退。 */
  byCursor?: true;
  /** 排在这个字段之前、上一个字段之后出现的正文；已净化截断。仅 GetFormPayload.includeText 时有值。 */
  precedingText?: string;
  /** 该字段所属子帧（iframe）的 origin；主框架字段为 undefined。只存 origin，不存完整 URL——
   *  iframe URL 常带 token/订单号等不该进模型上下文的信息。 */
  frameOrigin?: string;
}

export interface GetFormPayload {
  selector?: string;
  includeHidden?: boolean;
  /** 把正文按 DOM 序穿插进 fields（每个字段的 precedingText）与顶层 trailingText。默认 false。 */
  includeText?: boolean;
  /** 发现页面上的可滚动容器，随 GetFormResult.scrollableContainers 一起发放 fieldId。默认 false。 */
  includeScrollable?: boolean;
}

export interface ScrollableContainerDescriptor {
  /** "s1"/"s2"/... 独立命名空间，不与表单字段的 "f1"/"f2" 冲突。 */
  fieldId: string;
  tag: string;
  /** 尽力而为的标签：aria-label/id 兜底，页面可控，已压空白截断。 */
  label?: string;
  /** 四向剩余距离（像素），而不是原始 scrollTop/scrollHeight/clientHeight——模型不用
   *  自己算还能滚多远（ref: 对标 alibaba/page-agent 的 data-scrollable 属性）。 */
  pixelsAbove: number;
  pixelsBelow: number;
  pixelsLeft: number;
  pixelsRight: number;
}

export interface GetFormResult {
  forms: { formId: string; name?: string; action?: string; method?: string; submitFieldIds: string[] }[];
  fields: FormFieldDescriptor[];
  orphanFieldIds: string[];
  /** 如实上报「这里有内容但我看不见」，避免模型在主框架里反复试探。 */
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
  /** 因帧数上限被丢弃、完全未采集的子帧数量。 */
  droppedFrames?: number;
  /** 已采集的子帧中，因单帧字段上限未列出的字段数量。 */
  droppedChildFields?: number;
  /** 最后一个字段之后出现的正文；已净化截断。仅 includeText 时可能有值。 */
  trailingText?: string;
  /** precedingText/trailingText 中是否发生了截断。includeText 为 false 时恒为 false。 */
  textTruncated: boolean;
  /** 页面上发现的可滚动容器；仅 includeScrollable 时有值（可能是空数组）。 */
  scrollableContainers?: ScrollableContainerDescriptor[];
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
  /** 该表单所在帧的 origin；供确认卡片标注嵌入框架用（ref: 设计文档 §5.3）。 */
  frameOrigin?: string;
}

/**
 * Enter 隐式提交的结构探测载荷。不复用 PROBE_CLICK_TARGET：那个消息名的语义
 * 是"探测一次点击的目标"，让它兼职按键探测会让名字变成假话。
 */
export interface ProbeKeyTargetPayload {
  fieldId?: string;
  selector?: string;
  index?: number;
  /** 不给 fieldId/selector 时探测 document.activeElement。 */
  useActiveElement?: boolean;
  /** 需要补齐 label 的字段，供确认卡片展示。 */
  fieldIds?: string[];
}

export interface PressKeyPayload {
  key: string;
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
  fieldId?: string;
  selector?: string;
  index?: number;
}

export interface PressKeyResult {
  status: 'ok' | 'not_found' | 'no_focus';
  key: string;
  /** 目标元素的简短描述。 */
  target?: string;
  /** 页面是否 preventDefault 了 keydown。 */
  defaultPrevented: boolean;
  /** 是否触发了表单提交。 */
  submitted: boolean;
  detail?: string;
  fieldsTableStale?: boolean;
  newFields?: FormFieldDescriptor[];
}

/**
 * 内部专用（不出现在 SUPPORTED_MESSAGE_TYPES 里，不暴露给模型）：查询给定 tabId 当前的
 * URL，供 agent.ts 探测 browser_click/browser_fill_form/browser_type 之类隐式触发的导航
 * （ref: docs/superpowers/specs/2026-08-31-page-agent-benchmark.md §3.2）。
 */
export interface GetTabUrlResult {
  url: string;
  title?: string;
}

/** 生成唯一消息 ID */
export function newMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type LocalDispatcher = (message: Message) => Promise<unknown>;
let localDispatcher: LocalDispatcher | null = null;

/**
 * 仅由 background.ts 在自己的模块初始化时调用一次，把 handleMessage 注册为进程内直连出口。
 *
 * 背景：agent 主循环迁移进 background 之后（ref: docs/superpowers/specs/
 * 2026-09-01-agent-run-in-background-design.md §7），lib/agent/tools.ts、agent.ts 里的
 * browser_* 工具仍然通过这里的 sendMessage() 发消息，但发送方现在和 handleMessage 的
 * onMessage 监听器同处一个执行上下文——按 WebExtensions 规范，runtime.onMessage 明确
 * "不会派发给发出这条消息的那个 frame 自己"（MDN, runtime.sendMessage），继续走
 * browser.runtime.sendMessage 会导致这些调用永远等不到响应，所有 browser_* 工具在总结/
 * 执行任务时统一失败。注册了本地直连后，sendMessage() 绕开消息总线，在同一个调用栈里
 * 直接调用 handleMessage，行为等价于一次成功往返。传 null 取消注册（测试用）。
 */
export function registerLocalDispatcher(dispatcher: LocalDispatcher | null): void {
  localDispatcher = dispatcher;
}

/** 类型安全地发送一条运行时消息并等待响应 */
export async function sendMessage<TReq = unknown, TRes = unknown>(
  type: MessageType,
  payload?: TReq,
  tabId?: number,
): Promise<MessageResponse<TRes>> {
  const message: Message<TReq> = { id: newMessageId(), type, payload, tabId };
  if (localDispatcher) {
    try {
      const data = await localDispatcher(message);
      return { id: message.id, ok: true, data } as MessageResponse<TRes>;
    } catch (error) {
      return {
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return browser.runtime.sendMessage(message) as Promise<MessageResponse<TRes>>;
}
