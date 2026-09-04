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
