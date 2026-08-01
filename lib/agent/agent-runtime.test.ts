import { describe, expect, it, vi } from 'vitest';
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type Context,
  type Model,
} from '@earendil-works/pi-ai';
import type { ProviderConfig } from '@/lib/settings';
import { createBrowserAgentOptions } from './agent';

const provider: ProviderConfig = {
  id: 'test-provider',
  name: 'Test',
  baseURL: 'https://example.com/v1',
  apiKey: 'key',
  model: 'test-model',
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCallMessage(model: Model<any>, id: string, name: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: { selector: '.x', limit: 2 } }],
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
  stream.push({ type: 'done', reason: 'toolUse', message });
  return stream;
}

function userText(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    )
    .join('\n');
}

describe('Browser Agent bounded final response runtime', () => {
  it('includes budget and dossier guidance in the sole tool-free final request', async () => {
    const requestTools: string[][] = [];
    const requestGuidance: string[] = [];
    const dossierTool: AgentTool = {
      name: 'browser_inspect_page_implementation',
      label: 'Inspect implementation',
      description: 'Collect implementation evidence.',
      parameters: Type.Object({ selector: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
      execute: async () => ({ content: [{ type: 'text', text: 'evidence' }], details: {} }),
    };
    let agent: Agent;
    const agentOptions = createBrowserAgentOptions({
      provider,
      tabId: 1,
      tools: [dossierTool],
      readToolCallBudget: 1,
      writeToolCallBudget: 2,
      steer: (message) => agent.steer(message),
    });
    const streamFn: StreamFn = vi.fn((model: Model<any>, context: Context) => {
      requestTools.push(context.tools?.map((tool) => tool.name) ?? []);
      requestGuidance.push(userText(context.messages));
      if (requestTools.length > 2) throw new Error('a third request escaped the stop hook');
      const toolName = requestTools.length === 1 ? 'browser_inspect_page_implementation' : 'missing_tool';
      return completedStream(toolCallMessage(model, `call-${requestTools.length}`, toolName));
    });
    agentOptions.streamFn = streamFn;
    agent = new Agent(agentOptions);

    await agent.prompt('start');

    expect(requestTools).toEqual([['browser_inspect_page_implementation'], []]);
    expect(requestGuidance[1]).toContain('页面实现巡检已经完成');
    expect(requestGuidance[1]).toContain('工具调用预算已经用完');
  });

  it('ends a repeated duplicate-breaker loop with one tool-free final response', async () => {
    const requestTools: string[][] = [];
    const requestGuidance: string[] = [];
    const execute = vi.fn(async () => {
      throw new Error('missing');
    });
    const queryTool: AgentTool = {
      name: 'browser_query_dom',
      label: 'Query DOM',
      description: 'Query a selector.',
      parameters: Type.Object({ selector: Type.String(), limit: Type.Number() }),
      execute,
    };
    let agent: Agent;
    const agentOptions = createBrowserAgentOptions({
      provider,
      tabId: 1,
      tools: [queryTool],
      readToolCallBudget: 12,
      writeToolCallBudget: 24,
      steer: (message) => agent.steer(message),
    });
    const streamFn: StreamFn = vi.fn((model: Model<any>, context: Context) => {
      requestTools.push(context.tools?.map((tool) => tool.name) ?? []);
      requestGuidance.push(userText(context.messages));
      if (requestTools.length > 5) throw new Error('repeated blocks did not enter the final phase');
      const toolName = requestTools.length < 5 ? 'browser_query_dom' : 'missing_tool';
      return completedStream(toolCallMessage(model, `call-${requestTools.length}`, toolName));
    });
    agentOptions.streamFn = streamFn;
    agent = new Agent(agentOptions);

    await agent.prompt('start');

    expect(requestTools).toEqual([
      ['browser_query_dom'],
      ['browser_query_dom'],
      ['browser_query_dom'],
      ['browser_query_dom'],
      [],
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requestGuidance.at(-1)).toContain('连续被阻止');
  });
});
