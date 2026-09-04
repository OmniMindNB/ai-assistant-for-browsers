import { describe, expect, it } from 'vitest';
import type { CollectFormOutput } from './form-dom';
import type { RawFormField } from './form-schema';
import {
  MAX_COLLECTED_FRAMES,
  MAX_FIELDS_PER_CHILD_FRAME,
  mergeFrameCollections,
  mergeReadResultsByFrame,
  type FrameCollection,
} from './frame-merge';

function raw(name: string, tag = 'input'): RawFormField {
  return {
    path: [{ kind: 'selector', selector: tag, index: 0 }],
    tag,
    type: 'text',
    name,
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
  } as RawFormField;
}

function output(names: string[], url: string): CollectFormOutput {
  return {
    url,
    // Task 2 给 CollectFormOutput 加了必填的 origin 字段；测试用的 url 都形如
    // `${origin}/page`，直接用 URL 解析拿回 origin，不用额外传参。
    origin: new URL(url).origin,
    raws: names.map((name) => raw(name)),
    forms: [],
    unreachable: { iframes: 0, closedShadowRoots: 0 },
    truncated: false,
  };
}

function frame(frameId: number, origin: string, names: string[], isMain = false): FrameCollection {
  return { frameId, origin, isMain, output: output(names, `${origin}/page`) };
}

describe('mergeFrameCollections', () => {
  // 会让这个用例失败的 production 改动：改成按 frameId 排序而不是主框架优先，
  // 或者忘了把 frameId/frameOrigin 挂到每条 raw 上。
  it('puts the main frame first and tags every raw with its frame', () => {
    const merged = mergeFrameCollections([
      frame(7, 'https://pay.example.com', ['card']),
      frame(0, 'https://shop.example.com', ['email', 'name'], true),
    ]);

    expect(merged.raws.map((item) => item.name)).toEqual(['email', 'name', 'card']);
    expect(merged.raws.map((item) => item.frameId)).toEqual([0, 0, 7]);
    expect(merged.raws[2].frameOrigin).toBe('https://pay.example.com');
    expect(merged.url).toBe('https://shop.example.com/page');
  });

  // 会让这个用例失败的 production 改动：把 slice 上限去掉，或者丢弃时不计数——
  // 那样模型会以为自己看到了页面上全部字段。
  it('drops frames past MAX_COLLECTED_FRAMES and fields past MAX_FIELDS_PER_CHILD_FRAME', () => {
    const children = Array.from({ length: MAX_COLLECTED_FRAMES + 2 }, (_, index) =>
      frame(index + 1, `https://ad${index}.example.com`, ['x']),
    );
    const fat = frame(99, 'https://big.example.com', Array.from({ length: MAX_FIELDS_PER_CHILD_FRAME + 5 }, (_, i) => `f${i}`));

    const merged = mergeFrameCollections([
      frame(0, 'https://shop.example.com', ['email'], true),
      fat,
      ...children,
    ]);

    expect(merged.droppedFrames).toBe(3);
    expect(merged.droppedChildFields).toBe(5);
    expect(merged.raws.filter((item) => item.frameId === 99)).toHaveLength(MAX_FIELDS_PER_CHILD_FRAME);
  });

  // 会让这个用例失败的 production 改动：主框架缺席时（注入被 CSP 拒绝）抛异常而不是降级。
  it('survives a missing main frame instead of throwing', () => {
    const merged = mergeFrameCollections([frame(4, 'https://widget.example.com', ['q'])]);
    expect(merged.raws).toHaveLength(1);
    expect(merged.url).toBe('https://widget.example.com/page');
  });
});

