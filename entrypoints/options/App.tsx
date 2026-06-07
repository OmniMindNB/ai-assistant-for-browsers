export default function App() {
  return (
    <div className="mx-auto max-w-2xl p-8 text-neutral-900">
      <h1 className="mb-2 text-xl font-semibold">Aluminum 设置</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Provider / API Key 与 Skill 管理将在后续阶段实现（ref: technical-plan.md §5、§4.3）。
      </p>

      <section className="rounded-lg border border-neutral-200 p-4">
        <h2 className="mb-1 text-sm font-medium">模型 Provider</h2>
        <p className="text-xs text-neutral-400">Phase 1 接入 OpenAI-Compatible 配置表单。</p>
      </section>
    </div>
  );
}
