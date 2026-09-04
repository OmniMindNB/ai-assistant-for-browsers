import { describe, expect, it } from 'vitest';
import type { CollectFormOutput } from './form-dom';
import type { RawFormField } from './form-schema';
import {
  MAX_COLLECTED_FRAMES,
  MAX_FIELDS_PER_CHILD_FRAME,
  mergeFrameCollections,
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