// browser_query_dom / browser_get_html / browser_get_computed_style 三个裸选择器只读工具的
// 广播合并层（ref: 2026-09-05 final review Important #3 与 Minor #2）。
describe('mergeReadResultsByFrame', () => {
  interface CountOutput {
    origin: string;
    count: number;
  }

  const hasHits = (out: CountOutput) => out.count > 0;

  function readFrame(frameId: number, origin: string, count: number, isMain = false) {
    return { frameId, origin, isMain, output: { origin, count } };
  }

  // 会让这个用例失败的 production 改动：把 origin 也留在顶层结果里。主框架命中的形状必须
  // 和单帧时代保持一致，多出一个字段就是白白改变了模型看惯的输出。
  it('keeps the main frame at the top level without its origin', () => {
    const merged = mergeReadResultsByFrame([readFrame(0, 'https://shop.example.com', 2, true)], hasHits);

    expect(merged.count).toBe(2);
    expect((merged as Record<string, unknown>).origin).toBeUndefined();
    expect(merged.frames).toBeUndefined();
    expect(merged.mainFrameUnavailable).toBeUndefined();
  });

  // 会让这个用例失败的 production 改动：不再按 hasHits 过滤零命中的帧。广告位密集的页面有
  // 几十个 iframe，每个都吐一段 {count: 0} 进 frames[]，纯粹占满上下文窗口没有任何信息量。
  it('drops zero-hit child frames but never the main frame', () => {
    const merged = mergeReadResultsByFrame(
      [
        readFrame(0, 'https://shop.example.com', 0, true),
        readFrame(1, 'https://ads.example.com', 0),
        readFrame(2, 'https://pay.example.com', 3),
      ],
      hasHits,
    );

    // 主框架零命中照样留在顶层：{count: 0} 就是模型要的答案形状，不是噪音。
    expect(merged.count).toBe(0);
    expect(merged.frames).toEqual([{ origin: 'https://pay.example.com', result: { count: 3 } }]);
    expect(merged.droppedFrames).toBeUndefined();
  });

  // 会让这个用例失败的 production 改动：去掉帧数上限，或静默截断而不回报 droppedFrames。
  // browser_get_html 每一帧都能吐满 maxChars，没有上限就是一次调用几十万字符。
  it('caps the kept frames at MAX_COLLECTED_FRAMES and reports how many were dropped', () => {
    const children = Array.from({ length: MAX_COLLECTED_FRAMES + 4 }, (_, i) =>
      readFrame(i + 1, `https://f${i}.example.com`, 1),
    );

    const merged = mergeReadResultsByFrame(
      [readFrame(0, 'https://shop.example.com', 1, true), ...children],
      hasHits,
    );

    expect(merged.frames).toHaveLength(MAX_COLLECTED_FRAMES);
    expect(merged.droppedFrames).toBe(4);
  });

  // 会让这个用例失败的 production 改动：主框架缺席时回退成 frames[0]（改动前正是如此）。
  // 那等于把某个第三方 iframe 的内容当成页面本身的内容呈现给模型，还顺手抹掉了它的
  // origin——模型无从知道自己读到的其实是别人的页面。
  it('never hoists a child frame to the top level when the main frame is missing', () => {
    const merged = mergeReadResultsByFrame(
      [readFrame(3, 'https://widget.example.com', 5), readFrame(4, 'https://ads.example.com', 2)],
      hasHits,
    );

    expect(merged.count).toBeUndefined();
    expect(merged.mainFrameUnavailable).toBe(true);
    expect(merged.frames?.map((f) => f.origin)).toEqual([
      'https://widget.example.com',
      'https://ads.example.com',
    ]);
  });

  // 会让这个用例失败的 production 改动：把 hasHits 写死成某一个工具的形状。
  // browser_get_computed_style 判定的是 found，browser_get_html 还额外要求 html 非空。
  it('honours a per-tool hasHits predicate', () => {
    const merged = mergeReadResultsByFrame(
      [
        { frameId: 0, origin: 'https://shop.example.com', isMain: true, output: { origin: 'https://shop.example.com', found: true } },
        { frameId: 1, origin: 'https://ads.example.com', isMain: false, output: { origin: 'https://ads.example.com', found: false } },
        { frameId: 2, origin: 'https://pay.example.com', isMain: false, output: { origin: 'https://pay.example.com', found: true } },
      ],
      (out) => out.found,
    );

    expect(merged.frames?.map((f) => f.origin)).toEqual(['https://pay.example.com']);
  });
});
