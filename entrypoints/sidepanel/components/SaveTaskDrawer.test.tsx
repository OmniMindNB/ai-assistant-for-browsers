import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompleteOnceResult } from '@/lib/agent/one-shot-completion';
import type { RecordedTaskDraft } from '@/lib/chat/recorded-task';
import { LocaleProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/locales/en';
import { zh } from '@/lib/i18n/locales/zh';
import type { ShortcutConfig } from '@/lib/shortcuts';
import { SaveTaskDrawer } from './SaveTaskDrawer';

const draft: RecordedTaskDraft = {
  name: '草稿名',
  goal: '把视频调到 2 倍速',
  steps: [{ tool: 'browser_click', target: '倍速按钮' }] as RecordedTaskDraft['steps'],
  truncated: false,
  incompleteOutcome: false,
  replyContext: '',
};

const completeOnce = vi.fn<() => Promise<CompleteOnceResult>>();
const updateShortcutConfigs = vi.fn();

vi.mock('@/lib/agent/one-shot-completion', () => ({ completeOnce: () => completeOnce() }));
vi.mock('@/lib/chat/recorded-task', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/chat/recorded-task')>()),
  buildRecordedTaskDraft: () => structuredClone(draft),
}));
vi.mock('@/lib/shortcuts', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shortcuts')>()),
  updateShortcutConfigs: (update: (current: ShortcutConfig[]) => ShortcutConfig[]) => updateShortcutConfigs(update([])),
}));

// 语言跟随运行环境，两套文案都认。
function either(key: keyof typeof zh & keyof typeof en) {
  return new RegExp(`^(${escape(zh[key])}|${escape(en[key])})$`);
}
function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderDrawer() {
  return render(
    <LocaleProvider>
      <SaveTaskDrawer
        open
        messages={[]}
        messageId="m1"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        provider={{ baseURL: 'https://example.com', apiKey: 'k', model: 'm', api: 'openai-completions' }}
      />
    </LocaleProvider>,
  );
}

describe('SaveTaskDrawer 整理中保存', () => {
  beforeEach(() => {
    completeOnce.mockReset();
    updateShortcutConfigs.mockReset().mockResolvedValue(undefined);
  });

  it('整理中保存按钮写明是跳过整理，点下去存的不带通用做法', async () => {
    completeOnce.mockReturnValue(new Promise(() => {}));
    renderDrawer();

    const button = await screen.findByRole('button', { name: either('recordedTask.skipSummarySave') });
    expect(screen.getByText(either('recordedTask.skipSummaryNote'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: either('recordedTask.save') })).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(updateShortcutConfigs).toHaveBeenCalledTimes(1));
    const [saved] = updateShortcutConfigs.mock.calls[0][0] as ShortcutConfig[];
    expect(saved.playbook).toBeUndefined();
  });

  it('整理完成后恢复普通保存按钮，说明文字消失', async () => {
    completeOnce.mockResolvedValue({
      ok: true,
      truncated: false,
      text: JSON.stringify({ name: '视频倍速', applicability: '带倍速控件的视频页', steps: ['打开倍速菜单', '选 2 倍'] }),
    } as CompleteOnceResult);
    renderDrawer();

    expect(await screen.findByRole('button', { name: either('recordedTask.save') })).toBeInTheDocument();
    expect(screen.getByDisplayValue('带倍速控件的视频页')).toBeInTheDocument();
    expect(screen.queryByText(either('recordedTask.skipSummaryNote'))).toBeNull();
  });
});
