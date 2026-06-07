import { useDiagnostics } from './store';

export default function App() {
  const { log, busy, ping, extract } = useDiagnostics();

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3">
        <div className="h-6 w-6 rounded bg-neutral-900 text-center text-sm font-bold leading-6 text-white">
          Al
        </div>
        <h1 className="text-sm font-semibold">Aluminum</h1>
        <span className="ml-auto text-xs text-neutral-400">Phase 0</span>
      </header>

      <main className="flex-1 overflow-auto p-4">
        <p className="mb-3 text-xs text-neutral-500">
          脚手架自检：验证侧边栏 ↔ Service Worker ↔ Content Script 三端通信。
        </p>
        <div className="mb-4 flex gap-2">
          <button
            onClick={ping}
            disabled={busy}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Ping 后台
          </button>
          <button
            onClick={extract}
            disabled={busy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50"
          >
            提取当前页面
          </button>
        </div>

        <ul className="space-y-1 rounded-md bg-white p-3 font-mono text-xs shadow-sm">
          {log.length === 0 ? (
            <li className="text-neutral-400">暂无日志，点击上方按钮测试。</li>
          ) : (
            log.map((line, i) => <li key={i}>{line}</li>)
          )}
        </ul>
      </main>
    </div>
  );
}
