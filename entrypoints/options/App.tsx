import ProviderSettings from '@/components/ProviderSettings';
import AppearanceSettings from '@/components/AppearanceSettings';
import { useTheme } from '@/lib/theme';

export default function App() {
  const { mode, setMode } = useTheme();
  return (
    <div className="min-h-screen bg-neutral-50 p-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-xl font-semibold">Aluminum 设置</h1>
        <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
          配置 OpenAI 兼容的模型 Provider。API Key 仅保存在本机
          <code className="mx-1 rounded bg-neutral-100 px-1 dark:bg-neutral-800">chrome.storage.local</code>
          ，不会上传或同步（ref: technical-plan.md §6）。
        </p>
        <AppearanceSettings mode={mode} onSet={setMode} />
        <ProviderSettings />
      </div>
    </div>
  );
}
