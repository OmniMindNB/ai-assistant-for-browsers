import { describe, expect, it } from 'vitest';
import { repairToolArguments, salvageToolCallFromText } from './tool-call-repair';

describe('repairToolArguments', () => {
  it('parses well-formed arguments unchanged', () => {
    expect(repairToolArguments('{"selector":"#submit","index":0}')).toEqual({ selector: '#submit', index: 0 });
  });

  it('returns an empty object for blank arguments', () => {
    expect(repairToolArguments('')).toEqual({});
    expect(repairToolArguments('   ')).toEqual({});
  });

  // 小模型常见畸形一：把参数对象再 JSON.stringify 一次，于是收到的是一个「内容是 JSON 的字符串」。
  it('unwraps double-stringified arguments', () => {
    expect(repairToolArguments(JSON.stringify('{"selector":"#submit"}'))).toEqual({ selector: '#submit' });
  });

  it('unwraps arguments stringified three times', () => {
    expect(repairToolArguments(JSON.stringify(JSON.stringify('{"a":1}')))).toEqual({ a: 1 });
  });

  // 畸形二：把参数裹进 markdown 代码围栏。
  it('strips a fenced code block around the arguments', () => {
    expect(repairToolArguments('```json\n{"selector":"#submit"}\n```')).toEqual({ selector: '#submit' });
    expect(repairToolArguments('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  // 畸形三：参数前后混入自然语言。
  it('extracts the object when prose surrounds it', () => {
    expect(repairToolArguments('好的，我来点击：{"selector":"#submit"} 完成了')).toEqual({ selector: '#submit' });
  });

  it('picks the outermost object when the arguments contain nested braces', () => {
    expect(repairToolArguments('note {"a":{"b":2},"c":3} end')).toEqual({ a: { b: 2 }, c: 3 });
  });

  it('returns an empty object for a JSON array or primitive', () => {
    expect(repairToolArguments('[1,2]')).toEqual({});
    expect(repairToolArguments('42')).toEqual({});
  });

  it('returns an empty object when nothing can be salvaged', () => {
    expect(repairToolArguments('这不是 JSON')).toEqual({});
    expect(repairToolArguments('{unclosed')).toEqual({});
  });
});

describe('salvageToolCallFromText', () => {
  const toolNames = ['browser_click', 'browser_read_page'];

  // 最要命的一种：模型完全没走 tool_calls，把调用写进正文。
  // 不捞回来的话工具根本不会执行，用户只看到一坨裸 JSON。
  it('salvages an OpenAI-shaped call written into the message text', () => {
    const result = salvageToolCallFromText('{"name":"browser_click","arguments":{"selector":"#ok"}}', toolNames);
    expect(result).toEqual({ name: 'browser_click', arguments: { selector: '#ok' }, strippedText: '' });
  });

  it('accepts input and parameters as the argument key', () => {
    expect(salvageToolCallFromText('{"name":"browser_click","input":{"a":1}}', toolNames)?.arguments).toEqual({ a: 1 });
    expect(salvageToolCallFromText('{"name":"browser_click","parameters":{"a":1}}', toolNames)?.arguments).toEqual({ a: 1 });
  });

  it('salvages the single-key action shape', () => {
    const result = salvageToolCallFromText('{"browser_click":{"selector":"#ok"}}', toolNames);
    expect(result?.name).toBe('browser_click');
    expect(result?.arguments).toEqual({ selector: '#ok' });
  });

  it('salvages a call wrapped in a fenced code block', () => {
    const result = salvageToolCallFromText('```json\n{"name":"browser_read_page","arguments":{}}\n```', toolNames);
    expect(result?.name).toBe('browser_read_page');
  });

  it('keeps the surrounding prose and drops only the JSON blob', () => {
    const result = salvageToolCallFromText('我先读一下页面。\n{"name":"browser_read_page","arguments":{}}\n稍等。', toolNames);
    expect(result?.name).toBe('browser_read_page');
    expect(result?.strippedText).toBe('我先读一下页面。\n稍等。');
  });

  it('defaults to empty arguments when the call carries none', () => {
    expect(salvageToolCallFromText('{"name":"browser_read_page"}', toolNames)?.arguments).toEqual({});
  });

  // 不认识的名字一律不捞：否则会凭空造出一次调用，反而更难排查。
  it('ignores a name that is not a known tool', () => {
    expect(salvageToolCallFromText('{"name":"rm_rf","arguments":{}}', toolNames)).toBeUndefined();
    expect(salvageToolCallFromText('{"totally_unknown":{"a":1}}', toolNames)).toBeUndefined();
  });

  it('ignores text with no JSON at all', () => {
    expect(salvageToolCallFromText('页面讲的是气候变化。', toolNames)).toBeUndefined();
  });

  it('ignores a plain JSON object that names no tool', () => {
    expect(salvageToolCallFromText('结果是 {"count":3}', toolNames)).toBeUndefined();
  });

  it('returns undefined when no tools are available', () => {
    expect(salvageToolCallFromText('{"name":"browser_click","arguments":{}}', [])).toBeUndefined();
  });
});
