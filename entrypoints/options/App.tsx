import { useEffect, useState } from 'react';
import {
  loadSettings,
  saveSettings,
  newProviderId,
  PROVIDER_PRESETS,
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

export default function App() {
  const [settings, setSettings] = useState<Settings>({ providers: [] });
  const [draft, setDraft] = useState<ProviderConfig>(EMPTY_DRAFT);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  const isEditing = draft.id !== '';

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  }

  async function persist(next: Settings) {
    setSettings(next);
    await saveSettings(next);
  }

  function applyPreset(name: string) {
    const preset = PROVIDER_PRESETS.find((p) => p.name === name);
    if (!preset) return;
    setDraft((d) => ({
      ...d,
      name: d.name || preset.name,
      baseURL: preset.baseURL,
      model: preset.model,
    }));
  }

  async function saveDraft() {
    if (!draft.name.trim() || !draft.baseURL.trim() || !draft.model.trim()) {
      flash('请填写名称、Base URL 和模型');
      return;
    }
    const providers = [...settings.providers];
    if (isEditing) {
      const idx = providers.findIndex((p) => p.id === draft.id);
      if (idx >= 0) providers[idx] = draft;
    } else {
      const created = { ...draft, id: newProviderId() };
      providers.push(created);
    }
    const next: Settings = {
      providers,
      activeProviderId: settings.activeProviderId ?? providers[0]?.id,
    };
    await persist(next);
    setDraft(EMPTY_DRAFT);
    flash('已保存');
  }

  async function remove(id: string) {
    const providers = settings.providers.filter((p) => p.id !== id);
    const activeProviderId =
      settings.activeProviderId === id ? providers[0]?.id : settings.activeProviderId;
    await persist({ providers, activeProviderId });
    if (draft.id === id) setDraft(EMPTY_DRAFT);
  }

  async function setActive(id: string) {
    await persist({ ...settings, activeProviderId: id });
  }

  return (
    <div className="mx-auto max-w-2xl p-8 text-neutral-900">
      <h1 className="mb-1 text-xl font-semibold">Aluminum 设置</h1>
      <p className="mb-6 text-sm text-neutral-500">
        配置 OpenAI 兼容的模型 Provider。API Key 仅保存在本机
        <code className="mx-1 rounded bg-neutral-100 px-1">chrome.storage.local</code>
        ，不会上传或同步（ref: technical-plan.md §6）。
      </p>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium">已配置的 Provider</h2>
        {settings.providers.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 p-4 text-xs text-neutral-400">
            尚未配置任何 Provider，请在下方添加。
          </p>
        ) : (
          <ul className="space-y-2">
            {settings.providers.map((p) => {
              const active = p.id === settings.activeProviderId;
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-3 rounded-md border border-neutral-200 p-3"
                >
                  <input
                    type="radio"
                    name="active"
                    checked={active}
                    onChange={() => setActive(p.id)}
                    title="设为当前 Provider"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {p.name}
                      {active && (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-neutral-400">
                      {p.model} · {p.baseURL} · Key {p.apiKey ? '••••' + p.apiKey.slice(-4) : '未填写'}
                    </div>
                  </div>
                  <button
                    onClick={() => setDraft(p)}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => remove(p.id)}
                    className="rounded border border-red-200 px-2 py-1 text-xs text-red-600"
                  >
                    删除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 p-4">
        <h2 className="mb-3 text-sm font-medium">{isEditing ? '编辑 Provider' : '添加 Provider'}</h2>

        <label className="mb-3 block text-xs text-neutral-500">
          快速预设
          <select
            className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
            value=""
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

        <Field
          label="名称"
          value={draft.name}
          placeholder="例如 DeepSeek"
          onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
        />
        <Field
          label="Base URL"
          value={draft.baseURL}
          placeholder="https://api.deepseek.com/v1"
          onChange={(v) => setDraft((d) => ({ ...d, baseURL: v }))}
        />
        <Field
          label="模型"
          value={draft.model}
          placeholder="deepseek-chat"
          onChange={(v) => setDraft((d) => ({ ...d, model: v }))}
        />
        <Field
          label="API Key"
          type="password"
          value={draft.apiKey}
          placeholder="sk-..."
          onChange={(v) => setDraft((d) => ({ ...d, apiKey: v }))}
        />

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={saveDraft}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white"
          >
            {isEditing ? '保存修改' : '添加'}
          </button>
          {isEditing && (
            <button
              onClick={() => setDraft(EMPTY_DRAFT)}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            >
              取消
            </button>
          )}
          {toast && <span className="text-xs text-green-600">{toast}</span>}
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  placeholder,
  type = 'text',
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mb-3 block text-xs text-neutral-500">
      {label}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
      />
    </label>
  );
}
