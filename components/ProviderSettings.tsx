// Provider 配置 UI（列表 + 新增/编辑表单）。
// 同时供 options 页与侧边栏内嵌「设置」视图复用，避免重复实现。
// 配置存于 chrome.storage.local（ref: lib/settings.ts）。
import { useEffect, useRef, useState } from 'react';
import {
  loadSettings,
  saveSettings,
  newProviderId,
  applyPresetToDraft,
  hasDuplicateProviderName,
  trimProviderDraft,
  PROVIDER_PRESETS,
  STORAGE_KEY,
  type ProviderConfig,
  type Settings,
} from '@/lib/settings';

const EMPTY_DRAFT: ProviderConfig = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  model: '',
};

/** 默认模型之外的其他可用模型（逗号分隔展示）。 */
function extrasOf(p: ProviderConfig): string {
  return (p.models ?? []).filter((m) => m !== p.model).join(', ');
}

/** 「其他可用模型」输入框的提示文案：随当前选中的预设切换，展示该厂商的其他模型示例。 */
function extrasPlaceholder(selectedPreset: string): string {
  const preset = PROVIDER_PRESETS.find((p) => p.name === selectedPreset);
  const extras = (preset?.models ?? []).filter((m) => m !== preset?.model);
  return extras.length ? `例如 ${extras.join(', ')}` : '例如 deepseek-v4-flash';
}

/** 根据默认模型 + 其他模型文本，重建去重后的 models 列表。 */
function withExtras(p: ProviderConfig, extrasText: string): ProviderConfig {
  const extras = extrasText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const models = [p.model, ...extras].filter(Boolean);
  const seen = new Set<string>();
  const deduped = models.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
  return { ...p, models: deduped.length ? deduped : undefined };
}

