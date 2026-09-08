import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from '@/lib/i18n';
import { normalizeShortcutCommand } from '@/lib/workbench/presentation';
import {
  SHORTCUTS_STORAGE_KEY,
  defaultShortcutConfigs,
  loadShortcutConfigs,
  moveShortcut,
  newShortcutId,
  repairShortcutConfigs,
  resolveShortcut,
  updateShortcutConfigs,
  validateShortcutConfigs,
  type MoveDirection,
  type ShortcutConfig,
  type ShortcutScope,
} from '@/lib/shortcuts';
import {
  SELECTION_ASK_ENABLED_KEY,
  loadSelectionAskEnabled,
  saveSelectionAskEnabled,
} from '@/lib/selection-ask';
import ConfirmDialog from './ConfirmDialog';

interface ShortcutDraft {
  name: string;
  scope: ShortcutScope;
  prompt: string;
}

interface ShortcutFieldErrors {
  name?: string;
  prompt?: string;
}

function normalizedDraft(draft: ShortcutDraft): ShortcutDraft {
  return {
    name: draft.name.trim(),
    scope: draft.scope,
    prompt: draft.prompt.trim(),
  };
}

const DELETE_CONFIRM_TIMEOUT_MS = 3000;

const EMPTY_DRAFT: ShortcutDraft = {
  name: '',
  scope: 'page',
  prompt: '',
};

