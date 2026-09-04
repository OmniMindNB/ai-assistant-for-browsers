import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { compactAgentMessages } from './agent';

// 注意：compactAgentMessages 内部先经过 planContextWindow -> windowWithIntactToolCalls，
// 后者会把找不到对应 assistant(tool_calls) 声明的 toolResult 整条过滤掉（见 agent.ts 里
// 「窗口边界不得切出无主的 toolResult」那组测试）。所以这里每个 toolResult 前都要有一条
// 声明同一个 toolCallId 的 assistant 消息，否则 compacted 会直接是空数组——这是对 agent.ts
// 既有行为的必要适配，不是这个任务改动的逻辑。
describe('截图在上下文里的淘汰', () => {
  function announce(id: string, toolName: string): AgentMessage {
    return {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: toolName, arguments: {} }],
    } as unknown as AgentMessage;
  }

  function screenshotResult(id: string): AgentMessage {
    return {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'browser_screenshot',
      content: [
        { type: 'text', text: `截图 ${id}` },
        { type: 'image', data: `DATA-${id}`, mimeType: 'image/jpeg' },
      ],
      isError: false,
      timestamp: 0,
    } as unknown as AgentMessage;
  }

  function readPageResult(id: string): AgentMessage {
    return {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'browser_read_page',
      content: [{ type: 'text', text: '页面正文' }],
      isError: false,
      timestamp: 0,
    } as unknown as AgentMessage;
  }

  function imagesIn(messages: AgentMessage[]): string[] {
    return messages.flatMap((message) => {
      const content = (message as unknown as { content?: unknown }).content;
      return Array.isArray(content)
        ? content
            .filter((part: { type: string }) => part.type === 'image')
            .map((part: { data: string }) => part.data)
        : [];
    });
  }

  it('只保留最新一张截图的图片', () => {
    const compacted = compactAgentMessages(
      [
        announce('a', 'browser_screenshot'),
        screenshotResult('a'),
        announce('b', 'browser_screenshot'),
        screenshotResult('b'),
        announce('c', 'browser_screenshot'),
        screenshotResult('c'),
      ],
      { start: 0 },
    );
    expect(imagesIn(compacted)).toEqual(['DATA-c']);
  });

  it('被淘汰的截图换成文字占位符', () => {
    const compacted = compactAgentMessages(
      [announce('a', 'browser_screenshot'), screenshotResult('a'), announce('b', 'browser_screenshot'), screenshotResult('b')],
      { start: 0 },
    );
    const text = JSON.stringify(compacted);
    expect(text).toContain('截图已移出上下文');
    expect(text).not.toContain('DATA-a');
  });

  // 这是与既有行为冲突的那一条：非最新的只读结果本来会被整条摘要掉，
  // 最新那张截图必须豁免，否则多步视觉任务（截图 → 点击 → 再看）里
  // 模型看一眼就失忆。
  it('最新截图后面跟了别的读取工具时，图片仍然保留', () => {
    const compacted = compactAgentMessages(
      [announce('a', 'browser_screenshot'), screenshotResult('a'), announce('r', 'browser_read_page'), readPageResult('r')],
      { start: 0 },
    );
    expect(imagesIn(compacted)).toEqual(['DATA-a']);
  });

  it('没有截图时行为不变', () => {
    const compacted = compactAgentMessages(
      [announce('r1', 'browser_read_page'), readPageResult('r1'), announce('r2', 'browser_read_page'), readPageResult('r2')],
      { start: 0 },
    );
    expect(imagesIn(compacted)).toEqual([]);
  });
});
