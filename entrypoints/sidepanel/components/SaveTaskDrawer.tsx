import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import { completeOnce, type CompletionTarget } from '@/lib/agent/one-shot-completion';
import { describeTrajectoryStep, MAX_TRAJECTORY_STEPS, MAX_TRAJECTORY_VALUE_CHARS } from '@/lib/agent/task-trajectory';
import type { ChatMessage } from '@/lib/chat/messages';
import { buildRecordedTaskDraft, toRecordedShortcut, type RecordedTaskDraft } from '@/lib/chat/recorded-task';
import {
  buildPlaybookRequest,
  MAX_PLAYBOOK_APPLICABILITY_CHARS,
  MAX_PLAYBOOK_STEP_CHARS,
  MAX_PLAYBOOK_STEPS,
  parsePlaybookResponse,
  PLAYBOOK_MAX_TOKENS,
  type TaskPlaybook,
} from '@/lib/chat/task-playbook';
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
  /** 整理通用做法用的模型：面板当前选中的 provider，model 换成输入框里选中的那个；null 即未配置。 */
  provider: CompletionTarget | null;
}

// 保存录制指令的抽屉（ref: docs/superpowers/specs/2026-09-23-task-replay-design.md §4.3）。
// 形态与 HistoryDrawer 一致：遮罩 + 侧滑面板 + Esc 关闭 + Tab 焦点圈在面板里（见 useModalKeyboard）。
// 打开即调用当前模型把这次运行整理成通用做法（ref: docs/superpowers/specs/2026-09-23-generalized-task-playbook-design.md §5）；
// 失败时退回录制步骤，照样能保存——总结是增强，不是保存的前提。
export function SaveTaskDrawer({ open, messages, messageId, onClose, onSaved, provider }: SaveTaskDrawerProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RecordedTaskDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  type SummaryState = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; reason: string };
  const [summary, setSummary] = useState<SummaryState>({ status: 'loading' });
  const [playbook, setPlaybook] = useState<TaskPlaybook | null>(null);
  // 用户动过名称就不再用模型给的名称覆盖。
  const nameEditedRef = useRef(false);
  // 每次发起总结递增；迟到的旧结果与当前序号不符就丢弃。
  const summarySeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  function cancelSummary() {
    summarySeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }

  async function summarize(source: RecordedTaskDraft) {
    cancelSummary();
    const seq = summarySeqRef.current;
    if (!provider) {
      setSummary({ status: 'failed', reason: t('recordedTask.summaryNoModel') });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setSummary({ status: 'loading' });
    const request = buildPlaybookRequest(source, t);
    const result = await completeOnce(provider, { ...request, maxTokens: PLAYBOOK_MAX_TOKENS, signal: controller.signal });
    if (seq !== summarySeqRef.current) return;
    abortRef.current = null;
    if (!result.ok) {
      setSummary({ status: 'failed', reason: result.error });
      return;
    }
    const parsed = parsePlaybookResponse(result.text);
    if (!parsed) {
      setSummary({ status: 'failed', reason: t('recordedTask.summaryUnparsable') });
      return;
    }
    setPlaybook(parsed.playbook);
    if (!nameEditedRef.current) setDraft((current) => (current ? { ...current, name: parsed.name } : current));
    setSummary({ status: 'ready' });
  }

  // 只在打开（或换了一条回复）时取一次草稿并发起总结：之后用户的编辑不能被流式推来的新 messages 覆盖掉。
  useEffect(() => {
    if (!open || !messageId) {
      cancelSummary();
      setDraft(null);
      setPlaybook(null);
      setError(null);
      return;
    }
    const built = buildRecordedTaskDraft(messages, messageId);
    setDraft(built);
    setPlaybook(null);
    setError(null);
    nameEditedRef.current = false;
    if (built) void summarize(built);
    // 用 rAF 延后到下一帧，给对话框一次布局机会；总结请求是异步的，这一帧可能拖到总结结果回来之后才跑——
    // 这时如果用户已经点进了对话框里别的输入框（比如趁总结还没回来先编辑名称/做法字段），就不要把焦点抢回名称框。
    requestAnimationFrame(() => {
      if (dialogRef.current?.contains(document.activeElement)) return;
      nameRef.current?.focus();
    });
    return cancelSummary;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messageId]);

  useModalKeyboard(dialogRef, open, onClose);

  if (!open || !draft) return null;

  const usablePlaybook = summary.status === 'ready' && playbook !== null && playbook.steps.some((step) => step.trim());
  const canSave =
    !saving && draft.name.trim().length > 0 && draft.goal.trim().length > 0 && (usablePlaybook || draft.steps.length > 0);

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

  function updatePlaybook(update: (current: TaskPlaybook) => TaskPlaybook) {
    setPlaybook((current) => (current ? update(current) : current));
  }

  async function save() {
    if (!draft || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateShortcutConfigs((current) => [
        ...current,
        toRecordedShortcut({ ...draft, ...(summary.status === 'ready' && playbook ? { playbook } : {}) }),
      ]);
      onSaved(draft.name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    'w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

  const recordedSteps = (
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
  );

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
              onChange={(event) => {
                nameEditedRef.current = true;
                setDraft({ ...draft, name: event.target.value });
              }}
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

          <div className="flex items-center gap-2 text-xs" aria-live="polite">
            {summary.status === 'loading' && (
              <span className="text-neutral-500 dark:text-neutral-400">{t('recordedTask.summaryLoading')}</span>
            )}
            {summary.status === 'failed' && (
              <span className="text-amber-700 dark:text-amber-300">
                {t('recordedTask.summaryFailed', { reason: summary.reason })}
              </span>
            )}
            <button
              type="button"
              onClick={() => void summarize(draft)}
              disabled={summary.status === 'loading'}
              className="ml-auto shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              {t('recordedTask.resummarize')}
            </button>
          </div>

          {summary.status === 'ready' && playbook ? (
            <>
              <label className="block text-xs text-neutral-600 dark:text-neutral-300">
                <span className="mb-1 block">{t('recordedTask.applicabilityLabel')}</span>
                <input
                  value={playbook.applicability}
                  maxLength={MAX_PLAYBOOK_APPLICABILITY_CHARS}
                  onChange={(event) => updatePlaybook((current) => ({ ...current, applicability: event.target.value }))}
                  className={inputClass}
                />
              </label>
              <div>
                <p className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">{t('recordedTask.playbookStepsLabel')}</p>
                <ol className="space-y-2">
                  {playbook.steps.map((step, stepIndex) => (
                    <li key={stepIndex} className="flex items-start gap-2">
                      <span className="mt-2 shrink-0 text-xs tabular-nums text-neutral-400">{stepIndex + 1}.</span>
                      <input
                        value={step}
                        maxLength={MAX_PLAYBOOK_STEP_CHARS}
                        aria-label={t('recordedTask.playbookStepAria', { index: stepIndex + 1 })}
                        onChange={(event) =>
                          updatePlaybook((current) => ({
                            ...current,
                            steps: current.steps.map((item, i) => (i === stepIndex ? event.target.value : item)),
                          }))
                        }
                        className={`${inputClass} py-1 text-xs`}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          updatePlaybook((current) => ({ ...current, steps: current.steps.filter((_, i) => i !== stepIndex) }))
                        }
                        aria-label={t('recordedTask.deletePlaybookStepAria', { index: stepIndex + 1 })}
                        className="mt-1 shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-neutral-800"
                      >
                        <IconTrash className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ol>
                {playbook.steps.length < MAX_PLAYBOOK_STEPS && (
                  <button
                    type="button"
                    onClick={() => updatePlaybook((current) => ({ ...current, steps: [...current.steps, ''] }))}
                    className="mt-2 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {t('recordedTask.addStep')}
                  </button>
                )}
              </div>
              <details className="text-xs text-neutral-500 dark:text-neutral-400">
                <summary className="cursor-pointer select-none">
                  {t('recordedTask.rawStepsToggle', { count: draft.steps.length })}
                </summary>
                <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                  {draft.steps.map((step, stepIndex) => (
                    <li key={stepIndex} className="break-words">{describeTrajectoryStep(step, t)}</li>
                  ))}
                </ol>
              </details>
            </>
          ) : (
            recordedSteps
          )}

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
