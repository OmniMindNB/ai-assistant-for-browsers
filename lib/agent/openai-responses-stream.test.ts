// lib/agent/openai-responses-stream.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent, AssistantMessageEventStream, Api, Context, Model } from '@earendil-works/pi-ai';
import {
  browserOpenAIResponsesStream,
  convertResponsesInput,
  convertResponsesUserContent,
  mapResponsesStopReason,
  openAiResponsesUrl,
} from './openai-responses-stream';

function makeModel(): Model<Api> {
  return {
    id: 'gpt-6-astra',
    name: 'gpt-6-astra',
    api: 'openai-responses',
    provider: 'test-provider',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 16000,
  };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Responses 的 SSE：每个事件一行 `event:` 一行 `data:`，没有 [DONE]。 */
function sseResponse(events: Array<{ type: string } & Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function contextWithTools(toolNames: string[]): Context {
  return {
    systemPrompt: 'SYS',
    messages: [{ role: 'user', content: 'hi' }],
    tools: toolNames.map((name) => ({ name, description: 'd', parameters: { type: 'object' } })),
  } as unknown as Context;
}

async function run(context: Context): Promise<AssistantMessageEvent[]> {
  const stream = browserOpenAIResponsesStream(makeModel(), context, { apiKey: 'k' }) as AssistantMessageEventStream;
  return collectEvents(stream);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openAiResponsesUrl', () => {
  it('appends /responses to a versioned base URL', () => {
    expect(openAiResponsesUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/responses');
    expect(openAiResponsesUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/responses');
  });

  it('does not double the path when the full endpoint was pasted', () => {
    expect(openAiResponsesUrl('https://api.openai.com/v1/responses')).toBe('https://api.openai.com/v1/responses');
  });
});

describe('mapResponsesStopReason', () => {
  it('reports truncation by max_output_tokens as length, tool calls as toolUse', () => {
    expect(mapResponsesStopReason('max_output_tokens', false)).toBe('length');
    expect(mapResponsesStopReason(undefined, true)).toBe('toolUse');
    expect(mapResponsesStopReason(undefined, false)).toBe('stop');
    expect(mapResponsesStopReason('content_filter', false)).toBe('stop');
  });
});

describe('request body', () => {
  it('sends instructions, flat non-strict function tools, store:false and no temperature', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([{ type: 'response.completed', response: { status: 'completed' } }]),
    );
    await run(contextWithTools(['browser_click']));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k' });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      model: 'gpt-6-astra',
      instructions: 'SYS',
      input: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', name: 'browser_click', description: 'd', parameters: { type: 'object' }, strict: false }],
      tool_choice: 'auto',
      store: false,
      stream: true,
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('messages');
  });
});

describe('browserOpenAIResponsesStream', () => {
  it('streams output text and finishes with stop', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'response.created', response: { status: 'in_progress' } },
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' },
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'lo' },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 } } },
      ]),
    );
    const events = await run(contextWithTools([]));
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') return;
    expect(done.reason).toBe('stop');
    expect(done.message.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('assembles parallel function calls keyed by output_index, using call_id as the tool call id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'browser_click', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"fieldId":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"f1"}' },
        { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'browser_read_page', arguments: '' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_2', output_index: 2, arguments: '{}' },
        { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'browser_read_page', arguments: '{}' } },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
    );
    const events = await run(contextWithTools(['browser_click', 'browser_read_page']));
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.reason).toBe('toolUse');
    expect(done.message.content).toEqual([
      { type: 'toolCall', id: 'call_a', name: 'browser_click', arguments: { fieldId: 'f1' } },
      { type: 'toolCall', id: 'call_b', name: 'browser_read_page', arguments: {} },
    ]);
    expect(events.some((event) => event.type === 'toolcall_delta')).toBe(true);
  });

  it('reports response.incomplete with max_output_tokens as length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' },
        { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
      ]),
    );
    const done = (await run(contextWithTools([]))).at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.reason).toBe('length');
  });

  it('routes reasoning text to thinking events, never into content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'think' },
        { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'answer' },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
    );
    const events = await run(contextWithTools([]));
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['thinking_start', 'thinking_delta', 'thinking_end', 'text_start']),
    );
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.message.content).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('turns response.failed and error events into an error, not a silent stop', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'boom' } } }]),
    );
    const failed = (await run(contextWithTools([]))).at(-1);
    expect(failed?.type).toBe('error');
    if (failed?.type === 'error') expect(failed.error.errorMessage).toContain('boom');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([{ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }]),
    );
    const errored = (await run(contextWithTools([]))).at(-1);
    expect(errored?.type).toBe('error');
    if (errored?.type === 'error') expect(errored.error.errorMessage).toContain('slow down');
  });
});

describe('convertResponsesInput', () => {
  it('maps assistant tool calls and tool results to function_call / function_call_output items without item ids', () => {
    const context = {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'clicking' },
            { type: 'toolCall', id: 'call_a', name: 'browser_click', arguments: { fieldId: 'f1' } },
          ],
        },
        { role: 'toolResult', toolCallId: 'call_a', toolName: 'browser_click', content: [{ type: 'text', text: 'ok' }] },
      ],
    } as unknown as Context;
    expect(convertResponsesInput(context)).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'clicking' },
      { type: 'function_call', call_id: 'call_a', name: 'browser_click', arguments: '{"fieldId":"f1"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
    ]);
  });

  it('keeps a screenshot inside its own function_call_output, next to the untrusted-content text', () => {
    const context = {
      messages: [
        {
          role: 'toolResult',
          toolCallId: 'call_s',
          toolName: 'browser_screenshot',
          content: [
            { type: 'text', text: 'untrusted page content' },
            { type: 'image', mimeType: 'image/png', data: 'AAA' },
          ],
        },
      ],
    } as unknown as Context;
    expect(convertResponsesInput(context)).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_s',
        output: [
          { type: 'input_text', text: 'untrusted page content' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
        ],
      },
    ]);
  });
});

describe('convertResponsesUserContent', () => {
  it('keeps text-only content as a plain string and splits images into input parts', () => {
    expect(convertResponsesUserContent([{ type: 'text', text: 'hi' }])).toBe('hi');
    expect(
      convertResponsesUserContent([
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/jpeg', data: 'BBB' },
      ]),
    ).toEqual([
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' },
    ]);
  });
});