export default function ProviderSettings({ onChange }: { onChange?: () => void }) {
  const [settings, setSettings] = useState<Settings>({ providers: [] });
  const [draft, setDraft] = useState<ProviderConfig>(EMPTY_DRAFT);
  // 独立于 draft 的原始文本，避免每次按键都经过 withExtras 的去重/过滤——
  // 那样会在用户粘贴的内容恰好等于「模型（默认）」时把输入静默清空（看起来像粘贴无效）。
  const [extrasText, setExtrasText] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [editingRemoved, setEditingRemoved] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const confirmTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const isEditing = draft.id !== '';

  useEffect(() => {
    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[STORAGE_KEY];
      if (!change) return;
      const next = (change.newValue as Settings | undefined) ?? { providers: [] };
      setSettings(next);
      if (isEditing && !next.providers.some((p) => p.id === draft.id)) {
        setEditingRemoved(true);
      }
    };
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => browser.storage.onChanged.removeListener(handleStorageChange);
  }, [isEditing, draft.id]);

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) {
        window.clearTimeout(confirmTimeoutRef.current);
      }
    };
  }, []);

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  }

  function loadDraft(p: ProviderConfig) {
    setDraft(p);
    setExtrasText(extrasOf(p));
    setSelectedPreset('');
    setEditingRemoved(false);
  }

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setExtrasText('');
    setSelectedPreset('');
    setEditingRemoved(false);
  }

  async function persist(next: Settings) {
    setSettings(next);
    await saveSettings(next);
    onChange?.();
  }

  function applyPreset(name: string) {
    setSelectedPreset(name);
    const preset = PROVIDER_PRESETS.find((p) => p.name === name);
    if (!preset) return;
    const result = applyPresetToDraft(draft, extrasText, preset, isEditing);
    setDraft(result.draft);
    setExtrasText(result.extrasText);
  }

  async function saveDraft() {
    if (saving) return;
    if (editingRemoved) {
      flash('该 Provider 已在别处被删除，请放弃编辑');
      return;
    }
    const trimmed = trimProviderDraft(draft);
    if (!trimmed.name || !trimmed.baseURL || !trimmed.model) {
      flash('请填写名称、Base URL 和模型');
      return;
    }
    const finalDraft = withExtras(trimmed, extrasText);
    const newId = newProviderId();
    setSaving(true);
    try {
      const isDuplicateName = hasDuplicateProviderName(
        settings.providers,
        finalDraft.name,
        isEditing ? finalDraft.id : undefined,
      );
      const providers = [...settings.providers];
      if (isEditing) {
        const idx = providers.findIndex((p) => p.id === finalDraft.id);
        if (idx >= 0) providers[idx] = finalDraft;
      } else {
        providers.push({ ...finalDraft, id: newId });
      }
      const next: Settings = {
        providers,
        activeProviderId: settings.activeProviderId ?? providers[0]?.id,
      };
      await persist(next);
      resetDraft();
      flash(isDuplicateName ? '已保存（存在同名 Provider）' : '已保存');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const providers = settings.providers.filter((p) => p.id !== id);
    const activeProviderId =
      settings.activeProviderId === id ? providers[0]?.id : settings.activeProviderId;
    await persist({ providers, activeProviderId });
    if (draft.id === id) resetDraft();
  }

  function requestDelete(id: string) {
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
    }
    setConfirmingDeleteId(id);
    confirmTimeoutRef.current = window.setTimeout(() => {
      setConfirmingDeleteId(null);
      confirmTimeoutRef.current = null;
    }, 3000);
  }

  async function confirmDelete(id: string) {
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setConfirmingDeleteId(null);
    await remove(id);
  }

  async function setActive(id: string) {
    await persist({ ...settings, activeProviderId: id });
  }

  return (
    <>
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          已配置的 Provider
        </h2>
        {settings.providers.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 p-4 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
            尚未配置任何 Provider，请在下方添加。
          </p>
        ) : (
          <ul className="space-y-2">
            {settings.providers.map((p) => {
              const active = p.id === settings.activeProviderId;
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-3 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <input
                    type="radio"
                    name="active"
                    checked={active}
                    onChange={() => setActive(p.id)}
                    title="设为当前 Provider"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {p.name}
                      {active && (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-900/40 dark:text-green-300">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-neutral-400 dark:text-neutral-500">
                      {p.model} · {p.baseURL} · Key {p.apiKey ? '••••' + p.apiKey.slice(-4) : '未填写'}
                    </div>
                  </div>
                  <button
                    onClick={() => loadDraft(p)}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() =>
                      confirmingDeleteId === p.id ? confirmDelete(p.id) : requestDelete(p.id)
                    }
                    className={
                      confirmingDeleteId === p.id
                        ? 'rounded border border-red-600 bg-red-600 px-2 py-1 text-xs text-white transition-colors hover:bg-red-700'
                        : 'rounded border border-red-200 px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40'
                    }
                  >
                    {confirmingDeleteId === p.id ? '确认删除？' : '删除'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {isEditing ? '编辑 Provider' : '添加 Provider'}
        </h2>

        {editingRemoved && (
          <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            此 Provider 已在别处被删除，继续保存不会生效。
            <button type="button" onClick={resetDraft} className="ml-2 underline">
              放弃编辑
            </button>
          </p>
        )}

        <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
          快速预设
          <select
            className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            value={selectedPreset}
            onChange={(e) => applyPreset(e.target.value)}
          >
            <option value="">选择以填充 Base URL / 模型…</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveDraft();
          }}
        >
          <Field
            label="名称"
            value={draft.name}
            placeholder="例如 DeepSeek"
            required
            onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
          />
          <Field
            label="Base URL"
            value={draft.baseURL}
            placeholder="https://api.deepseek.com"
            required
            onChange={(v) => setDraft((d) => ({ ...d, baseURL: v }))}
          />
          <Field
            label="模型（默认）"
            value={draft.model}
            placeholder="deepseek-v4-pro"
            required
            onChange={(v) => setDraft((d) => ({ ...d, model: v }))}
          />
          <Field
            label="其他可用模型（逗号分隔，可选）"
            value={extrasText}
            placeholder={extrasPlaceholder(selectedPreset)}
            onChange={setExtrasText}
          />
          <Field
            label="API Key"
            type="password"
            toggleable
            value={draft.apiKey}
            placeholder="sk-..."
            onChange={(v) => setDraft((d) => ({ ...d, apiKey: v }))}
          />

          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
            >
              {isEditing ? '保存修改' : '添加'}
            </button>
            {isEditing && (
              <button
                type="button"
                onClick={resetDraft}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                取消
              </button>
            )}
            {toast && <span className="text-xs text-green-600 dark:text-green-400">{toast}</span>}
          </div>
        </form>
      </section>
    </>
  );
}

function Field({
  label,
  value,
  placeholder,
  type = 'text',
  required,
  toggleable,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
  toggleable?: boolean;
  onChange: (v: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const resolvedType = toggleable ? (revealed ? 'text' : 'password') : type;
  return (
    <label className="mb-3 block text-xs text-neutral-500 dark:text-neutral-400">
      {label}
      {required && <span className="text-red-500"> *</span>}
      <div className="relative mt-1">
        <input
          type={resolvedType}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600"
        />
        {toggleable && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="absolute inset-y-0 right-2 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            {revealed ? '隐藏' : '显示'}
          </button>
        )}
      </div>
    </label>
  );
}
