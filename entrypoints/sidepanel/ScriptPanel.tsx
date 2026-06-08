import { useScript } from './scriptStore';
import { SCRIPT_TEMPLATES } from './scriptTemplates';

// 脚本改造面板（ref: technical-plan.md §4.2）。
// 生成 → 预览 → 用户确认 → 注入执行，支持撤销。
export default function ScriptPanel() {
  const {
    code,
    issues,
    syntaxError,
    instruction,
    busy,
    error,
    result,
    canUndo,
    setInstruction,
    setCode,
    loadTemplate,
    generate,
    run,
    undo,
  } = useScript();

  const hasDanger = issues.some((i) => i.level === 'danger');

  return (
    <main className="flex-1 space-y-3 overflow-auto p-4">
      <section>
        <h2 className="mb-2 text-xs font-medium text-neutral-500">内置模板</h2>
        <div className="flex flex-wrap gap-2">
          {SCRIPT_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => loadTemplate(t.code)}
              title={t.description}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs"
            >
              {t.name}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium text-neutral-500">用 AI 生成脚本</h2>
        <div className="flex items-end gap-2">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            placeholder="描述你想对当前页面做的改造，例如「隐藏所有评论区」"
            className="flex-1 resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
          />
          <button
            onClick={generate}
            disabled={busy || !instruction.trim()}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            生成
          </button>
        </div>
      </section>

      {code && (
        <section>
          <h2 className="mb-2 text-xs font-medium text-neutral-500">脚本预览（可编辑）</h2>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            rows={10}
            className="block w-full resize-y rounded-md border border-neutral-300 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100 focus:outline-none"
          />

          {syntaxError && (
            <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              语法错误：{syntaxError}
            </div>
          )}

          {issues.length > 0 && (
            <ul className="mt-2 space-y-1">
              {issues.map((it, i) => (
                <li
                  key={i}
                  className={
                    'rounded-md border p-2 text-xs ' +
                    (it.level === 'danger'
                      ? 'border-red-200 bg-red-50 text-red-700'
                      : 'border-amber-200 bg-amber-50 text-amber-800')
                  }
                >
                  {it.level === 'danger' ? '⛔ 危险' : '⚠️ 注意'}：{it.message}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={run}
              disabled={busy || !!syntaxError}
              className={
                'rounded-md px-3 py-1.5 text-sm text-white disabled:opacity-50 ' +
                (hasDanger ? 'bg-red-600' : 'bg-neutral-900')
              }
            >
              {hasDanger ? '仍要执行' : '确认执行'}
            </button>
            <button
              onClick={undo}
              disabled={busy || !canUndo}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              撤销
            </button>
          </div>

          <p className="mt-2 text-[11px] text-neutral-400">
            脚本在确认后才会注入当前页面。撤销基于执行前的页面快照，可能无法恢复脚本状态。
          </p>
        </section>
      )}

      {result && (
        <div className="rounded-md border border-green-200 bg-green-50 p-2 text-xs text-green-700">
          {result}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          {error}
        </div>
      )}
    </main>
  );
}
