// 注入页面执行的文字定位采集函数。
//
// ⚠️ 与 form-dom.ts / wait-dom.ts 同一约束：这个函数会被 browser.scripting.executeScript
// 序列化后送进页面执行，函数体内不得引用任何模块作用域的绑定（本文件的其它函数、常量、
// import 的值——包括 find-text.ts 里的 normalizeFindText/matchesFindText），否则在页面里
// 一律是 undefined。所有配置通过 input 参数传入，归一化/匹配/路径构建逻辑在下面各自
// 内联一份，是有意的重复，不是疏漏。类型导入（import type）会被编译期擦除，不受此限制。
//
// 不遍历 shadow DOM：见本文件对应实现计划任务的说明——Element.contains() 不可靠地跨越
// shadow 边界，用它做"最深匹配"判定在混入 shadow 内容时会出错，v1 范围收窄到 light DOM。
import type { FormFieldPathStep } from './form-schema';

export interface FindTextInput {
  text: string;
  mode: 'contains' | 'exact';
}

export interface RawTextMatch {
  path: FormFieldPathStep[];
  tag: string;
  type?: string;
  name?: string;
  href?: string;
  /** 归一化后的匹配文本，未截断（截断在 background.ts 侧用 sanitizeFieldText 统一做）。 */
  text: string;
  visible: boolean;
  clickable: boolean;
  /** 父元素的归一化文本，未截断。没有父元素时缺省。 */
  context?: string;
}

export interface FindTextOutput {
  origin: string;
  url: string;
  matches: RawTextMatch[];
  /** 命中数超过本帧安全上限时为 true；background.ts 按 limit 做的截断是另一层，见该常量注释。 */
  truncated: boolean;
}

/**
 * 单帧最多收集这么多条命中，避免一个巨型页面把整段 executeScript 响应撑爆——请求的
 * limit（上限 20）由 background.ts 在合并多帧结果之后再做一次更贴近调用方意图的截断，
 * 这里只是安全阀。
 */
const FIND_TEXT_FRAME_SAFETY_CAP = 50;
/** 单条匹配文本的安全阀：极端情况下唯一命中落在较靠上层的容器（查询词由分散在多个
 *  子节点里的文本拼成，没有更小的元素单独包含它），它的 textContent 可能有数万字符。
 *  背景同 form-dom.ts 的 RAW_TEXT_SAFETY_CAP。 */
const RAW_TEXT_SAFETY_CAP = 2000;
/** "最深匹配"过滤是候选数的平方级开销；候选本身通常远小于全部命中元素数，但一个
 *  近乎无处不在的词需要硬上限兜底，避免卡住页面。 */
const MAX_CANDIDATES_BEFORE_DEEPEST_FILTER = 500;

export const findTextInPage = (mainInput: FindTextInput, childInput: FindTextInput): FindTextOutput => {
  const input = window.top === window ? mainInput : childInput;
  const queryNormalized = (input?.text ?? '').replace(/\s+/g, ' ').trim();
  const mode = input?.mode === 'exact' ? 'exact' : 'contains';

  const normalize = (raw: string): string => raw.replace(/\s+/g, ' ').trim();
  const matches = (candidateNormalized: string): boolean => {
    if (!candidateNormalized || !queryNormalized) return false;
    const candidate = candidateNormalized.toLowerCase();
    const query = queryNormalized.toLowerCase();
    return mode === 'exact' ? candidate === query : candidate.includes(query);
  };

  const isVisible = (element: Element): boolean => {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  // 只是一个尽力而为的提示，不追求和 form-dom.ts 的可点击判定完全同一套规则——
  // find_text 找的是内容，不是控件，clickable 只帮模型判断"这个命中顺手可以点一下吗"。
  const isClickable = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return Boolean(element.getAttribute('href'));
    if (tag === 'button') return true;
    if (tag === 'input') {
      const type = (element.getAttribute('type') || '').toLowerCase();
      return type === 'submit' || type === 'button' || type === 'checkbox' || type === 'radio' || type === 'image';
    }
    const role = (element.getAttribute('role') || '').toLowerCase();
    if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio') return true;
    const view = element.ownerDocument.defaultView;
    return view ? view.getComputedStyle(element).cursor === 'pointer' : false;
  };

  // 与 form-dom.ts collectFormFields 里的 buildPath 同一算法，独立内联一份（理由同上）。
  // 不产出 shadow 步进——本函数不遍历 shadow DOM，见文件顶部注释。
  const buildPath = (element: Element): FormFieldPathStep[] => {
    const steps: FormFieldPathStep[] = [];
    let current: Element | null = element;
    const body = element.ownerDocument.body;
    while (current && current !== body) {
      const parent: Element | null = current.parentElement;
      const scope: ParentNode | null = parent ?? current.ownerDocument;
      const tag = current.tagName.toLowerCase();
      const siblings = scope ? Array.from(scope.querySelectorAll(`:scope > ${tag}`)) : [];
      const index = Math.max(0, siblings.indexOf(current));
      steps.unshift({ kind: 'selector', selector: tag, index });
      current = parent;
    }
    return steps;
  };

  const root: ParentNode = document.body ?? document.documentElement;
  const allCandidates: Element[] = [];
  if (queryNormalized) {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (matches(normalize(element.textContent || ''))) allCandidates.push(element);
    }
  }

  const overflowed = allCandidates.length > MAX_CANDIDATES_BEFORE_DEEPEST_FILTER;
  const candidates = overflowed ? allCandidates.slice(0, MAX_CANDIDATES_BEFORE_DEEPEST_FILTER) : allCandidates;

  // 只取最深的匹配：一个候选只有在它自己不包含另一个候选时才留下——否则 <body> 之类的
  // 祖先容器会把几乎所有命中都吞成自己的一条（ref: 设计文档 §4.2）。
  const deepest = candidates.filter(
    (element) => !candidates.some((other) => other !== element && element.contains(other)),
  );

  const truncated = overflowed || deepest.length > FIND_TEXT_FRAME_SAFETY_CAP;
  const kept = deepest.slice(0, FIND_TEXT_FRAME_SAFETY_CAP);

  const clip = (raw: string): string => (raw.length > RAW_TEXT_SAFETY_CAP ? raw.slice(0, RAW_TEXT_SAFETY_CAP) : raw);

  const rawMatches: RawTextMatch[] = kept.map((element) => {
    const tag = element.tagName.toLowerCase();
    const parent = element.parentElement;
    return {
      path: buildPath(element),
      tag,
      type: element.getAttribute('type') || undefined,
      name: element.getAttribute('name') || undefined,
      href: tag === 'a' ? element.getAttribute('href') || undefined : undefined,
      text: clip(normalize(element.textContent || '')),
      visible: isVisible(element),
      clickable: isClickable(element),
      context: parent ? clip(normalize(parent.textContent || '')) : undefined,
    };
  });

  return { origin: location.origin, url: location.href, matches: rawMatches, truncated };
};
