// 注入页面执行的 DOM 采集/写入函数。
//
// ⚠️ 这些函数会被 browser.scripting.executeScript 序列化后送进页面执行：
// 函数体内不得引用任何模块作用域的绑定（本文件的其它函数、常量、import 的值），
// 否则在页面里一律是 undefined。所有配置通过 input 参数传入。
// 类型导入（import type）会被编译期擦除，不受此限制。
import type { FormFieldPathStep, RawFormField, RawScrollableContainer } from './form-schema';
import type { KeyDescriptor } from './key-dispatch';

export interface CollectFormInput {
  selector?: string;
  includeHidden?: boolean;
  includeText?: boolean;
  includeScrollable?: boolean;
  maxFields: number;
  maxOptions: number;
  /**
   * 'child' 时只采可写字段与提交按钮（ref: 设计文档 §4.1）。缺省 'main' 保持既有行为。
   * 判断权由 background 下发而不是让本函数用 window.top === window 自己决定：
   * 规则留在参数层，form-schema 的纯函数才能覆盖它。
   */
  scope?: 'main' | 'child';
}

export interface CollectedFormInfo {
  formIndex: number;
  name?: string;
  action?: string;
  method?: string;
}

export interface CollectFormOutput {
  url: string;
  /** 本帧的 location.origin，写入前比对 frameId 是否被复用（ref: 设计文档 §3.3）。 */
  origin: string;
  raws: RawFormField[];
  forms: CollectedFormInfo[];
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
  /** 未净化的正文，排在最后一个字段之后。仅 includeText 时可能有值。 */
  trailingText?: string;
  /** 页面上发现的可滚动容器；仅 includeScrollable 时有值（可能是空数组）。 */
  scrollables?: RawScrollableContainer[];
}

