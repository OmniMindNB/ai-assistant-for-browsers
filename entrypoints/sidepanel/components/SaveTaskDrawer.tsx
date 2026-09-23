import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import { describeTrajectoryStep, MAX_TRAJECTORY_STEPS, MAX_TRAJECTORY_VALUE_CHARS } from '@/lib/agent/task-trajectory';
import type { ChatMessage } from '@/lib/chat/messages';
import { buildRecordedTaskDraft, toRecordedShortcut, type RecordedTaskDraft } from '@/lib/chat/recorded-task';
import { updateShortcutConfigs } from '@/lib/shortcuts';
import { IconAlertTriangle, IconClose, IconTrash } from '../icons';
import { useModalKeyboard } from './useModalKeyboard';

export interface SaveTaskDrawerProps {
  open: boolean;
  messages: ChatMessage[];
  /** 用户点了"保存为指令"的那条 assistant 回复；null 即关闭。 */
  messageId: string | null;
  onClose(): void;
  onSaved(name: string): void;
}

// 保存录制指令的抽屉（ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §4.3）。
// 形态与 HistoryDrawer 一致：遮罩 + 侧滑面板 + Esc 关闭 + Tab 焦点圈在面板里（见 useModalKeyboard）。
// 保存时不调用模型：默认拼出来的用户原话已经足够准确，多一次调用就多一条失败路径。
export function SaveTaskDrawer({ open, messages, messageId, onClose, onSaved }: SaveTaskDrawerProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RecordedTaskDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 只在打开（或换了一条回复）时取一次草稿：之后用户的编辑不能被流式推来的新 messages 覆盖掉。
  useEffect(() => {
    if (!open || !messageId) {
      setDraft(null);
      setError(null);
      return;
    }
    setDraft(buildRecordedTaskDraft(messages, messageId));
    setError(null);
    requestAnimationFrame(() => nameRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messageId]);

  useModalKeyboard(dialogRef, open, onClose);

  if (!open || !draft) return null;

  const canSave = !saving && draft.name.trim().length > 0 && draft.goal.trim().length > 0 && draft.steps.length > 0;

  function updateValue(stepIndex: number, valueIndex: number, value: string) {
    setDraft((current) => {
      if (!current) return current;
      const steps = current.steps.map((step, i) =>
        i !== stepIndex || !step.values
          ? step
          : { ...step, values: step.values.map((item, j) => (j === valueIndex ? { ...item, value } : item)) },
      );
      return { ...current, steps };
    });
  }

  function removeStep(stepIndex: number) {
    setDraft((current) => (current ? { ...current, steps: current.steps.filter((_, i) => i !== stepIndex) } : current));
  }

  async function save() {
    if (!draft || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateShortcutConfigs((current) => [...current, toRecordedShortcut(draft)]);
      onSaved(draft.name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    'w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('recordedTask.title')}
        onMouseDown={(event) => event.stopPropagation()}
        className="relative ml-auto flex h-full w-[min(26rem,calc(100vw-2rem))] flex-col bg-white text-neutral-700 shadow-xl dark:bg-neutral-900 dark:text-neutral-300"
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">{t('recordedTask.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-3 text-sm">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('recordedTask.privacyNote')}</p>
          {draft.incompleteOutcome && (
            <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
              <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('recordedTask.incompleteWarning')}</span>
            </p>
          )}

          <label className="block text-xs text-neutral-600 dark:text-neutral-300">
            <span className="mb-1 block">{t('recordedTask.nameLabel')}</span>
            <input
              ref={nameRef}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className={inputClass}
            />
          </label>

          <label className="block text-xs text-neutral-600 dark:text-neutral-300">
            <span className="mb-1 block">{t('recordedTask.goalLabel')}</span>
            <textarea
              value={draft.goal}
              rows={4}
              onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
              className={inputClass}
            />
          </label>

          <div>
            <p className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">{t('recordedTask.stepsLabel')}</p>
            {draft.truncated && (
              <p className="mb-2 text-xs text-neutral-500">{t('recordedTask.truncatedNotice', { count: MAX_TRAJECTORY_STEPS })}</p>
            )}
            <ol aria-label={t('recordedTask.stepsLabel')} className="space-y-2">
              {draft.steps.map((step, stepIndex) => (
                <li key={stepIndex} className="rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-xs tabular-nums text-neutral-400">{stepIndex + 1}.</span>
                    <span className="min-w-0 flex-1 break-words text-xs">{describeTrajectoryStep(step, t)}</span>
                    <button
                      type="button"
                      onClick={() => removeStep(stepIndex)}
                      aria-label={t('recordedTask.deleteStepAria', { index: stepIndex + 1 })}
                      className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-neutral-800"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {step.values?.map((value, valueIndex) =>
                    value.sensitive || value.value === undefined ? null : (
                      <input
                        key={valueIndex}
                        value={value.value}
                        maxLength={MAX_TRAJECTORY_VALUE_CHARS}
                        aria-label={t('recordedTask.valueAria', { target: value.target })}
                        onChange={(event) => updateValue(stepIndex, valueIndex, event.target.value)}
                        className={`mt-1.5 ${inputClass} py-1 text-xs`}
                      />
                    ),
                  )}
                </li>
              ))}
            </ol>
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('recordedTask.save')}
          </button>
        </div>
      </aside>
    </div>
  );
}
