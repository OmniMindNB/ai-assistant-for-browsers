import { create } from 'zustand';
import {
  sendMessage,
  type InjectScriptPayload,
  type InjectScriptResult,
  type MessageResponse,
  type PageContent,
} from '@/lib/messaging';
import { chatStream, type ChatMessage } from '@/lib/llm';
import { getActiveProvider } from '@/lib/settings';
import { analyzeScript, type SecurityIssue } from '@/lib/security';

// 脚本生成 / 预览 / 注入（ref: technical-plan.md §4.2）。
// 关键安全约束：LLM 生成脚本默认不自动执行，必须用户在预览后显式确认。

const SCRIPT_SYSTEM_PROMPT =
  '你是一个浏览器脚本生成器。根据用户需求，生成一段在网页 MAIN world 中运行的纯 JavaScript 代码。' +
  '要求：1) 只输出代码本身，不要任何解释或 Markdown 围栏；2) 不要使用 eval / new Function / 外发网络请求；' +
  '3) 代码应是可直接执行的语句（无需包裹函数）；4) 操作尽量安全、可逆，聚焦页面 DOM/样式。';

const MAX_PAGE_CHARS = 4000;

interface ScriptState {
  code: string;
  issues: SecurityIssue[];
  syntaxError: string | null;
  instruction: string;
  busy: boolean;
  error: string | null;
  result: string | null;
  canUndo: boolean;
  setInstruction: (v: string) => void;
  setCode: (code: string) => void;
  loadTemplate: (code: string) => void;
  generate: () => Promise<void>;
  run: () => Promise<void>;
  undo: () => Promise<void>;
  reset: () => void;
}

let abortController: AbortController | null = null;

function analyze(code: string): Pick<ScriptState, 'issues' | 'syntaxError'> {
  if (!code.trim()) return { issues: [], syntaxError: null };
  const report = analyzeScript(code);
  return {
    issues: report.issues,
    syntaxError: report.valid ? null : (report.syntaxError ?? '语法错误'),
  };
}

// 去除 LLM 输出可能包裹的 Markdown 代码围栏。
function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:[a-zA-Z]*)?\n([\s\S]*?)\n```$/);
  return (match ? match[1] : trimmed).trim();
}

export const useScript = create<ScriptState>((set, get) => ({
  code: '',
  issues: [],
  syntaxError: null,
  instruction: '',
  busy: false,
  error: null,
  result: null,
  canUndo: false,

  setInstruction: (v) => set({ instruction: v }),

  setCode: (code) => set({ code, ...analyze(code), result: null }),

  loadTemplate: (code) => set({ code, ...analyze(code), error: null, result: null }),

  generate: async () => {
    const instruction = get().instruction.trim();
    if (!instruction || get().busy) return;

    const provider = await getActiveProvider();
    if (!provider?.apiKey) {
      set({ error: '未配置 Provider 或缺少 API Key，请在「设置」中补全。' });
      return;
    }

    set({ busy: true, error: null, result: null });

    let pageHint = '';
    try {
      const res = (await sendMessage('EXTRACT_PAGE')) as MessageResponse<PageContent>;
      if (res.ok && res.data) {
        pageHint = `\n\n当前页面：${res.data.title}（${res.data.url}）\n正文片段：\n${res.data.text.slice(0, MAX_PAGE_CHARS)}`;
      }
    } catch {
      // 提取失败不阻断生成
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: SCRIPT_SYSTEM_PROMPT },
      { role: 'user', content: `需求：${instruction}${pageHint}` },
    ];

    abortController = new AbortController();
    let acc = '';
    try {
      for await (const delta of chatStream(provider, messages, {
        signal: abortController.signal,
        temperature: 0.2,
      })) {
        acc += delta;
        set({ code: acc });
      }
      const code = stripFences(acc);
      set({ code, ...analyze(code) });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      set({ busy: false });
      abortController = null;
    }
  },

  run: async () => {
    const code = get().code.trim();
    if (!code || get().busy) return;
    if (get().syntaxError) {
      set({ error: `脚本存在语法错误，已阻止执行：${get().syntaxError}` });
      return;
    }
    set({ busy: true, error: null, result: null });
    try {
      const res = (await sendMessage<InjectScriptPayload, InjectScriptResult>('INJECT_SCRIPT', {
        code,
      })) as MessageResponse<InjectScriptResult>;
      if (!res.ok) throw new Error(res.error ?? '注入失败');
      set({
        result: res.data?.result ? `执行完成：${res.data.result}` : '执行完成',
        canUndo: !!res.data?.snapshotSaved,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ busy: false });
    }
  },

  undo: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const res = (await sendMessage('UNDO_SCRIPT')) as MessageResponse<InjectScriptResult>;
      if (!res.ok) throw new Error(res.error ?? '撤销失败');
      set({ result: '已撤销上一次改动', canUndo: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ busy: false });
    }
  },

  reset: () => {
    abortController?.abort();
    set({ code: '', issues: [], syntaxError: null, instruction: '', error: null, result: null });
  },
}));