export function collectFormFields(input: CollectFormInput): CollectFormOutput {
  const maxFields = input.maxFields;
  const maxOptions = input.maxOptions;
  // 通用可交互元素（链接/role/tabindex）最多只能占用一半预算，避免导航栏密集的页面
  // 在遍历到真正的 <form> 之前就把配额耗尽——这是纯加性功能，不能让既有的表单采集行为退化。
  const genericFieldQuota = Math.max(1, Math.floor(maxFields / 2));
  let genericCollected = 0;
  const includeHidden = input.includeHidden === true;
  const includeText = input.includeText === true;
  const includeScrollable = input.includeScrollable === true;
  const isChildScope = input.scope === 'child';
  const MAX_SCROLLABLE_CONTAINERS = 20;
  const scrollables: RawScrollableContainer[] = [];

  const isScrollableContainer = (element: Element): boolean => {
    if (element === document.documentElement || element === document.body) return false;
    if (element.scrollHeight <= element.clientHeight) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const overflowY = style?.overflowY;
    return overflowY === 'auto' || overflowY === 'scroll';
  };

  const raws: RawFormField[] = [];
  const fieldElements: Element[] = [];
  const forms: CollectedFormInfo[] = [];
  const unreachable = { iframes: 0, closedShadowRoots: 0 };
  let truncated = false;

  const formElements = Array.from(document.forms);
  formElements.forEach((form, formIndex) => {
    forms.push({
      formIndex,
      name: form.getAttribute('name') || undefined,
      action: form.getAttribute('action') ? form.action : undefined,
      method: (form.getAttribute('method') || '').toLowerCase() || undefined,
    });
  });

  const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch']);

  const hasInteractiveRole = (element: Element): boolean =>
    INTERACTIVE_ROLES.has((element.getAttribute('role') || '').toLowerCase());

  const hasExplicitTabindex = (element: Element): boolean => {
    const attr = element.getAttribute('tabindex');
    if (attr === null) return false;
    const value = Number.parseInt(attr, 10);
    return Number.isFinite(value) && value >= 0;
  };

  // cursor 是「为人类用户」必须设对的属性，比 role/tabindex（只有专门做无障碍时才会写对）
  // 可靠得多，是自研下拉/卡片/图标按钮唯一稳定的可交互信号
  //（ref: 设计文档 §4.1；对标 alibaba/page-agent dom_tree/index.js:695）。
  //
  // 护栏两条：html/body 永不因 cursor 入选；近乎全屏的元素（整屏遮罩、全屏包裹容器）不是
  // 可点击目标，放它进来会在祖先抑制下把整页吞掉（ref: 设计文档 §4.3）。

  // 记录被「近乎全屏」护栏拒绝的元素。cursor 是继承属性——仅拒绝这个元素本身不够，
  // 它的后代会独立继承同一个 pointer 样式、自己的 rect 又不大，照样能通过判定，
  // 让"整屏遮罩不能吞掉整页"这条护栏形同虚设。querySelectorAll('*') 是文档序，
  // 祖先必然先于后代被处理，这个前提让"先记录、后查询"成立。
  const nearFullscreenRejected = new Set<Element>();

  // 判断一个元素是否「近乎全屏」，供 hasPointerCursor 的护栏和下面 walk() 里的
  // collectedElements 登记共用——一个近乎全屏的元素，不管是靠 cursor 还是靠语义检查
  // （role/tabindex/真实标签）被收录，都不该把整页 cursor 命中的后代吞掉。
  const isNearFullscreenRect = (element: Element, view: Window): boolean => {
    const rect = element.getBoundingClientRect();
    return rect.width >= view.innerWidth * 0.9 && rect.height >= view.innerHeight * 0.9;
  };

  const hasPointerCursor = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return false;
    if (nearFullscreenRejected.size > 0) {
      let ancestor: Node | null = element.parentNode;
      while (ancestor) {
        if (ancestor instanceof ShadowRoot) {
          ancestor = ancestor.host;
          continue;
        }
        if (ancestor instanceof Element) {
          if (nearFullscreenRejected.has(ancestor)) return false;
          ancestor = ancestor.parentNode;
          continue;
        }
        break;
      }
    }
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    if (view.getComputedStyle(element).cursor !== 'pointer') return false;
    if (isNearFullscreenRect(element, view)) {
      nearFullscreenRejected.add(element);
      return false;
    }
    return true;
  };

  // React（及同类框架）常把委托事件监听器挂在挂载点上，这会让挂载点看起来"可交互"
  // （常见于聚焦陷阱用的显式 tabindex，偶尔也有 role），但它自己从来不是真实点击目标——
  // 只有它的后代才是。permissions.ts 已经拒绝了 "#root"/"#app" 作为
  // browser_click/browser_modify_dom 的 selector 兜底目标，但那一拦发生在元素已经
  // 进了 raws、占了 token、模型已经决定点它之后。在采集阶段直接排除，拦得更早
  // （ref: 设计文档 §3.4）。只匹配整段 id，不匹配包含关系，避免误伤 id="root-panel"
  // 这类真实业务元素。
  const isRootMountContainer = (element: Element): boolean => {
    const id = (element.getAttribute('id') || '').toLowerCase();
    return id === 'root' || id === 'app';
  };

  // 返回 false = 不可交互；'semantic' = 靠标签/contentEditable/href/role/tabindex 命中；
  // 'cursor' = 廉价检查全部落空、仅靠 computed cursor 命中。
  //
  // 顺序重要：walk() 会遍历 document.body 下的每个元素，而 hasPointerCursor 里的
  // getComputedStyle 是强制样式解算。廉价检查必须排在前面短路，让纯文本 span、布局 div
  // 这类绝大多数元素不触发它（ref: 设计文档 §4.1）。
  const classifyInteractive = (element: Element): false | 'semantic' | 'cursor' => {
    if (isRootMountContainer(element)) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return 'semantic';
    if ((element as HTMLElement).isContentEditable === true) return 'semantic';
    if (tag === 'a' && element.getAttribute('href')) return 'semantic';
    if (hasInteractiveRole(element) || hasExplicitTabindex(element)) return 'semantic';
    if (hasPointerCursor(element)) return 'cursor';
    return false;
  };

  const isStandardFieldTag = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      tag === 'button' ||
      (element as HTMLElement).isContentEditable === true
    );
  };

  const textOf = (element: Element | null | undefined): string | undefined => {
    if (!element) return undefined;
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    return text || undefined;
  };

  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  // 为元素生成一条从 root 出发、可重放的路径。同一层用 tagName + 序号定位，
  // 进入 open shadowRoot 时压入一个 shadow 步进。
  const buildPath = (element: Element): FormFieldPathStep[] => {
    const steps: FormFieldPathStep[] = [];
    let current: Element | null = element;
    while (current) {
      const parent: ParentNode | null = current.parentNode;
      const isShadowBoundary = parent instanceof ShadowRoot;
      const scope: ParentNode | null = isShadowBoundary ? parent : (current.parentElement ?? current.ownerDocument);
      const tag = current.tagName.toLowerCase();
      const siblings = scope ? Array.from(scope.querySelectorAll(`:scope > ${tag}`)) : [];
      const index = Math.max(0, siblings.indexOf(current));
      steps.unshift({ kind: 'selector', selector: tag, index });
      if (isShadowBoundary) {
        steps.unshift({ kind: 'shadow' });
        current = (parent as ShadowRoot).host;
      } else {
        current = current.parentElement;
      }
    }
    return steps;
  };

  const describe = (element: Element, byCursor: boolean): RawFormField => {
    const tag = element.tagName.toLowerCase();
    const asInput = element as HTMLInputElement;
    const asSelect = element as HTMLSelectElement;
    const doc = element.ownerDocument;
    const id = element.getAttribute('id') || undefined;

    let forLabelText: string | undefined;
    if (id) {
      const escaped = id.replace(/["\\]/g, '\\$&');
      forLabelText = textOf((element.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${escaped}"]`));
    }

    const labelledBy = element.getAttribute('aria-labelledby');
    const labelledByText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((token) => textOf(doc.getElementById(token)))
          .filter(Boolean)
          .join(' ') || undefined
      : undefined;

    const options =
      tag === 'select'
        ? Array.from(asSelect.options)
            .slice(0, maxOptions)
            .map((option) => ({
              value: option.value,
              label: (option.textContent || '').replace(/\s+/g, ' ').trim(),
              selected: option.selected,
            }))
        : undefined;

    const buttonRole =
      tag === 'button'
        ? ((element.getAttribute('type') || 'submit').toLowerCase() === 'submit' ? 'submit' : 'button')
        : undefined;

    const href = tag === 'a' ? (element.getAttribute('href') || undefined) : undefined;
    const isStandardFieldTag =
      tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || href !== undefined;
    const interactive =
      !isStandardFieldTag &&
      (element as HTMLElement).isContentEditable !== true &&
      (byCursor || hasInteractiveRole(element) || hasExplicitTabindex(element))
        ? true
        : undefined;
    const elementText = tag === 'button' || tag === 'a' || interactive ? textOf(element) : undefined;

    return {
      path: buildPath(element),
      tag,
      type: element.getAttribute('type') || undefined,
      name: element.getAttribute('name') || undefined,
      id,
      autocomplete: element.getAttribute('autocomplete') || undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      ariaLabel: element.getAttribute('aria-label') || undefined,
      labelledByText,
      forLabelText,
      ancestorLabelText: textOf(element.closest('label')),
      required: asInput.required === true,
      disabled: asInput.disabled === true,
      readOnly: asInput.readOnly === true,
      visible: isVisible(element),
      value: typeof asInput.value === 'string' ? asInput.value : undefined,
      checked: typeof asInput.checked === 'boolean' ? asInput.checked : undefined,
      options,
      validationMessage: typeof asInput.validationMessage === 'string' ? asInput.validationMessage : undefined,
      formIndex: asInput.form ? formElements.indexOf(asInput.form) : undefined,
      contentEditable: (element as HTMLElement).isContentEditable === true,
      buttonRole,
      href,
      elementText,
      interactive,
      byCursor: byCursor ? (true as const) : undefined,
    };
  };

  // cursor 是继承属性：<div style="cursor:pointer"><span>下单</span></div> 里 span 的计算值
  // 同样是 pointer。朴素实现会把卡片和它每一个后代都收进来，瞬间打爆 genericFieldQuota，
  // 还给模型一堆指向同一次交互的重复句柄。
  //
  // 规则（对标 alibaba/page-agent dom_tree/index.js:1420 的 handleHighlighting）：
  // 最外层命中的祖先胜出，仅靠 cursor 命中的后代一律抑制；靠廉价检查命中的后代
  // （真 <button>、真 role）不受抑制——它们是独立的交互目标（ref: 设计文档 §4.2）。
  //
  // querySelectorAll('*') 返回文档序，祖先必然先于后代被处理，这个前提是规则成立的基础。
  // 沿 parentElement 上溯在 shadow root 边界处终止（parentElement 为 null）——其后果见下方
  // 已知限制。
  //
  // 已知限制：祖先抑制发生在同一次 walk() 迭代内；若命中的祖先本身还有一个 open shadow root，
  // 其内部的 cursor 命中后代不会被抑制——host 的 collectedElements 登记发生在其 shadow 内容
  // 被遍历之后。三个验收用例均为纯 light DOM，未覆盖这一层，属于已知限制。
  const collectedElements = new Set<Element>();
  const hasCollectedAncestor = (element: Element): boolean => {
    let parent = element.parentElement;
    while (parent) {
      if (collectedElements.has(parent)) return true;
      parent = parent.parentElement;
    }
    return false;
  };

  const walk = (root: ParentNode): void => {
    const elements = Array.from(root.querySelectorAll('*'));
    for (const element of elements) {
      if (element.tagName.toLowerCase() === 'iframe') unreachable.iframes += 1;

      const interactiveKind = classifyInteractive(element);

      const shadowRoot = (element as HTMLElement).shadowRoot;
      if (shadowRoot) {
        walk(shadowRoot);
      } else if (element.tagName.includes('-')) {
        // 自定义元素但读不到 shadowRoot：要么是 closed，要么本来就没有内部结构。
        // 无法在不改变页面的前提下区分两者（探测性 attachShadow 会真的挂上一个空 root
        // 并隐藏元素的子节点，属于破坏性操作，绝对不能用），因此按「可能不可达」计数——
        // 宁可让模型知道「这里也许有我看不见的东西」，也不要让它以为已经看全了。
        unreachable.closedShadowRoots += 1;
      }

      if (!isChildScope && includeScrollable && scrollables.length < MAX_SCROLLABLE_CONTAINERS && isScrollableContainer(element)) {
        const rawLabel = element.getAttribute('aria-label') || element.id || '';
        scrollables.push({
          path: buildPath(element),
          tag: element.tagName.toLowerCase(),
          label: rawLabel ? rawLabel.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined : undefined,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollLeft: element.scrollLeft,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        });
      }

      if (!interactiveKind) continue;
      // 子帧只要能写的字段和提交按钮：广告/埋点 iframe 几乎没有可写表单字段，
      // 因此在窄采集下自然贡献 0 条，而登录/支付/客服框要的字段一条不少。
      if (isChildScope && !isStandardFieldTag(element)) continue;
      if (interactiveKind === 'cursor' && hasCollectedAncestor(element)) continue;

      const isGeneric = !isStandardFieldTag(element);
      if (isGeneric && genericCollected >= genericFieldQuota) {
        truncated = true;
        continue;
      }
      if (raws.length >= maxFields) {
        truncated = true;
        return;
      }
      const raw = describe(element, interactiveKind === 'cursor');
      const hidden = (raw.type || '').toLowerCase() === 'hidden' || !raw.visible;
      if (hidden && !includeHidden) continue;
      raws.push(raw);
      fieldElements.push(element);
      // 全屏/近全屏元素若被正常收录（例如一个真的占满全屏的 role="button"），不能把它计入
      // collectedElements 去抑制后代——那等于把「cursor 路径专用」的全屏护栏意外扩散到语义
      // 检测路径，会让一个全屏遮罩层的 role/tabindex 命中吞掉整页所有 cursor 命中的子元素。
      const collectionView = element.ownerDocument.defaultView;
      if (!(collectionView && isNearFullscreenRect(element, collectionView))) {
        collectedElements.add(element);
      }
      if (isGeneric) genericCollected += 1;
    }
  };

  // body/html 通常不会出现在被遍历的 element 里（walk() 的默认 scope 是 document.body，
  // querySelectorAll('*') 不含 scope 自身），所以不能指望 hasPointerCursor 顺路发现它们。
  // 但若站点把 cursor: pointer 设在这两层，后代会整页继承同一个值，等同于让整页护栏
  // 失效——显式检查一次，直接计入 nearFullscreenRejected。
  for (const rootLike of [document.documentElement, document.body]) {
    if (!rootLike) continue;
    const view = rootLike.ownerDocument.defaultView;
    if (view && view.getComputedStyle(rootLike).cursor === 'pointer') {
      nearFullscreenRejected.add(rootLike);
    }
  }

  const scope = input.selector ? document.querySelector(input.selector) : document.body;
  if (scope) walk(scope);

  let trailingText: string | undefined;
  if (includeText && scope) {
    const RAW_TEXT_SAFETY_CAP = 2000;
    const SKIP_TEXT_ANCESTOR_TAGS = new Set(['script', 'style', 'noscript', 'template', 'option']);
    const buffers: string[][] = raws.map(() => []);
    const trailingBuffer: string[] = [];

    const isInsideSkippedTag = (parent: Element | null): boolean => {
      let el = parent;
      while (el) {
        if (SKIP_TEXT_ANCESTOR_TAGS.has(el.tagName.toLowerCase())) return true;
        el = el.parentElement;
      }
      return false;
    };

    const isInsideAnyField = (parent: Element | null): boolean => {
      if (!parent) return false;
      return fieldElements.some((el) => el.contains(parent));
    };

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node.textContent ?? '').trim()) return NodeFilter.FILTER_REJECT;
        const parent = (node as Text).parentElement;
        if (isInsideSkippedTag(parent)) return NodeFilter.FILTER_REJECT;
        if (isInsideAnyField(parent)) return NodeFilter.FILTER_REJECT;
        if (!includeHidden && parent && !isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // 找「排在这段文本之后的第一个字段」：跨 shadow 边界比较不连通，compareDocumentPosition 仍会
    // 任意但一致地带上 PRECEDING/FOLLOWING 位，必须先排除 DISCONNECTED 候选再看 FOLLOWING，
    // 否则 light DOM 的文本会被错误地归到 shadow root 内的字段上（ref: 设计文档 §3.3）。
    let textNode: Node | null = walker.nextNode();
    while (textNode) {
      const text = (textNode.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) {
        const slot = fieldElements.findIndex((el) => {
          const position = textNode!.compareDocumentPosition(el);
          if (position & Node.DOCUMENT_POSITION_DISCONNECTED) return false;
          return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        });
        (slot === -1 ? trailingBuffer : buffers[slot]).push(text);
      }
      textNode = walker.nextNode();
    }

    // precedingText 保留尾部（离当前字段最近的一段），trailingText 保留头部（离上一个字段最近
    // 的一段）——这里不加省略号，省略号只在下游 sanitizeFieldText（产品级 300 字符层）加
    // （ref: 2026-08-26 review Fix 1）。
    const finalize = (parts: string[], keepEnd: 'head' | 'tail'): string | undefined => {
      if (parts.length === 0) return undefined;
      const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (!joined) return undefined;
      if (joined.length <= RAW_TEXT_SAFETY_CAP) return joined;
      return keepEnd === 'tail' ? joined.slice(-RAW_TEXT_SAFETY_CAP) : joined.slice(0, RAW_TEXT_SAFETY_CAP);
    };

    raws.forEach((rawField, index) => {
      rawField.precedingText = finalize(buffers[index], 'tail');
    });
    trailingText = finalize(trailingBuffer, 'head');
  }

  return {
    url: location.href,
    origin: location.origin,
    raws,
    forms,
    unreachable,
    truncated,
    trailingText,
    scrollables: includeScrollable ? scrollables : undefined,
  };
}

export interface ApplyFillItem {
  fieldId: string;
  path: FormFieldPathStep[];
  expect: { tag: string; type?: string; name?: string; label?: string; href?: string };
  kind: string;
  value?: string;
  checked?: boolean;
}

export interface ApplyFillOutcome {
  fieldId: string;
  status: 'ok' | 'mismatch' | 'not_found' | 'not_writable' | 'invalid_value';
  detail?: string;
  actualValue?: string;
}

export interface ApplyFillInput {
  /** 发放句柄时的页面 URL；与当前不符即认为句柄表过期。 */
  url: string;
  items: ApplyFillItem[];
  submit?: { fieldId: string; path: FormFieldPathStep[]; expect: ApplyFillItem['expect'] };
}

export interface ApplyFillOutput {
  outcomes: ApplyFillOutcome[];
  submitted?: {
    fieldId: string;
    status: 'ok' | 'not_found' | 'mismatch' | 'not_clickable';
    /** 被点元素的可见文案；页面可控，已压空白并截断。 */
    label?: string;
    /** 命中 <a target="_blank">：当前标签页不会变化，必须点破。 */
    opensNewTab?: boolean;
  };
  fieldsTableStale?: boolean;
}

// ⚠️ 同 collectFormFields：本函数会被序列化注入页面，不得引用模块作用域的任何绑定。
export async function applyFormFill(input: ApplyFillInput): Promise<ApplyFillOutput> {
  if (input.url && input.url !== location.href) {
    return { outcomes: [], fieldsTableStale: true };
  }

  const resolve = (path: FormFieldPathStep[]): Element | null => {
    let scope: ParentNode | null = document;
    let element: Element | null = null;
    for (const step of path) {
      if (step.kind === 'shadow') {
        const shadowRoot: ShadowRoot | null = (element as HTMLElement | null)?.shadowRoot ?? null;
        if (!shadowRoot) return null;
        scope = shadowRoot;
        continue;
      }
      if (!scope) return null;
      const matches: Element[] = Array.from(scope.querySelectorAll(`:scope > ${step.selector}`));
      element = matches[step.index] ?? null;
      if (!element) return null;
      scope = element;
    }
    return element;
  };

  const matchesExpect = (element: Element, expected: ApplyFillItem['expect']): boolean => {
    if (element.tagName.toLowerCase() !== expected.tag.toLowerCase()) return false;
    const actualType = element.getAttribute('type') || undefined;
    if ((expected.type || undefined) !== actualType) return false;
    const actualName = element.getAttribute('name') || undefined;
    if ((expected.name || undefined) !== actualName) return false;
    if (expected.href !== undefined) {
      const actualHref = element.getAttribute('href') || undefined;
      if (actualHref !== expected.href) return false;
    }
    return true;
  };

  const fireInput = (element: HTMLElement, data: string): void => {
    element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
  };

  // 逐字段扫光：一次 fill_form 可能改十几个字段，若值瞬间全部出现，用户根本看不出
  // 「到底动了哪几个」——而这正是银行/政务代填最需要看清的一件事。高亮框停留 600ms
  // 再淡出，所以后面的字段亮起时前面的还在，最终能看到完整的一组。
  // 停顿总开销固定在 ~800ms 以内（字段越多每格越短），不随字段数线性膨胀；单字段时取
  // 250ms，与 CURSOR_MOVE_MS 对齐，行为和 browser_type / browser_click 一致。
  const dwellMs = Math.max(40, Math.min(250, Math.round(800 / (input.items.length || 1))));

  /** 返回是否真的画了东西——没有可见布局盒就没什么可看，也就不值得为它停顿。 */
  const spotlight = (element: Element): boolean => {
    const host = element as HTMLElement;
    // 视口外的字段先滚进来，否则高亮框（position:fixed + rect）画在屏幕外，等于没画。
    // typeof 守卫是给未实现 scrollIntoView 的 jsdom 留的。
    const before = host.getBoundingClientRect();
    if ((before.bottom < 0 || before.top > window.innerHeight) && typeof host.scrollIntoView === 'function') {
      host.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;

    // ⚠️ 与 clickElementInPage / 下方 submit 分支的高亮样式重复：都是被 executeScript
    // 序列化注入的独立函数，引用不到共享 helper，只能各自内联。
    const highlight = document.createElement('div');
    highlight.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
      'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
      'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
    document.body.appendChild(highlight);
    setTimeout(() => {
      highlight.style.opacity = '0';
      setTimeout(() => highlight.remove(), 300);
    }, 600);

    window.dispatchEvent(
      new CustomEvent('runi:cursor-move', {
        detail: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      }),
    );
    return true;
  };

  const outcomes: ApplyFillOutcome[] = [];

  for (const item of input.items) {
    try {
      const element = resolve(item.path);
      if (!element) {
        outcomes.push({ fieldId: item.fieldId, status: 'not_found', detail: '定位路径已解析不到元素。' });
        continue;
      }
      if (!matchesExpect(element, item.expect)) {
        outcomes.push({
          fieldId: item.fieldId,
          status: 'mismatch',
          detail: '该位置的元素与读取时不一致，页面可能已变化，请重新调用 browser_get_form。',
        });
        continue;
      }

      const asInput = element as HTMLInputElement;
      if (asInput.disabled === true || asInput.readOnly === true) {
        outcomes.push({ fieldId: item.fieldId, status: 'not_writable', detail: '字段处于禁用或只读状态。' });
        continue;
      }

      // 只对真正要写的字段扫光：上面 not_found / mismatch / 只读的分支都已经 continue 掉了。
      if (spotlight(element)) await new Promise((done) => setTimeout(done, dwellMs));

      const wantsChecked = typeof item.checked === 'boolean';
      const wantsValue = typeof item.value === 'string';

      if (item.kind === 'checkbox' || item.kind === 'radio') {
        if (!wantsChecked) {
          outcomes.push({ fieldId: item.fieldId, status: 'invalid_value', detail: '勾选类字段需要 checked 参数，而不是 value。' });
          continue;
        }
        if (asInput.checked !== item.checked) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          if (setter) setter.call(asInput, item.checked);
          else asInput.checked = item.checked as boolean;
          asInput.dispatchEvent(new Event('input', { bubbles: true }));
          asInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const actual = asInput.checked;
        outcomes.push(
          actual === item.checked
            ? { fieldId: item.fieldId, status: 'ok', actualValue: String(actual) }
            : { fieldId: item.fieldId, status: 'invalid_value', detail: '写入后回读不符。', actualValue: String(actual) },
        );
        continue;
      }

      if (!wantsValue) {
        outcomes.push({ fieldId: item.fieldId, status: 'invalid_value', detail: '该字段需要 value 参数。' });
        continue;
      }
      const value = item.value as string;

      if (item.kind === 'select') {
        const select = element as HTMLSelectElement;
        const options = Array.from(select.options);
        const target =
          options.find((option) => option.value === value) ??
          options.find((option) => (option.textContent || '').replace(/\s+/g, ' ').trim() === value);
        if (!target) {
          outcomes.push({
            fieldId: item.fieldId,
            status: 'invalid_value',
            detail: `没有 value 或文案等于 "${value}" 的选项，原值未改动。`,
            actualValue: select.value,
          });
          continue;
        }
        // 用原生 setter 绕开 React 的 value tracker，与 text/textarea 分支保持一致，
        // 否则直接赋值只会更新 tracker 记录的值，React 侧看不到变化、change 事件被吞。
        const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (selectSetter) selectSetter.call(select, target.value);
        else select.value = target.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        outcomes.push(
          select.value === target.value
            ? { fieldId: item.fieldId, status: 'ok', actualValue: select.value }
            : { fieldId: item.fieldId, status: 'invalid_value', detail: '写入后回读不符。', actualValue: select.value },
        );
        continue;
      }

      if (item.kind === 'contenteditable') {
        const host = element as HTMLElement;
        host.focus();
        host.textContent = value;
        fireInput(host, value);

        // Slate.js / Quill 一类编辑器把 DOM 当受控视图，直接写 textContent 会被无视或覆盖。
        // 回读不符时降级到 execCommand：它走浏览器原生的编辑管线，这些编辑器都能收到。
        // 已弃用但仍被各主流浏览器支持；typeof 守卫是给未实现它的 jsdom 留的。
        if ((host.textContent ?? '') !== value && typeof document.execCommand === 'function') {
          host.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(host);
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand('delete', false);
          document.execCommand('insertText', false, value);
        }

        host.dispatchEvent(new Event('change', { bubbles: true }));
        host.blur();
        const actual = host.textContent ?? '';
        outcomes.push(
          actual === value
            ? { fieldId: item.fieldId, status: 'ok', actualValue: actual }
            : { fieldId: item.fieldId, status: 'invalid_value', detail: '富文本写入后回读不符。', actualValue: actual },
        );
        continue;
      }

      // text / textarea：用原生 setter 绕开 React 的 value tracker，
      // 并补齐 focus/blur，让依赖 touched / blur 校验的表单库能正常工作。
      const prototype = element.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      asInput.focus();
      if (setter) setter.call(asInput, value);
      else asInput.value = value;
      fireInput(asInput, value);
      asInput.dispatchEvent(new Event('change', { bubbles: true }));
      asInput.blur();
      const actual = asInput.value;
      outcomes.push(
        actual === value
          ? { fieldId: item.fieldId, status: 'ok', actualValue: actual }
          : { fieldId: item.fieldId, status: 'invalid_value', detail: '写入后回读不符，页面组件可能改写或拒绝了这个值。', actualValue: actual },
      );
    } catch (err) {
      // 不做事务与回滚：单个字段写入抛异常（例如对 input[type=file] 的 value 原生 setter
      // 会按 HTML 规范抛 InvalidStateError）不能吞掉此前已记录的成功结果，也不能中断
      // 其余字段的写入尝试——逐字段如实回报。
      outcomes.push({ fieldId: item.fieldId, status: 'invalid_value', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  let submitted: ApplyFillOutput['submitted'];
  if (input.submit) {
    const element = resolve(input.submit.path);
    if (!element) {
      submitted = { fieldId: input.submit.fieldId, status: 'not_found' };
    } else if (!matchesExpect(element, input.submit.expect)) {
      submitted = { fieldId: input.submit.fieldId, status: 'mismatch' };
    } else {
      const button = element as HTMLElement;
      // 与 clickElementInPage 同理：先滚进视口再测量（守卫是给未实现该方法的 jsdom 留的）。
      if (typeof button.scrollIntoView === 'function') button.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = button.getBoundingClientRect();
      const disabled = (button as HTMLButtonElement).disabled === true;
      const hasBox = rect.width > 0 || rect.height > 0;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const topMost = document.elementFromPoint(centerX, centerY);
      const covered = topMost != null && topMost !== button && !button.contains(topMost);
      if (disabled || !hasBox || covered) {
        submitted = { fieldId: input.submit.fieldId, status: 'not_clickable' };
      } else {
        // 命中测试同 clickElementInPage：topMost 是 button 自身或其后代时才切换派发目标，
        // 否则（含 topMost 为 null）退回 button。covered 已经在上面拦掉了"命中了不相关
        // 元素"的情况。⚠️ 与 clickElementInPage 重复：两处都是被 executeScript 序列化注入
        // 页面的独立函数，不能引用模块作用域的共享 helper，只能各自内联。
        const dispatchTarget = topMost && button.contains(topMost) ? (topMost as HTMLElement) : button;

        const highlight = document.createElement('div');
        highlight.style.cssText =
          `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
          'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
          'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
        document.body.appendChild(highlight);
        setTimeout(() => {
          highlight.style.opacity = '0';
          setTimeout(() => highlight.remove(), 300);
        }, 250);

        // 先让模拟光标滑到落点，停稳后再派发点击。
        // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致。本函数被
        // executeScript 序列化注入页面，引用不到那个常量，只能内联——改一处必须同步另一处。
        // 等得比动画短，就会在光标还没停稳时派发点击，正是这个功能要消除的那种错位。
        window.dispatchEvent(new CustomEvent('runi:cursor-move', { detail: { x: centerX, y: centerY } }));
        await new Promise((resolve) => setTimeout(resolve, 250));

        // 同 clickElementInPage：给上一次点击的元素补一套「鼠标离开」事件，防止它弹出的
        // hover 菜单粘住不消失。⚠️ 与 clickElementInPage 重复，不能共用 helper。
        const runiWindow = window as Window & { __runiLastClickTarget__?: Element };
        const lastClicked = runiWindow.__runiLastClickTarget__;
        if (lastClicked && lastClicked.isConnected && lastClicked !== dispatchTarget) {
          const leaveOpts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
          lastClicked.dispatchEvent(new PointerEvent('pointerout', leaveOpts));
          lastClicked.dispatchEvent(new PointerEvent('pointerleave', { ...leaveOpts, bubbles: false }));
          lastClicked.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true }));
          lastClicked.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }));
          (lastClicked as HTMLElement).blur?.();
        }

        // 涟漪与 click 同刻派发。⚠️ 与 clickElementInPage 重复，不能共用 helper。
        window.dispatchEvent(new CustomEvent('runi:cursor-click'));

        const pointerOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        const mouseOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, button: 0 };
        dispatchTarget.dispatchEvent(new PointerEvent('pointerover', pointerOpts));
        dispatchTarget.dispatchEvent(new PointerEvent('pointerenter', { ...pointerOpts, bubbles: false }));
        dispatchTarget.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
        dispatchTarget.dispatchEvent(new MouseEvent('mouseenter', { ...mouseOpts, bubbles: false }));
        dispatchTarget.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
        dispatchTarget.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
        (dispatchTarget as HTMLElement).focus?.();
        dispatchTarget.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
        dispatchTarget.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
        dispatchTarget.dispatchEvent(new MouseEvent('click', mouseOpts));
        runiWindow.__runiLastClickTarget__ = dispatchTarget;

        // ⚠️ 与 clickElementInPage 重复：两处都是被序列化注入的独立函数，不能共用 helper。
        // aria-label 优先：图标按钮的可见文本往往为空或只是一个字形。
        const rawLabel = button.getAttribute('aria-label') || button.textContent || '';
        const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 60);
        submitted = {
          fieldId: input.submit.fieldId,
          status: 'ok',
          label: label || undefined,
          opensNewTab: button.tagName.toLowerCase() === 'a' && button.getAttribute('target') === '_blank',
        };
      }
    }
  }

  return { outcomes, submitted };
}

export interface ProbeClickInput {
  selector?: string;
  index?: number;
  path?: FormFieldPathStep[];
}

export interface ProbeClickOutput {
  found: boolean;
  tag: string;
  type?: string;
  hasFormOwner: boolean;
  formAction?: string;
  textContent?: string;
  fieldCount?: number;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定。
export function probeClickTarget(input: ProbeClickInput): ProbeClickOutput {
  let element: Element | null = null;

  if (input.path) {
    let scope: ParentNode | null = document;
    for (const step of input.path) {
      if (step.kind === 'shadow') {
        const shadowRoot: ShadowRoot | null = (element as HTMLElement | null)?.shadowRoot ?? null;
        if (!shadowRoot) { element = null; break; }
        scope = shadowRoot;
        continue;
      }
      if (!scope) { element = null; break; }
      element = Array.from(scope.querySelectorAll(`:scope > ${step.selector}`))[step.index] ?? null;
      if (!element) break;
      scope = element;
    }
  } else if (input.selector) {
    element = Array.from(document.querySelectorAll(input.selector))[input.index ?? 0] ?? null;
  }

  if (!element) return { found: false, tag: '', hasFormOwner: false };

  const owner = (element as HTMLInputElement).form ?? null;
  return {
    found: true,
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute('type') || undefined,
    hasFormOwner: owner != null,
    formAction: owner?.getAttribute('action') ? owner.action : undefined,
    textContent: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    fieldCount: owner ? owner.elements.length : undefined,
  };
}

export interface ProbeKeyInput {
  path?: FormFieldPathStep[];
  selector?: string;
  index?: number;
  /** 不给 path/selector 时，探测 document.activeElement。 */
  useActiveElement?: boolean;
}

export interface ProbeKeyOutput {
  found: boolean;
  tag: string;
  type?: string;
  hasFormOwner: boolean;
  formAction?: string;
  fieldCount?: number;
  hasSubmitButton: boolean;
  textLikeFieldCount: number;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定：元素解析与文本类 type 集合都在函数体内
// 内联一份，与 probeClickTarget / scrollContainerInPage 同一既有约定。
export function probeKeyTarget(input: ProbeKeyInput): ProbeKeyOutput {
  const empty: ProbeKeyOutput = {
    found: false, tag: '', hasFormOwner: false, hasSubmitButton: false, textLikeFieldCount: 0,
  };

  let element: Element | null = null;
  if (input.path) {
    let scope: ParentNode | null = document;
    for (const step of input.path) {
      if (step.kind === 'shadow') {
        const shadowRoot: ShadowRoot | null = (element as HTMLElement | null)?.shadowRoot ?? null;
        if (!shadowRoot) { element = null; break; }
        scope = shadowRoot;
        continue;
      }
      if (!scope) { element = null; break; }
      element = Array.from(scope.querySelectorAll(`:scope > ${step.selector}`))[step.index] ?? null;
      if (!element) break;
      scope = element;
    }
  } else if (input.selector) {
    element = Array.from(document.querySelectorAll(input.selector))[input.index ?? 0] ?? null;
  } else if (input.useActiveElement) {
    const active = document.activeElement;
    element = active && active !== document.body ? active : null;
  }

  if (!element) return empty;

  const textLike = [
    '', 'text', 'search', 'url', 'tel', 'email', 'password',
    'number', 'date', 'month', 'week', 'time', 'datetime-local',
  ];
  const owner = (element as HTMLInputElement).form ?? null;

  let hasSubmitButton = false;
  let textLikeFieldCount = 0;
  if (owner) {
    for (const member of Array.from(owner.elements)) {
      const tag = member.tagName.toLowerCase();
      const type = (member.getAttribute('type') || '').toLowerCase();
      if ((tag === 'button' && (type === '' || type === 'submit')) ||
          (tag === 'input' && (type === 'submit' || type === 'image'))) {
        hasSubmitButton = true;
      }
      if (tag === 'input' && textLike.indexOf(type) >= 0) textLikeFieldCount += 1;
    }
  }

  return {
    found: true,
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute('type') || undefined,
    hasFormOwner: owner != null,
    formAction: owner?.getAttribute('action') ? owner.action : undefined,
    fieldCount: owner ? owner.elements.length : undefined,
    hasSubmitButton,
    textLikeFieldCount,
  };
}

export interface PressKeyInput {
  path?: FormFieldPathStep[];
  selector?: string;
  index?: number;
  useActiveElement?: boolean;
  descriptor: KeyDescriptor;
  /** 由 background 依据探测 + 确认结果决定；页面侧不自行判断要不要提交。 */
  submitOnEnter: boolean;
  /** 发放句柄时的页面 URL；仅 fieldId 路径（有 path 时）传入，与当前不符即认为句柄表过期。 */
  url?: string;
  /** fieldId 路径的结构指纹；仅 path 存在时传入，用于核对目标元素与发放句柄时是否一致。 */
  expect?: { tag: string; type?: string; name?: string };
}

export interface PressKeyOutput {
  status: 'ok' | 'not_found' | 'no_focus';
  /** 目标元素的简短描述，供模型确认自己按在了哪里。 */
  target?: string;
  defaultPrevented: boolean;
  submitted: boolean;
  /** URL 或结构指纹与句柄发放时不符——句柄表已过期。 */
  fieldsTableStale?: boolean;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定（元素解析逻辑内联，同上）。
export function pressKeyInPage(input: PressKeyInput): PressKeyOutput {
  let element: Element | null = null;
  if (input.path) {
    let scope: ParentNode | null = document;
    for (const step of input.path) {
      if (step.kind === 'shadow') {
        const shadowRoot: ShadowRoot | null = (element as HTMLElement | null)?.shadowRoot ?? null;
        if (!shadowRoot) { element = null; break; }
        scope = shadowRoot;
        continue;
      }
      if (!scope) { element = null; break; }
      element = Array.from(scope.querySelectorAll(`:scope > ${step.selector}`))[step.index] ?? null;
      if (!element) break;
      scope = element;
    }
  } else if (input.selector) {
    element = Array.from(document.querySelectorAll(input.selector))[input.index ?? 0] ?? null;
  } else if (input.useActiveElement) {
    const active = document.activeElement;
    element = active && active !== document.body ? active : null;
  }

  if (!element) {
    return {
      status: input.useActiveElement && !input.selector && !input.path ? 'no_focus' : 'not_found',
      defaultPrevented: false,
      submitted: false,
    };
  }

  // fieldId 路径专用的过期/结构漂移校验（url/expect 只在有 path 时由 background 传入，
  // selector/activeElement 路径这两个字段天然是 undefined，下面两处检查自然跳过）。
  // 与 applyFormFill 的 url 早退 + matchesExpect 校验语义一致，但按本文件「序列化注入
  // 函数之间不共享 helper」的约定内联实现，不导入/调用 applyFormFill 内部的 matchesExpect。
  if (input.url && input.url !== location.href) {
    return { status: 'not_found', defaultPrevented: false, submitted: false, fieldsTableStale: true };
  }
  if (input.expect) {
    const actualTag = element.tagName.toLowerCase();
    const actualType = element.getAttribute('type') || undefined;
    const actualName = element.getAttribute('name') || undefined;
    const mismatch =
      actualTag !== input.expect.tag.toLowerCase() ||
      (input.expect.type || undefined) !== actualType ||
      (input.expect.name || undefined) !== actualName;
    if (mismatch) {
      return { status: 'not_found', defaultPrevented: false, submitted: false, fieldsTableStale: true };
    }
  }

  const d = input.descriptor;
  const init: KeyboardEventInit & { keyCode: number; which: number } = {
    key: d.key,
    code: d.code,
    keyCode: d.keyCode,
    which: d.keyCode,
    ctrlKey: d.ctrlKey,
    shiftKey: d.shiftKey,
    altKey: d.altKey,
    metaKey: d.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  };

  // 派发前先聚焦：很多页面把 keydown 监听挂在元素上，但只有聚焦后才认为该
  // 元素处于"正在输入"状态。已经是焦点时 focus() 无副作用。
  if (typeof (element as HTMLElement).focus === 'function') (element as HTMLElement).focus();

  const keydown = new KeyboardEvent('keydown', init);
  const notPrevented = element.dispatchEvent(keydown);
  const defaultPrevented = !notPrevented;

  if (d.emitsKeypress) element.dispatchEvent(new KeyboardEvent('keypress', init));
  element.dispatchEvent(new KeyboardEvent('keyup', init));

  let submitted = false;
  // 页面自己 preventDefault 了，说明它要自行处理这次 Enter；再强行提交就是
  // 覆盖页面意图，可能造成双重提交。
  if (input.submitOnEnter && !defaultPrevented) {
    const owner = (element as HTMLInputElement).form ?? null;
    if (owner && typeof owner.requestSubmit === 'function') {
      // HTML 的隐式提交语义等同于「点击了表单的默认按钮」，服务端会收到该按钮的
      // name/value 对；requestSubmit() 不传参就丢了这一对，与真实回车的行为不符
      // （也与确认卡片上用户看到、批准的提交对象不符）。这里按文档序找第一个未禁用的
      // 可提交成员，模拟浏览器自己的「默认按钮」判定。disabled 的必须跳过——
      // HTMLFormElement.requestSubmit(submitter) 对禁用的 submitter 会抛 TypeError。
      let submitter: HTMLButtonElement | HTMLInputElement | undefined;
      for (const member of Array.from(owner.elements)) {
        const tag = member.tagName.toLowerCase();
        const type = (member.getAttribute('type') || '').toLowerCase();
        const isSubmitButton = tag === 'button' && (type === '' || type === 'submit');
        const isSubmitInput = tag === 'input' && (type === 'submit' || type === 'image');
        if ((isSubmitButton || isSubmitInput) && !(member as HTMLButtonElement | HTMLInputElement).disabled) {
          submitter = member as HTMLButtonElement | HTMLInputElement;
          break;
        }
      }
      if (submitter) owner.requestSubmit(submitter);
      else owner.requestSubmit();
      submitted = true;
    }
  }

  const id = (element as HTMLElement).id ? `#${(element as HTMLElement).id}` : '';
  return {
    status: 'ok',
    target: `${element.tagName.toLowerCase()}${id}`,
    defaultPrevented,
    submitted,
  };
}

export interface ScrollContainerInput {
  /** 发放句柄时的页面 URL；与当前不符即认为句柄表过期。 */
  url: string;
  path: FormFieldPathStep[];
  expect: { tag: string };
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
}

export interface ScrollContainerOutput {
  status: 'ok' | 'not_found' | 'mismatch';
  x: number;
  y: number;
  scrolledBy: number;
  pixelsAbove: number;
  pixelsBelow: number;
  viewportHeight: number;
  tag?: string;
  label?: string;
  fieldsTableStale?: boolean;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定（包括本文件的其它函数）——resolve() 与
// applyFormFill/probeClickTarget 里的同名函数各自独立内联，是同一个既有约定。
export function scrollContainerInPage(input: ScrollContainerInput): ScrollContainerOutput {
  const empty = { x: 0, y: 0, scrolledBy: 0, pixelsAbove: 0, pixelsBelow: 0, viewportHeight: 0 };

  if (input.url && input.url !== location.href) {
    return { ...empty, status: 'not_found', fieldsTableStale: true };
  }

  const resolve = (path: FormFieldPathStep[]): Element | null => {
    let scope: ParentNode | null = document;
    let element: Element | null = null;
    for (const step of path) {
      if (step.kind === 'shadow') {
        const shadowRoot: ShadowRoot | null = (element as HTMLElement | null)?.shadowRoot ?? null;
        if (!shadowRoot) return null;
        scope = shadowRoot;
        continue;
      }
      if (!scope) return null;
      const matches: Element[] = Array.from(scope.querySelectorAll(`:scope > ${step.selector}`));
      element = matches[step.index] ?? null;
      if (!element) return null;
      scope = element;
    }
    return element;
  };

  const element = resolve(input.path);
  if (!element) return { ...empty, status: 'not_found' };
  if (element.tagName.toLowerCase() !== input.expect.tag.toLowerCase()) {
    return { ...empty, status: 'mismatch' };
  }

  const container = element as HTMLElement;
  const clientHeight = container.clientHeight;
  const clientWidth = container.clientWidth;
  const maxScroll = Math.max(0, container.scrollHeight - clientHeight);
  const maxScrollX = Math.max(0, container.scrollWidth - clientWidth);
  const clampY = (value: number): number => Math.min(Math.max(value, 0), maxScroll);
  const clampX = (value: number): number => Math.min(Math.max(value, 0), maxScrollX);
  const startTop = container.scrollTop;
  const startLeft = container.scrollLeft;
  const requestedTop = typeof input.y === 'number' ? input.y : startTop;
  const requestedLeft = typeof input.x === 'number' ? input.x : startLeft;

  const scrollableContainer = container as unknown as { scrollTo?: (opts: ScrollToOptions) => void };
  if (typeof scrollableContainer.scrollTo === 'function') {
    scrollableContainer.scrollTo({ top: requestedTop, left: requestedLeft, behavior: input.behavior ?? 'auto' });
  } else {
    container.scrollTop = requestedTop;
    container.scrollLeft = requestedLeft;
  }
  const finalTop = clampY(requestedTop);
  const finalLeft = clampX(requestedLeft);

  const rawLabel = container.getAttribute('aria-label') || container.id || '';
  const label = rawLabel ? rawLabel.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined : undefined;

  return {
    status: 'ok',
    x: Math.round(finalLeft),
    y: Math.round(finalTop),
    scrolledBy: Math.round(finalTop - startTop),
    pixelsAbove: Math.round(finalTop),
    pixelsBelow: Math.round(Math.max(0, maxScroll - finalTop)),
    viewportHeight: clientHeight,
    tag: container.tagName.toLowerCase(),
    label,
  };
}

export interface ScrollPageInPageInput {
  selector?: string;
  x?: number;
  y?: number;
  behavior?: 'auto' | 'smooth';
}

export interface ScrollPageInPageOutput {
  selector?: string;
  x: number;
  y: number;
  /** 垂直方向的实际位移，正数向下。滚不动时为 0。 */
  scrolledBy: number;
  pixelsAbove: number;
  pixelsBelow: number;
  viewportHeight: number;
  /** 实际发生滚动的是内层容器而非整个窗口时才有值。 */
  container?: { tag: string; label?: string };
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定。isScrollableContainer 与 collectFormFields 内部
// 的同名判定各自独立内联——两处逻辑必须保持一致，改一处要同步改另一处。
export function scrollPageInPage(input: ScrollPageInPageInput): ScrollPageInPageOutput {
  const behavior = input?.behavior ?? 'auto';

  const isScrollableContainer = (element: Element): boolean => {
    if (element === document.documentElement || element === document.body) return false;
    if (element.scrollHeight <= element.clientHeight) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const overflowY = style?.overflowY;
    return overflowY === 'auto' || overflowY === 'scroll';
  };

  const findScrollableAncestor = (start: Element | null): Element | null => {
    let node: Element | null = start;
    while (node) {
      if (isScrollableContainer(node)) return node;
      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  };

  // 与 collectFormFields/scrollContainerInPage 的同名 label 逻辑保持一致：aria-label 优先，
  // 退化到 id 兜底——container 是同一个概念性字段，不该因为产出它的代码路径（Task 4 的
  // fieldId 直接滚动 vs Task 5 这里的祖先链探测）而给模型呈现不一致的标签规则。
  const describeContainer = (element: Element): { tag: string; label?: string } => {
    const rawLabel = element.getAttribute('aria-label') || element.id || '';
    return {
      tag: element.tagName.toLowerCase(),
      label: rawLabel ? rawLabel.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined : undefined,
    };
  };

  const windowMetrics = () => {
    const viewportHeight = window.innerHeight || 0;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - viewportHeight);
    return { viewportHeight, maxScroll, clamp: (value: number) => Math.min(Math.max(value, 0), maxScroll) };
  };

  if (input?.selector) {
    const target = document.querySelector(input.selector);
    if (!target) {
      const { viewportHeight, maxScroll } = windowMetrics();
      return {
        selector: input.selector,
        x: window.scrollX,
        y: Math.round(window.scrollY),
        scrolledBy: 0,
        pixelsAbove: Math.round(window.scrollY),
        pixelsBelow: Math.round(Math.max(0, maxScroll - window.scrollY)),
        viewportHeight,
      };
    }

    const ancestor = findScrollableAncestor(target.parentElement);
    if (!ancestor) {
      const { viewportHeight, maxScroll, clamp } = windowMetrics();
      const startY = window.scrollY;
      // ⚠️ rect 必须在 scrollIntoView 之前读：behavior:'auto' 在大多数浏览器里是同步完成的，
      // 滚完再读 rect 会读到"已经居中"之后的新位置，把终点算错（与 entrypoints/background.ts
      // 里被搬迁前的 scrollPage 顺序一致，byte-for-byte 不能改）。
      const rect = target.getBoundingClientRect();
      // typeof 守卫是给未实现 scrollIntoView 的 jsdom 留的，生产环境该方法必然存在。
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior, block: 'center' });
      const finalY = clamp(startY + rect.top + rect.height / 2 - viewportHeight / 2);
      return {
        selector: input.selector,
        x: window.scrollX,
        y: Math.round(finalY),
        scrolledBy: Math.round(finalY - startY),
        pixelsAbove: Math.round(finalY),
        pixelsBelow: Math.round(Math.max(0, maxScroll - finalY)),
        viewportHeight,
      };
    }

    const containerClientHeight = ancestor.clientHeight;
    const containerMaxScroll = Math.max(0, ancestor.scrollHeight - containerClientHeight);
    const startTop = ancestor.scrollTop;
    // 强制 auto：滚完要立即同步读回 ancestor.scrollTop，behavior:'smooth' 会让这一步读到
    // 动画中途的值。窗口分支不受影响，仍然按调用方要求的 behavior 走。
    // typeof 守卫同上：只是给未实现 scrollIntoView 的 jsdom 留的。
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'auto', block: 'center' });
    const finalTop = Math.min(Math.max(ancestor.scrollTop, 0), containerMaxScroll);
    return {
      selector: input.selector,
      x: Math.round(ancestor.scrollLeft),
      y: Math.round(finalTop),
      scrolledBy: Math.round(finalTop - startTop),
      pixelsAbove: Math.round(finalTop),
      pixelsBelow: Math.round(Math.max(0, containerMaxScroll - finalTop)),
      viewportHeight: containerClientHeight,
      container: describeContainer(ancestor),
    };
  }

  const { viewportHeight, maxScroll, clamp } = windowMetrics();
  const startY = window.scrollY;
  const requestedY = input?.y ?? startY;
  window.scrollTo({ left: input?.x ?? window.scrollX, top: requestedY, behavior });
  const finalY = clamp(requestedY);

  return {
    x: window.scrollX,
    y: Math.round(finalY),
    scrolledBy: Math.round(finalY - startY),
    pixelsAbove: Math.round(finalY),
    pixelsBelow: Math.round(Math.max(0, maxScroll - finalY)),
    viewportHeight,
  };
}

export interface LegacyWriteStatus {
  status: 'ok' | 'not_found' | 'not_clickable' | 'not_writable' | 'invalid_value' | 'blocked_sensitive';
  detail?: string;
  actualValue?: string;
  /** 被点元素的可见文案，让模型能确认自己点中的是不是想点的东西。页面可控，已压空白并截断。 */
  label?: string;
  /** 命中 <a target="_blank">：当前标签页不会变化，必须点破。 */
  opensNewTab?: boolean;
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定（包括本文件的其它函数）。
export async function clickElementInPage(input: { selector: string; index: number }): Promise<LegacyWriteStatus> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const target = nodes[input.index ?? 0];
  if (!target) return { status: 'not_found', detail: `没有匹配 "${input.selector}" 的第 ${input.index ?? 0} 个元素。` };

  // 先滚进视口再测量：视口外元素的 rect 是超界坐标，高亮框（position:fixed + rect）会画到
  // 屏幕外，elementFromPoint 也恒为 null 而使遮挡检测形同虚设；懒渲染内容同样需要先滚到才加载。
  // typeof 守卫是给 jsdom 留的——它没有实现 scrollIntoView。
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', inline: 'nearest' });

  const rect = target.getBoundingClientRect();
  const disabled = (target as HTMLButtonElement).disabled === true;
  const hasBox = rect.width > 0 || rect.height > 0;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const topMost = document.elementFromPoint(centerX, centerY);
  const covered = topMost != null && topMost !== target && !target.contains(topMost);
  if (disabled || !hasBox || covered) {
    return {
      status: 'not_clickable',
      detail: disabled ? '元素处于禁用状态。' : !hasBox ? '元素没有可见的布局盒。' : '元素被其它元素遮挡。',
    };
  }

  // 命中测试：真实浏览器里事件落在该坐标下最内层的元素上（例如按钮内的图标 <svg>），
  // 不是恒定落在 resolve 出来的 target 本身。topMost 不是 target 自身或其后代时已经在
  // 上面被判成"遮挡"并提前返回，所以这里 target.contains(topMost) 为真时二者必属同一
  // 语义目标；topMost 为 null（如 jsdom 未实现 elementFromPoint）时退回 target。
  // ⚠️ 与 applyFormFill 的 submit 分支重复：两处都是被 executeScript 序列化注入页面的独立函数，
  // 不能引用模块作用域的共享 helper，只能各自内联。
  const dispatchTarget = topMost && target.contains(topMost) ? (topMost as HTMLElement) : target;

  const highlight = document.createElement('div');
  highlight.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
    'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
    'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
  document.body.appendChild(highlight);
  setTimeout(() => {
    highlight.style.opacity = '0';
    setTimeout(() => highlight.remove(), 300);
  }, 250);

  // 先让模拟光标滑到落点，停稳后再派发点击。
  // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致。本函数被
  // executeScript 序列化注入页面，引用不到那个常量，只能内联——改一处必须同步另一处。
  // 等得比动画短，就会在光标还没停稳时派发点击，正是这个功能要消除的那种错位。
  window.dispatchEvent(new CustomEvent('runi:cursor-move', { detail: { x: centerX, y: centerY } }));
  await new Promise((resolve) => setTimeout(resolve, 250));

  // 上一次被点击的元素在这次点击前补一套「鼠标离开」事件，防止它弹出的 hover 菜单
  // 粘在页面上不消失——page.window 在多次 executeScript 调用之间是同一个真实的
  // 页面全局对象，可以安全地把它当会话状态存（导航会换新的 window，天然重置）。
  // ⚠️ 与 applyFormFill 的 submit 分支重复：两处都是被序列化注入的独立函数，不能共用 helper。
  const runiWindow = window as Window & { __runiLastClickTarget__?: Element };
  const lastClicked = runiWindow.__runiLastClickTarget__;
  if (lastClicked && lastClicked.isConnected && lastClicked !== dispatchTarget) {
    const leaveOpts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    lastClicked.dispatchEvent(new PointerEvent('pointerout', leaveOpts));
    lastClicked.dispatchEvent(new PointerEvent('pointerleave', { ...leaveOpts, bubbles: false }));
    lastClicked.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true }));
    lastClicked.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }));
    // 用真正的 blur() 而不是派发合成事件：它同时会把浏览器的焦点状态清空，避免下面
    // dispatchTarget.focus() 再对它触发一次原生 blur，重复两遍。
    (lastClicked as HTMLElement).blur?.();
  }

  // 涟漪与 click 在同一刻派发：用户看到的「点了一下」和页面真正收到的点击是同一件事。
  // ⚠️ 与 applyFormFill 的 submit 分支重复，两处都是序列化注入的独立函数，不能共用 helper。
  window.dispatchEvent(new CustomEvent('runi:cursor-click'));

  const pointerOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const mouseOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, button: 0 };
  dispatchTarget.dispatchEvent(new PointerEvent('pointerover', pointerOpts));
  dispatchTarget.dispatchEvent(new PointerEvent('pointerenter', { ...pointerOpts, bubbles: false }));
  dispatchTarget.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
  dispatchTarget.dispatchEvent(new MouseEvent('mouseenter', { ...mouseOpts, bubbles: false }));
  dispatchTarget.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
  dispatchTarget.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
  (dispatchTarget as HTMLElement).focus?.();
  dispatchTarget.dispatchEvent(new PointerEvent('pointerup', pointerOpts));
  dispatchTarget.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
  dispatchTarget.dispatchEvent(new MouseEvent('click', mouseOpts));
  runiWindow.__runiLastClickTarget__ = dispatchTarget;

  // aria-label 优先：图标按钮的可见文本往往为空或只是一个字形。
  const rawLabel = target.getAttribute('aria-label') || target.textContent || '';
  const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 60);
  return {
    status: 'ok',
    label: label || undefined,
    opensNewTab: target.tagName.toLowerCase() === 'a' && target.getAttribute('target') === '_blank',
  };
}

