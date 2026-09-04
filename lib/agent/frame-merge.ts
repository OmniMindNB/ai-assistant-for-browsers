// 多帧采集结果的合并、编号与截断（ref: docs/superpowers/specs/2026-09-04-iframe-addressing-design.md §4）。
//
// 抽成纯函数的理由与 fill-form-request.ts 一致：这段逻辑埋在 entrypoints/background.ts
// 里就没有任何 vitest project 能覆盖到，而「子帧字段不能挤掉主框架字段」「上限触发时
// 必须如实告诉模型丢了多少」都是需要被钉死的行为。
import type { CollectFormOutput, CollectedFormInfo } from './form-dom';
import type { RawFormField, RawScrollableContainer } from './form-schema';

/** 参与合并的子帧数上限。超出的按注入返回序丢弃。 */
export const MAX_COLLECTED_FRAMES = 16;
/** 单个子帧的字段数上限。 */
export const MAX_FIELDS_PER_CHILD_FRAME = 30;

export interface FrameCollection {
  frameId: number;
  origin: string;
  isMain: boolean;
  output: CollectFormOutput;
}

export type MergedRawField = RawFormField & { frameId: number; frameOrigin: string };

export interface MergedCollection {
  url: string;
  raws: MergedRawField[];
  forms: CollectedFormInfo[];
  unreachable: { iframes: number; closedShadowRoots: number };
  truncated: boolean;
  trailingText?: string;
  scrollables?: RawScrollableContainer[];
  /** 因 MAX_COLLECTED_FRAMES 被丢弃的子帧数。 */
  droppedFrames: number;
  /** 因 MAX_FIELDS_PER_CHILD_FRAME 被丢弃的子帧字段总数。 */
  droppedChildFields: number;
  /** 出现在 raws 里的帧清单，供渲染层做分组标题。 */
  frameOrigins: { frameId: number; origin: string }[];
}

export function mergeFrameCollections(collections: FrameCollection[]): MergedCollection {
  const main = collections.find((item) => item.isMain);
  const children = collections.filter((item) => !item.isMain);
  const keptChildren = children.slice(0, MAX_COLLECTED_FRAMES);

  const raws: MergedRawField[] = [];
  let droppedChildFields = 0;

  const push = (collection: FrameCollection, limit?: number): void => {
    const source = collection.output.raws;
    const kept = limit === undefined ? source : source.slice(0, limit);
    if (limit !== undefined) droppedChildFields += source.length - kept.length;
    for (const item of kept) {
      raws.push({ ...item, frameId: collection.frameId, frameOrigin: collection.origin });
    }
  };

  if (main) push(main);
  for (const child of keptChildren) push(child, MAX_FIELDS_PER_CHILD_FRAME);

  return {
    url: main?.output.url ?? collections[0]?.output.url ?? '',
    raws,
    forms: main?.output.forms ?? [],
    unreachable: {
      iframes: collections.reduce((sum, item) => sum + item.output.unreachable.iframes, 0),
      closedShadowRoots: collections.reduce((sum, item) => sum + item.output.unreachable.closedShadowRoots, 0),
    },
    truncated: collections.some((item) => item.output.truncated),
    trailingText: main?.output.trailingText,
    scrollables: main?.output.scrollables,
    droppedFrames: children.length - keptChildren.length,
    droppedChildFields,
    frameOrigins: collections
      .filter((item) => raws.some((field) => field.frameId === item.frameId))
      .map((item) => ({ frameId: item.frameId, origin: item.origin })),
  };
}

/** mergeReadResultsByFrame 的入参形状：executeInAllFrames 每一帧的注入返回。 */
export interface ReadFrameResult<T> {
  frameId: number;
  origin: string;
  isMain: boolean;
  output: T;
}

/**
 * 只读裸选择器广播的合并层：主框架命中留在顶层（不加标题，与单帧时代的形状一致），
 * 其它帧命中打包进 frames[]，每段带 origin。origin 只用来分段，不进最终结果的顶层——
 * 那会让「主框架不加标题」这条既有观感被一个多余字段破坏。
 *
 * 两条裁剪规则（ref: 2026-09-05 final review Important #3）：
 * 1. 没有命中的帧直接丢掉。广告位密集的页面几十个 iframe 全都吐一段 {count:0} /
 *    {found:false}，纯属占满上下文窗口，没有任何信息量。
 * 2. 其它帧最多保留 MAX_COLLECTED_FRAMES 段——沿用 browser_get_form 的同一上限，
 *    而不是另起一个常数；被丢掉的段数如实写进 droppedFrames，不静默截断。
 *    尤其 browser_get_html 每一帧都能吐满 maxChars，没有上限就是一次调用几十万字符。
 *
 * 主框架缺席（CSP 拒绝注入、帧在调用途中销毁）时不再把随便某个子帧顶到顶层：那等于
 * 把第三方内容当成页面本身的内容呈现，还顺手抹掉了它的 origin。此时顶层留空、所有命中
 * 都进 frames[]（各自带 origin），并置 mainFrameUnavailable 说明顶层为什么是空的
 * （ref: 2026-09-05 final review Minor #2，选项 a）。
 *
 * 与 mergeFrameCollections 同住一个模块，理由也同上：留在 background.ts 里没有任何
 * vitest project 覆盖得到，而上面这三条都是必须被钉死的行为。
 */
export function mergeReadResultsByFrame<T extends { origin: string }>(
  frames: ReadFrameResult<T>[],
  hasHits: (output: T) => boolean,
): Omit<T, 'origin'> & {
  frames?: { origin: string; result: Omit<T, 'origin'> }[];
  droppedFrames?: number;
  mainFrameUnavailable?: true;
} {
  const main = frames.find((f) => f.isMain);
  const stripOrigin = (output: T): Omit<T, 'origin'> => {
    const { origin: _origin, ...rest } = output;
    return rest;
  };
  // 主框架自己没命中也照样留在顶层：{count: 0} 就是模型要的答案形状，不是噪音。
  const hits = frames.filter((f) => f !== main && hasHits(f.output));
  const kept = hits.slice(0, MAX_COLLECTED_FRAMES);
  return {
    ...(main ? stripOrigin(main.output) : ({} as Omit<T, 'origin'>)),
    frames: kept.length > 0 ? kept.map((f) => ({ origin: f.origin, result: stripOrigin(f.output) })) : undefined,
    droppedFrames: hits.length > kept.length ? hits.length - kept.length : undefined,
    mainFrameUnavailable: main ? undefined : true,
  };
}
