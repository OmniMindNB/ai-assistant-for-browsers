import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  type AgentOptions,
  type AgentTool,
  type PrepareNextTurnContext,
  type ShouldStopAfterTurnContext,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';

const model: Model<any> = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions',
  provider: 'test-provider',
  baseUrl: 'https://example.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCallMessage(id: string, name: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: {} }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
}

function completedStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: { ...message, content: [] } });
  stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
  return stream;
}

describe('Pi Agent lifecycle hook forwarding', () => {
  it('forwards context-aware next-turn preparation and graceful stop through the public Agent', async () => {
    const requestTools: string[][] = [];
    const streamFn: StreamFn = vi.fn((_model: Model<any>, context: Context) => {
      requestTools.push(context.tools?.map((tool) => tool.name) ?? []);
      if (requestTools.length > 2) throw new Error('stop hook did not terminate after the final response');
      const toolName = requestTools.length === 1 ? 'first_tool' : 'missing_tool';
      return completedStream(toolCallMessage(`call-${requestTools.length}`, toolName));
    });
    const firstTool: AgentTool = {
      name: 'first_tool',
      label: 'First tool',
      description: 'Executes once to make the loop request another response.',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
    };
    const prepareNextTurnWithContext = vi.fn((context: PrepareNextTurnContext) => ({
      context: { ...context.context, tools: [] },
    }));
    const shouldStopAfterTurn = vi
      .fn((_context: ShouldStopAfterTurnContext) => false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const optionsWithHooks: AgentOptions = {
      initialState: { model, tools: [firstTool] },
      streamFn,
      toolExecution: 'sequential',
      prepareNextTurnWithContext,
      shouldStopAfterTurn,
    };
    const agent = new Agent(optionsWithHooks);

    await agent.prompt('start');

    expect(requestTools).toEqual([['first_tool'], []]);
    expect(prepareNextTurnWithContext).toHaveBeenCalledTimes(2);
    expect(shouldStopAfterTurn).toHaveBeenCalledTimes(2);
  });
});