// ⚠️ 序列化注入，禁止引用模块作用域绑定（包括本文件的其它函数）。
// async 是为了在写入前等模拟光标滑到落点——同 clickElementInPage，值先于光标出现会让
// 用户对不上「是它在打字」这件事。executeScript 会自动展开返回的 Promise。
export async function typeTextInPage(input: { selector: string; index: number; text: string; replace: boolean }): Promise<LegacyWriteStatus> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const target = nodes[input.index ?? 0];
  if (!target) return { status: 'not_found', detail: `没有匹配 "${input.selector}" 的第 ${input.index ?? 0} 个元素。` };

  const asInput = target as HTMLInputElement;
  const type = (target.getAttribute('type') || '').toLowerCase();
  const autocomplete = (target.getAttribute('autocomplete') || '').toLowerCase();
  const identity = `${target.getAttribute('name') || ''} ${target.getAttribute('id') || ''} ${autocomplete}`;
  const sensitive =
    type === 'password' ||
    autocomplete.indexOf('cc-') === 0 ||
    /(^|[^a-z])(otp|totp|cvv|cvc|csc|ssn|passcode)([^a-z]|$)/i.test(identity);
  if (sensitive) {
    return { status: 'blocked_sensitive', detail: '出于安全考虑，本扩展不代填密码与支付类字段，请提示用户手动输入。' };
  }
  if (asInput.disabled === true || asInput.readOnly === true) {
    return { status: 'not_writable', detail: '字段处于禁用或只读状态。' };
  }

  const tag = target.tagName.toLowerCase();
  const editable = target.isContentEditable === true;
  if (!editable && tag !== 'input' && tag !== 'textarea') {
    return { status: 'not_writable', detail: `"${tag}" 不是可输入的表单控件。` };
  }

  const nextValue = editable
    ? (input.replace === false ? `${target.textContent ?? ''}${input.text}` : input.text)
    : (input.replace === false ? `${asInput.value}${input.text}` : input.text);

  // 高亮 + 光标：和点击走同一套视觉语言，让"它在往这个框里打字"可见。
  // ⚠️ 与 clickElementInPage / applyFormFill 的高亮重复：序列化注入，不能共用 helper。
  // typeof 守卫是给未实现 scrollIntoView 的 jsdom 留的。
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = target.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    const highlight = document.createElement('div');
    highlight.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
      'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
      'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
    document.body.appendChild(highlight);
    setTimeout(() => {
      highlight.style.opacity = '0';
      setTimeout(() => highlight.remove(), 300);
    }, 250);

    // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致（注入函数
    // 被序列化，引用不到那个常量，只能内联——改一处必须同步另一处）。
    window.dispatchEvent(
      new CustomEvent('runi:cursor-move', {
        detail: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      }),
    );
    await new Promise((done) => setTimeout(done, 250));
  }

  target.focus();
  if (editable) {
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: input.text }));
    target.textContent = nextValue;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.text }));
    // 与 applyFormFill 的 contenteditable 分支同一条兜底：Slate.js / Quill 一类编辑器把 DOM
    // 当受控视图，会无视直接写 textContent；回读不符就降级到走原生编辑管线的 execCommand。
    // typeof 守卫是给未实现它的 jsdom 留的。
    if ((target.textContent ?? '') !== nextValue && typeof document.execCommand === 'function') {
      target.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('delete', false);
      document.execCommand('insertText', false, nextValue);
    }
  } else {
    const prototype = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(asInput, nextValue);
    else asInput.value = nextValue;
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: input.text }));
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.text }));
  }
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.blur();

  const actual = editable ? (target.textContent ?? '') : asInput.value;
  return actual === nextValue
    ? { status: 'ok', actualValue: actual }
    : { status: 'invalid_value', detail: '写入后回读不符，页面组件可能改写或拒绝了这个值。', actualValue: actual };
}

