import { describe, expect, it } from 'vitest';
import { readAnthropicUsage, readOpenAiUsage, summarizePerfMarks, type PerfContextSample, type PerfMark } from './perf-trace';

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

// Anthropic 的 usage 字段名和口径都跟 OpenAI 那套不同，必须单独换算：
// input_tokens 只是「没命中缓存的剩余部分」，不是整个 prompt。
// 总 prompt = input_tokens + cache_creation_input_tokens + cache_read_input_tokens。
// 直接把 input_tokens 当 promptTokens 会让一次命中良好的请求显示成「prompt 只有 4K」，
// 正好把缓存起作用的证据读反。
describe('readAnthropicUsage', () => {
  it('把三段输入合成总 prompt，命中数取 cache_read', () => {
    expect(
      readAnthropicUsage(
        { input_tokens: 240, cache_creation_input_tokens: 1200, cache_read_input_tokens: 8600 },
        88,
      ),
    ).toEqual({ promptTokens: 10040, completionTokens: 88, cacheHitTokens: 8600, cacheMissTokens: 1440 });
  });

  // 首轮：全部写入缓存，一个 token 都读不到。这是正常的，不是故障——
  // 写入溢价要到第二轮才开始回本。
  it('首轮只有写入、没有读取时命中数为 0', () => {
    expect(
      readAnthropicUsage({ input_tokens: 100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 }, 10),
    ).toEqual({ promptTokens: 5100, completionTokens: 10, cacheHitTokens: 0, cacheMissTokens: 5100 });
  });

  // 第三方 Anthropic 兼容端点可能根本不回报缓存字段，缺省按 0 处理，不能算成 NaN。
  it('缺少缓存字段时按 0 计，prompt 退化为 input_tokens', () => {
    expect(readAnthropicUsage({ input_tokens: 900 }, 12)).toEqual({
      promptTokens: 900,
      completionTokens: 12,
      cacheHitTokens: 0,
      cacheMissTokens: 900,
    });
  });

  it('没有 usage 时返回 undefined', () => {
    expect(readAnthropicUsage(undefined, 0)).toBeUndefined();
    expect(readAnthropicUsage(null, 0)).toBeUndefined();
  });
});