export default function ShortcutSettings() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ShortcutConfig[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [hasInvalidConfig, setHasInvalidConfig] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ShortcutDraft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ShortcutFieldErrors>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [selectionAskEnabled, setSelectionAskEnabled] = useState(true);
  // 会连带删掉用户内容、又需要一段说明文字的两个动作（恢复预设 / 删除无效项）走模态确认框；
  // 同时只可能挂起一个，所以用一个字段而不是两个布尔。
  const [pendingAction, setPendingAction] = useState<'restore' | 'repair' | null>(null);
  // 逐条删除是轻量确认，用行内二次点击（同 RedactionSettings.tsx / HistoryDrawer.tsx）。
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    let active = true;
    loadShortcutConfigs()
      .then((result) => {
        if (!active) return;
        setItems(result.shortcuts);
        showValidationErrors(result.errors);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setErrors([storageErrorMessage(error)]);
      });
    loadSelectionAskEnabled()
      .then((enabled) => {
        if (active) setSelectionAskEnabled(enabled);
      })
      .catch((error: unknown) => {
        if (active) setErrors([storageErrorMessage(error)]);
      });

    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local') return;
      const shortcutsChange = changes[SHORTCUTS_STORAGE_KEY];
      if (shortcutsChange) {
        const result = validateShortcutConfigs(shortcutsChange.newValue);
        setItems(result.shortcuts);
        showValidationErrors(result.errors);
      }
      const toggleChange = changes[SELECTION_ASK_ENABLED_KEY];
      if (toggleChange) setSelectionAskEnabled((toggleChange.newValue as boolean | undefined) ?? true);
    };

    browser.storage.onChanged.addListener(handleStorageChange);
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [t]);

  async function toggleSelectionAsk() {
    const next = !selectionAskEnabled;
    setSelectionAskEnabled(next);
    try {
      await saveSelectionAskEnabled(next);
    } catch (error) {
      setSelectionAskEnabled(!next);
      setErrors([storageErrorMessage(error)]);
    }
  }

  function showValidationErrors(details: string[]) {
    if (details.length === 0) {
      setHasInvalidConfig(false);
      setErrors([]);
      return;
    }
    console.error('[ShortcutSettings] Invalid shortcut configuration:', details);
    setHasInvalidConfig(true);
    setErrors([]);
  }

  function storageErrorMessage(error: unknown) {
    console.error('[ShortcutSettings] Shortcut storage operation failed:', error);
    return t('shortcut.storageError');
  }

  async function repairInvalid() {
    if (saving) return;
    setSaving(true);
    setErrors([]);
    setFlash(null);
    try {
      const next = await repairShortcutConfigs();
      setItems(next);
      setHasInvalidConfig(false);
      setErrors([]);
      setFlash(t('shortcut.repaired'));
    } catch (error) {
      setErrors([storageErrorMessage(error)]);
    } finally {
      setSaving(false);
      setPendingAction(null);
    }
  }

  function beginAdd() {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
    setFieldErrors({});
    setErrors([]);
    setFlash(null);
  }

  function beginEdit(item: ShortcutConfig) {
    const resolved = resolveShortcut(item, t);
    setEditingId(item.id);
    setDraft({
      name: resolved.name,
      scope: resolved.scope,
      prompt: resolved.prompt,
    });
    setFieldErrors({});
    setErrors([]);
    setFlash(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setFieldErrors({});
    setErrors([]);
  }

  async function saveDraft() {
    if (!draft || saving) return;
    const nextDraft = normalizedDraft(draft);
    if (!nextDraft.name || !nextDraft.prompt) {
      const nextFieldErrors: ShortcutFieldErrors = {
        ...(!nextDraft.name ? { name: t('shortcut.nameRequired') } : {}),
        ...(!nextDraft.prompt ? { prompt: t('shortcut.promptRequired') } : {}),
      };
      setFieldErrors(nextFieldErrors);
      setErrors([]);
      if (nextFieldErrors.name) {
        nameInputRef.current?.focus();
      } else {
        promptInputRef.current?.focus();
      }
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setErrors([]);
    try {
      const next = await updateShortcutConfigs((current) => {
        if (editingId) {
          const index = current.findIndex((item) => item.id === editingId);
          if (index < 0) throw new Error(t('shortcut.invalidConfig'));
          current[index] = {
            ...current[index],
            ...nextDraft,
            customized: true,
          };
          return current;
        }
        return [
          ...current,
          {
            id: newShortcutId(),
            origin: 'custom',
            customized: true,
            ...nextDraft,
          },
        ];
      });
      setItems(next);
      setEditingId(null);
      setDraft(null);
      setFieldErrors({});
      setFlash(t('shortcut.saved'));
    } catch (error) {
      setErrors([storageErrorMessage(error)]);
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(id: string) {
    if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
    setConfirmingDeleteId(id);
    confirmTimeoutRef.current = window.setTimeout(() => {
      setConfirmingDeleteId(null);
      confirmTimeoutRef.current = null;
    }, DELETE_CONFIRM_TIMEOUT_MS);
  }

  async function remove(id: string) {
    if (saving) return;
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setConfirmingDeleteId(null);
    setSaving(true);
    setErrors([]);
    try {
      const next = await updateShortcutConfigs((current) =>
        current.filter((item) => item.id !== id),
      );
      setItems(next);
      if (editingId === id) {
        setEditingId(null);
        setDraft(null);
        setFieldErrors({});
      }
    } catch (error) {
      setErrors([storageErrorMessage(error)]);
    } finally {
      setSaving(false);
    }
  }

  // 出厂重置：顺序、文案、集合全部回到默认。会连带删掉用户自建的快捷方式和改过的
  // 内建文案，所以先弹确认框把代价说清楚——正是这段说明让它没法退回浏览器原生确认框
  // （那种弹窗塞不下解释，也没有暗色模式）。
  async function restore() {
    if (saving) return;
    setSaving(true);
    setErrors([]);
    try {
      const next = await updateShortcutConfigs(() => defaultShortcutConfigs());
      setItems(next);
      setFlash(t('shortcut.restored'));
    } catch (error) {
      setErrors([storageErrorMessage(error)]);
    } finally {
      setSaving(false);
      setPendingAction(null);
    }
  }

  async function move(id: string, direction: MoveDirection) {
    if (saving) return;
    setSaving(true);
    setErrors([]);
    try {
      const next = await updateShortcutConfigs((current) =>
        moveShortcut(current, id, direction),
      );
      setItems(next);
    } catch (error) {
      setErrors([storageErrorMessage(error)]);
    } finally {
      setSaving(false);
    }
  }

  async function dropBefore(targetId: string) {
    const sourceId = draggedId;
    setDraggedId(null);
    if (!sourceId || sourceId === targetId || saving) return;
    setSaving(true);
    setErrors([]);
    try {
      const next = await updateShortcutConfigs((current) => {
        const sourceIndex = current.findIndex((item) => item.id === sourceId);
        if (sourceIndex < 0) return current;
        const reordered = [...current];
        const [source] = reordered.splice(sourceIndex, 1);
        const targetIndex = reordered.findIndex((item) => item.id === targetId);
        if (targetIndex < 0) return current;
        reordered.splice(targetIndex, 0, source);
        return reordered;
      });
      setItems(next);
    } catch (error) {
      setErrors([storageErrorMessage(error)]);
    } finally {
      setSaving(false);
    }
  }

  function startDrag(event: DragEvent<HTMLLIElement>, id: string) {
    setDraggedId(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }

  return (
    <section className="mb-6">
      <label className="mb-4 flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={selectionAskEnabled}
          onChange={() => void toggleSelectionAsk()}
          className="h-4 w-4 rounded border-neutral-300 text-indigo-600 focus:ring-indigo-500 dark:border-neutral-700"
        />
        {t('shortcut.selectionAskToggleLabel')}
      </label>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            {t('shortcut.heading')}
          </h3>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('shortcut.description')}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving || hasInvalidConfig}
            onClick={() => setPendingAction('restore')}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {t('shortcut.restoreDefaults')}
          </button>
          <button
            type="button"
            disabled={saving || hasInvalidConfig}
            onClick={beginAdd}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {t('shortcut.add')}
          </button>
        </div>
      </div>

      {hasInvalidConfig && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          <p>{t('shortcut.invalidConfig')}</p>
          {errors.map((error) => (
            <p key={error} className="mt-1">
              {error}
            </p>
          ))}
          <button
            type="button"
            disabled={saving}
            onClick={() => setPendingAction('repair')}
            className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1.5 font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-900/40"
          >
            {t('shortcut.repairInvalid')}
          </button>
        </div>
      )}
      {!hasInvalidConfig && errors.length > 0 && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      {flash && (
        <p
          role="status"
          className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300"
        >
          {flash}
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-4 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
          {t('shortcut.empty')}
        </p>
      ) : (
        <ul aria-label={t('shortcut.heading')} className="space-y-2">
          {items.map((item, index) => {
            const resolved = resolveShortcut(item, t);
            const command = normalizeShortcutCommand(resolved.name);
            return (
              <li
                key={item.id}
                draggable={!saving && !hasInvalidConfig}
                onDragStart={(event) => startDrag(event, item.id)}
                onDragEnd={() => setDraggedId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => void dropBefore(item.id)}
                className={[
                  'rounded-md border bg-white p-3 dark:bg-neutral-900',
                  draggedId === item.id
                    ? 'border-indigo-400 opacity-60 dark:border-indigo-500'
                    : 'border-neutral-200 dark:border-neutral-800',
                ].join(' ')}
              >
                <div className="flex items-start gap-2">
                  <span
                    aria-label={t('shortcut.drag')}
                    title={t('shortcut.drag')}
                    className="mt-0.5 cursor-grab text-neutral-400"
                  >
                    <IconGripVertical />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {resolved.name}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                      <span className="font-medium text-neutral-700 dark:text-neutral-300">{command}</span>
                      <span>{scopeLabel(resolved.scope)}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    <button
                      type="button"
                      disabled={saving || hasInvalidConfig || index === 0}
                      onClick={() => void move(item.id, 'up')}
                      aria-label={t('shortcut.moveUpAria', { name: resolved.name })}
                      title={t('shortcut.moveUp')}
                      className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-neutral-800"
                    >
                      <IconArrowUp />
                    </button>
                    <button
                      type="button"
                      disabled={saving || hasInvalidConfig || index === items.length - 1}
                      onClick={() => void move(item.id, 'down')}
                      aria-label={t('shortcut.moveDownAria', { name: resolved.name })}
                      title={t('shortcut.moveDown')}
                      className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-neutral-800"
                    >
                      <IconArrowDown />
                    </button>
                    <button
                      type="button"
                      disabled={saving || hasInvalidConfig}
                      onClick={() => beginEdit(item)}
                      aria-label={t('shortcut.editAria', { name: resolved.name })}
                      className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      type="button"
                      disabled={saving || hasInvalidConfig}
                      onClick={() =>
                        confirmingDeleteId === item.id ? void remove(item.id) : requestDelete(item.id)
                      }
                      aria-label={
                        confirmingDeleteId === item.id
                          ? t('shortcut.confirmDeleteAria', { name: resolved.name })
                          : t('shortcut.deleteAria', { name: resolved.name })
                      }
                      className={
                        confirmingDeleteId === item.id
                          ? 'rounded bg-red-50 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-900/40'
                          : 'rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40'
                      }
                    >
                      {confirmingDeleteId === item.id ? t('provider.confirmDelete') : t('common.delete')}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {draft && (
        <form
          aria-label={editingId ? t('shortcut.editHeading') : t('shortcut.addHeading')}
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
          className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900/60"
        >
          <h3 className="mb-3 text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {editingId ? t('shortcut.editHeading') : t('shortcut.addHeading')}
          </h3>
          <div className="space-y-3">
            <label className="block text-xs text-neutral-600 dark:text-neutral-300">
              <span className="mb-1 block">{t('shortcut.name')}</span>
              <input
                ref={nameInputRef}
                value={draft.name}
                disabled={saving}
                aria-invalid={Boolean(fieldErrors.name)}
                aria-describedby={fieldErrors.name ? 'shortcut-name-error' : undefined}
                onChange={(event) => {
                  setDraft((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  );
                  setFieldErrors((current) => ({ ...current, name: undefined }));
                }}
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
              {fieldErrors.name && (
                <span
                  id="shortcut-name-error"
                  className="mt-1 block text-xs text-red-600 dark:text-red-400"
                >
                  {fieldErrors.name}
                </span>
              )}
            </label>
            <label className="block text-xs text-neutral-600 dark:text-neutral-300">
              <span className="mb-1 block">{t('shortcut.scope')}</span>
              <select
                value={draft.scope}
                disabled={saving}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, scope: event.target.value as ShortcutScope }
                      : current,
                  )
                }
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              >
                <option value="page">{t('shortcut.scopePage')}</option>
                <option value="selection">{t('shortcut.scopeSelection')}</option>
                <option value="none">{t('shortcut.scopeNone')}</option>
              </select>
            </label>
            <label className="block text-xs text-neutral-600 dark:text-neutral-300">
              <span className="mb-1 block">{t('shortcut.prompt')}</span>
              <textarea
                ref={promptInputRef}
                value={draft.prompt}
                disabled={saving}
                rows={5}
                aria-invalid={Boolean(fieldErrors.prompt)}
                aria-describedby={fieldErrors.prompt ? 'shortcut-prompt-error' : undefined}
                onChange={(event) => {
                  setDraft((current) =>
                    current ? { ...current, prompt: event.target.value } : current,
                  );
                  setFieldErrors((current) => ({ ...current, prompt: undefined }));
                }}
                className="w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
              {fieldErrors.prompt && (
                <span
                  id="shortcut-prompt-error"
                  className="mt-1 block text-xs text-red-600 dark:text-red-400"
                >
                  {fieldErrors.prompt}
                </span>
              )}
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={cancelEdit}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-white disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving || hasInvalidConfig}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('shortcut.save')}
            </button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        title={
          pendingAction === 'repair'
            ? t('shortcut.confirmRepairInvalidTitle')
            : t('shortcut.confirmRestoreTitle')
        }
        description={
          pendingAction === 'repair'
            ? t('shortcut.confirmRepairInvalid')
            : t('shortcut.confirmRestore')
        }
        confirmLabel={
          pendingAction === 'repair' ? t('shortcut.repairInvalid') : t('shortcut.restoreDefaults')
        }
        busy={saving}
        onConfirm={() => (pendingAction === 'repair' ? void repairInvalid() : void restore())}
        onCancel={() => setPendingAction(null)}
      />
    </section>
  );

  function scopeLabel(scope: ShortcutScope) {
    if (scope === 'selection') return t('shortcut.scopeSelection');
    if (scope === 'none') return t('shortcut.scopeNone');
    return t('shortcut.scopePage');
  }
}

function SettingsIcon({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      {children}
    </svg>
  );
}

function IconGripVertical() {
  return (
    <SettingsIcon>
      <circle cx="9" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="18" r="1" />
    </SettingsIcon>
  );
}

function IconArrowUp() {
  return (
    <SettingsIcon>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="6 11 12 5 18 11" />
    </SettingsIcon>
  );
}

function IconArrowDown() {
  return (
    <SettingsIcon>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="6 13 12 19 18 13" />
    </SettingsIcon>
  );
}