export async function selectOptionInPage(input: { selector: string; index: number; value: string }): Promise<LegacyWriteStatus> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const target = nodes[input.index ?? 0];
  if (!target) return { status: 'not_found', detail: `没有匹配 "${input.selector}" 的第 ${input.index ?? 0} 个元素。` };
  if (target.tagName.toLowerCase() !== 'select') {
    return {
      status: 'not_writable',
      detail: `"${target.tagName.toLowerCase()}" 不是原生 <select>。这可能是自定义下拉组件，请改用 browser_click 依次点开并选择。`,
    };
  }

  const select = target as unknown as HTMLSelectElement;
  const options = Array.from(select.options);
  const option =
    options.find((candidate) => candidate.value === input.value) ??
    options.find((candidate) => (candidate.textContent || '').replace(/\s+/g, ' ').trim() === input.value);
  if (!option) {
    return { status: 'invalid_value', detail: `没有 value 或文案等于 "${input.value}" 的选项，原值未改动。`, actualValue: select.value };
  }

  const rect = select.getBoundingClientRect();
  const highlight = document.createElement('div');
  highlight.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
    'box-sizing:border-box;border:2px solid #4f46e5;border-radius:4px;box-shadow:0 0 0 4px rgba(79,70,229,0.35);' +
    'pointer-events:none;z-index:2147483647;transition:opacity 300ms ease;';
  document.body.appendChild(highlight);
  setTimeout(() => {
    highlight.style.opacity = '0';
    setTimeout(() => highlight.remove(), 300);
  }, 250);

  // 先让模拟光标滑到落点，停稳后再写入。
  // ⚠️ 这里的 250 必须与 lib/agent/agent-overlay.ts 的 CURSOR_MOVE_MS 一致（同上，注入函数
  // 被序列化，引用不到那个常量，只能内联）。
  window.dispatchEvent(
    new CustomEvent('runi:cursor-move', {
      detail: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));

  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return select.value === option.value
    ? { status: 'ok', actualValue: select.value }
    : { status: 'invalid_value', detail: '写入后回读不符。', actualValue: select.value };
}
