import { create } from 'zustand';
import {
  sendMessage,
  type MessageResponse,
  type PageContent,
} from '@/lib/messaging';

interface DiagnosticsState {
  log: string[];
  busy: boolean;
  append: (line: string) => void;
  ping: () => Promise<void>;
  extract: () => Promise<void>;
}

export const useDiagnostics = create<DiagnosticsState>((set, get) => ({
  log: [],
  busy: false,
  append: (line) => set((s) => ({ log: [...s.log, line] })),

  ping: async () => {
    set({ busy: true });
    try {
      const res = (await sendMessage('PING')) as MessageResponse<{ pong: boolean; ts: number }>;
      get().append(res.ok ? `✅ PING → pong @ ${res.data?.ts}` : `❌ PING 失败: ${res.error}`);
    } catch (e) {
      get().append(`❌ PING 异常: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set({ busy: false });
    }
  },

  extract: async () => {
    set({ busy: true });
    try {
      const res = (await sendMessage('EXTRACT_PAGE')) as MessageResponse<PageContent>;
      if (res.ok && res.data) {
        get().append(`✅ 已提取「${res.data.title}」(${res.data.length} 字)`);
      } else {
        get().append(`❌ 提取失败: ${res.error}`);
      }
    } catch (e) {
      get().append(`❌ 提取异常: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set({ busy: false });
    }
  },
}));
