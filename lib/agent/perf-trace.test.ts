import { describe, expect, it } from 'vitest';
import { readOpenAiUsage, summarizePerfMarks, type PerfContextSample, type PerfMark } from './perf-trace';

function mark(kind: PerfMark['kind'], at: number, toolName?: string): PerfMark {
  return toolName ? { kind, at, toolName } : { kind, at };
}

describe('summarizePerfMarks', () => {
  it('把一次完整运行的时间拆进 LLM / 权限门 / 工具执行 / 后置钩子四个桶', () => {
    // agent_start(0) -> turn_start(10) -> first_token(310) -> message_end(1010)
    //   -> [权限门 200ms] tool_start(1210) -> tool_end(1410)
    //   -> [afterToolCall 500ms] turn_start(1910) -> first_token(2010) -> message_end(2410)
    //   -> agent_end(2420)
    const summary = summarizePerfMarks(
      [
        mark('agent_start', 0),
        mark('turn_start', 10),
        mark('first_token', 310),
        mark('message_end', 1010),
        mark('tool_start', 1210, 'browser_click'),
        mark('tool_end', 1410, 'browser_click'),
        mark('turn_start', 1910),
        mark('first_token', 2010),
        mark('message_end', 2410),
        mark('agent_end', 2420),
      ],
      [],
    );

    expect(summary.totalMs).toBe(2420);
    expect(summary.turns).toBe(2);
    expect(summary.toolCalls).toBe(1);
    expect(summary.llmMs).toBe(1000 + 500);
    expect(summary.ttftMs).toEqual([300, 100]);
    expect(summary.gateMs).toBe(200);
    expect(summary.toolMs).toBe(200);
    expect(summary.postToolMs).toBe(500);
  });

  it('按工具名聚合调用次数与累计耗时', () => {
    const summary = summarizePerfMarks(
      [
        mark('agent_start', 0),
        mark('turn_start', 0),
        mark('message_end', 100),
        mark('tool_start', 100, 'browser_get_form'),
        mark('tool_end', 900, 'browser_get_form'),
        mark('turn_start', 900),
        mark('message_end', 1000),
        mark('tool_start', 1000, 'browser_get_form'),
        mark('tool_end', 1600, 'browser_get_form'),
        mark('turn_start', 1600),
        mark('message_end', 1700),
        mark('tool_start', 1700, 'browser_click'),
        mark('tool_end', 2000, 'browser_click'),
        mark('agent_end', 2000),
      ],
      [],
    );

    expect(summary.tools).toEqual([
      { name: 'browser_get_form', count: 2, totalMs: 1400 },
      { name: 'browser_click', count: 1, totalMs: 300 },
    ]);
  });

  it('最后一轮不带工具调用时，message_end 之后的收尾时间不计入权限门', () => {
    const summary = summarizePerfMarks(
      [mark('agent_start', 0), mark('turn_start', 0), mark('message_end', 500), mark('agent_end', 900)],
      [],
    );

    expect(summary.llmMs).toBe(500);
    expect(summary.gateMs).toBe(0);
  });

  it('原样带出上下文采样，用于判断只读结果是不是被反复摘要掉又重读', () => {
    const context: PerfContextSample[] = [
      { turn: 1, messages: 4, chars: 1200, summarizedReadResults: 0, keptReadResultChars: 0 },
      { turn: 2, messages: 6, chars: 9000, summarizedReadResults: 1, keptReadResultChars: 7800 },
    ];
    const summary = summarizePerfMarks([mark('agent_start', 0), mark('agent_end', 1)], context);

    expect(summary.context).toEqual(context);
  });

  it('缺少 agent_end（运行被中止）时用最后一个标记算总时长', () => {
    const summary = summarizePerfMarks(
      [mark('agent_start', 0), mark('turn_start', 10), mark('message_end', 700)],
      [],
    );

    expect(summary.totalMs).toBe(700);
    expect(summary.llmMs).toBe(690);
  });
});

describe('readOpenAiUsage', () => {
  it('读出 DeepSeek 的缓存命中/未命中 token 数', () => {
    expect(
      readOpenAiUsage({
        usage: {
          prompt_tokens: 4210,
          completion_tokens: 88,
          total_tokens: 4298,
          prompt_cache_hit_tokens: 3968,
          prompt_cache_miss_tokens: 242,
        },
      }),
    ).toEqual({ promptTokens: 4210, completionTokens: 88, cacheHitTokens: 3968, cacheMissTokens: 242 });
  });

  it('供应商没回报缓存字段时按 0 命中处理，未命中数退化为整个 prompt', () => {
    expect(readOpenAiUsage({ usage: { prompt_tokens: 900, completion_tokens: 12 } })).toEqual({
      promptTokens: 900,
      completionTokens: 12,
      cacheHitTokens: 0,
      cacheMissTokens: 900,
    });
  });

  it('没有 usage 字段的普通增量块返回 undefined', () => {
    expect(readOpenAiUsage({ choices: [{ delta: { content: 'hi' } }] })).toBeUndefined();
    expect(readOpenAiUsage({})).toBeUndefined();
  });
});
