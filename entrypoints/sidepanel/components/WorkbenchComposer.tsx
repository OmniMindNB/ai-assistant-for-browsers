import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from '@/lib/i18n';
import { providerModels, type ProviderConfig } from '@/lib/settings';
import type { ShortcutConfig, ResolvedShortcut } from '@/lib/shortcuts';
import { filterShortcutCommands, isUsableShortcutCommand } from '@/lib/workbench/presentation';
import type { PageContextState, TabReference } from '../store';
import {
  hasBusyAttachments,
  isAttachmentReady,
  type PendingAttachment,
} from '@/lib/chat/attachments';
import { findMentionQuery, type MentionQuery, type ReferencableTab } from '@/lib/chat/tab-reference';
import { AttachmentChip } from './AttachmentChip';
import { TabRefChip } from './TabRefChip';
import { IconCheck, IconChevronDown, IconClose, IconPaperclip, IconPlus, IconSend, IconStop } from '../icons';

export interface WorkbenchComposerProps {
  busy: boolean;
  pageContext: PageContextState;
  providers: ProviderConfig[];
  selectedProviderId: string | null;
  selectedModel: string;
  shortcuts: Array<{ config: ShortcutConfig; resolved: ResolvedShortcut }>;
  /** 每次划词提问预填输入框后变为一个新的非零值；0 表示"从未发生过"，不触发聚焦。 */
  pendingFocusToken: number;
  /** 划词提问消费到的待引用文字（裁剪后）；渲染成独立卡片，null 时不显示。 */
  quotedSelection: string | null;
  /** 外部要求把 text 填进输入框（不发送）；token 变为新的非零值时生效，0 表示从未发生。 */
  draftSeed?: { text: string; token: number };
  /** 待发送附件的完整生命周期；历史附件由消息列表单独只读渲染。 */
  attachments: PendingAttachment[];
  /** 返回值真值时才清空输入框，与 store.send() 的"是否真的发起了这一轮"语义对齐。 */
  onSend(text: string): void | Promise<boolean>;
  onStop(): void;
  onRetryPageContext(): void;
  onRunShortcut(shortcut: ShortcutConfig): void;
  onSelectProviderModel(providerId: string, model: string): void;
  onClearQuotedSelection(): void;
  onAddAttachmentFiles(files: FileList | File[]): void;
  onRemoveAttachment(id: string): void;
  onRetryAttachment(id: string): void;
  /** 用户 @ 引用进来的只读标签页；chip 常驻显示，直到用户移除。 */
  tabReferences: TabReference[];
  onLoadReferencableTabs(): Promise<ReferencableTab[]>;
  onAddTabReference(tab: ReferencableTab): void;
  onRemoveTabReference(id: number): void;
}

type Popover = 'commands' | 'models' | 'insert' | 'tabs' | null;

function startsSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

export function WorkbenchComposer({
  busy,
  pageContext,
  providers,
  selectedProviderId,
  selectedModel,
  shortcuts,
  pendingFocusToken,
  quotedSelection,
  draftSeed,
  attachments,
  onSend,
  onStop,
  onRetryPageContext,
  onRunShortcut,
  onSelectProviderModel,
  onClearQuotedSelection,
  onAddAttachmentFiles,
  onRemoveAttachment,
  onRetryAttachment,
  tabReferences,
  onLoadReferencableTabs,
  onAddTabReference,
  onRemoveTabReference,
}: WorkbenchComposerProps) {
  const { t } = useTranslation();
  // 按键级别的草稿只有这个组件自己需要：留在全局 store 里会导致每次按键都触发整个 App
  // 重渲染（ref: [[project-ux-audit-2026-09-02]] 输入框全局态一条）。
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dragDepthRef = useRef(0);
  const [openPopover, setOpenPopover] = useState<Popover>(null);
  const [highlightedCommand, setHighlightedCommand] = useState(0);
  const [highlightedTab, setHighlightedTab] = useState(0);
  const [composing, setComposing] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [tabCandidates, setTabCandidates] = useState<ReferencableTab[]>([]);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const slashCommands = filterShortcutCommands(shortcuts, input);
  const commands = startsSlashCommand(input) || openPopover === 'commands'
    ? startsSlashCommand(input) ? slashCommands : filterShortcutCommands(shortcuts, '/')
    : [];
  const attachmentBusy = hasBusyAttachments(attachments);
  const requestBlocked = busy || attachmentBusy;
  const hasReadyAttachment = attachments.some(isAttachmentReady);
  const canSend = !requestBlocked
    && (input.trim().length > 0 || hasReadyAttachment);
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const currentModel = selectedModel || selectedProvider?.model || '';
  const modelLabel = currentModel || t('chat.noModelSelected');
  // 触发器上只留模型名，provider 名退到 title 里——鼠标悬停仍拿得到完整信息。
  const modelTriggerTitle = selectedProvider ? `${selectedProvider.name} · ${modelLabel}` : modelLabel;
  const modelOptions = providers.flatMap((provider) =>
    providerModels(provider).map((model) => ({ provider, model })),
  );
  const quickShortcuts = shortcuts.filter(isUsableShortcutCommand).slice(0, 4);

  // @ 提及必须按光标定位，不能照抄 / 的整串前缀判断——@ 会出现在句子中间。
  const syncMention = (value: string, caret: number) => {
    const next = findMentionQuery(value, caret);
    setMention(next);
    // 查询串一变，候选集就换了一批，高亮必须回到第一项——否则上一次停在第 3 项的高亮会
    // 落到一个语义上毫不相干的候选上，Enter 选中的东西和用户看到的对不上。
    setHighlightedTab(0);
    if (next && openPopover !== 'tabs') {
      setOpenPopover('tabs');
      void onLoadReferencableTabs().then(setTabCandidates);
    }
    if (!next && openPopover === 'tabs') setOpenPopover(null);
  };

  const mentionMatches = mention
    ? tabCandidates
        .filter((tab) => !tabReferences.some((item) => item.id === tab.id))
        .filter((tab) =>
          mention.query === ''
          || `${tab.title} ${tab.url}`.toLowerCase().includes(mention.query.toLowerCase()),
        )
        .slice(0, 8)
    : [];

  const pickTab = (tab: ReferencableTab) => {
    onAddTabReference(tab);
    // 选完把 "@query" 从输入框里删掉：引用已经变成 chip，留着这段文字只会混淆。
    if (mention) {
      const element = textareaRef.current;
      const caret = element?.selectionStart ?? input.length;
      setInput(input.slice(0, mention.start) + input.slice(caret));
    }
    setMention(null);
    setHighlightedTab(0);
    setOpenPopover(null);
  };

  const pageContextNotice =
    pageContext.status === 'error'
      ? { message: t('workbench.pageContextUnavailable', { message: pageContext.message }), retryable: true }
      : null;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    if (!input) {
      element.style.height = '';
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    if (pendingFocusToken === 0) return;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [pendingFocusToken]);

  // 外部把一段文字"填进"输入框（目前只有空状态的示例按钮）。用 token 触发而不是把草稿
  // 提升成受控 props：按键级别的状态必须留在本组件里，否则每次按键都会重渲染整个 App
  // （同上面 input 那条注释的理由）。token 变化才写一次，之后用户照常编辑。
  useEffect(() => {
    if (!draftSeed || draftSeed.token === 0) return;
    setInput(draftSeed.text);
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(draftSeed.text.length, draftSeed.text.length);
  }, [draftSeed?.token]);

  useEffect(() => {
    if (startsSlashCommand(input)) {
      setOpenPopover('commands');
      setHighlightedCommand(0);
    } else if (openPopover === 'commands') {
      setOpenPopover(null);
    }
  }, [input]);

  useEffect(() => {
    if (highlightedCommand >= commands.length) setHighlightedCommand(0);
  }, [commands.length, highlightedCommand]);

  // 候选是异步加载的（onLoadReferencableTabs），加载完成后条数可能比当前高亮还少。
  useEffect(() => {
    if (highlightedTab >= mentionMatches.length) setHighlightedTab(0);
  }, [mentionMatches.length, highlightedTab]);

  useEffect(() => {
    if (!busy) return;
    dragDepthRef.current = 0;
    setFileDragActive(false);
  }, [busy]);

  useEffect(() => {
    if (!openPopover) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenPopover(null);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [openPopover]);

  async function handleSend() {
    if (!canSend) return;
    const text = input;
    const started = await onSend(text);
    if (!started) return;
    setInput('');
    // mention 记的是"@ 在旧输入串里的下标"，输入框一清空这个下标就失效了；不重置的话
    // 弹层会带着上一条消息的查询串继续挂在那里（/ 命令菜单靠 input 的 useEffect 自动关，
    // @ 只在 syncMention 里同步，必须显式清）。
    setMention(null);
    setHighlightedTab(0);
    if (openPopover === 'tabs') setOpenPopover(null);
  }

  function runCommand(index: number) {
    const command = commands[index];
    if (!command || requestBlocked) return;
    onRunShortcut(command.config);
    setOpenPopover(null);
    if (startsSlashCommand(input)) setInput('');
    textareaRef.current?.focus();
  }

  // 斜杠命令入口和附件入口合并成一个"+"按钮下的小菜单，减少输入框左侧的图标数量。
  // 唯一学会"/"能唤出命令菜单的方式过去只有用户自己偶然敲出"/"——这里给一个常驻可见的
  // 入口，选中后等效于敲了"/"（复用同一套 commands 列表/键盘导航），焦点仍留在输入框，
  // 这样弹出后箭头键/Enter 照常可用（ref: [[project-design-audit-2026-09-02]] 发现1）。
  function toggleInsertMenu() {
    if (requestBlocked) return;
    setOpenPopover((current) => (current === 'insert' ? null : 'insert'));
  }

  function chooseSlashCommands() {
    if (requestBlocked) return;
    setHighlightedCommand(0);
    setOpenPopover('commands');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function chooseAttachFile() {
    if (busy) return;
    setOpenPopover(null);
    fileInputRef.current?.click();
  }

  function focusModelItem(index: number) {
    setOpenPopover('models');
    requestAnimationFrame(() => modelItemRefs.current[index]?.focus());
  }

  function selectModel(index: number) {
    const option = modelOptions[index];
    if (!option) return;
    onSelectProviderModel(option.provider.id, option.model);
    setOpenPopover(null);
    modelTriggerRef.current?.focus();
  }

  function handleModelTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' && modelOptions.length > 0) {
      event.preventDefault();
      focusModelItem(0);
    } else if (event.key === 'ArrowUp' && modelOptions.length > 0) {
      event.preventDefault();
      focusModelItem(modelOptions.length - 1);
    } else if (event.key === 'Escape' && openPopover === 'models') {
      event.preventDefault();
      setOpenPopover(null);
    }
  }

  function handleModelItemKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % modelOptions.length;
    if (event.key === 'ArrowUp') nextIndex = (index - 1 + modelOptions.length) % modelOptions.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = modelOptions.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      modelItemRefs.current[nextIndex]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpenPopover(null);
      modelTriggerRef.current?.focus();
    }
  }

  function handleComposerBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocused = event.relatedTarget;
    if (nextFocused instanceof Node && event.currentTarget.contains(nextFocused)) return;
    setOpenPopover(null);
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing || event.nativeEvent.isComposing) return;

    if (openPopover === 'commands') {
      if (event.key === 'ArrowDown' && commands.length > 0) {
        event.preventDefault();
        setHighlightedCommand((index) => (index + 1) % commands.length);
        return;
      }
      if (event.key === 'ArrowUp' && commands.length > 0) {
        event.preventDefault();
        setHighlightedCommand((index) => (index - 1 + commands.length) % commands.length);
        return;
      }
      if (event.key === 'Home' && commands.length > 0) {
        event.preventDefault();
        setHighlightedCommand(0);
        return;
      }
      if (event.key === 'End' && commands.length > 0) {
        event.preventDefault();
        setHighlightedCommand(commands.length - 1);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (commands.length > 0) runCommand(highlightedCommand);
        return;
      }
    }

    // @ 选择器和 / 命令菜单一样要吃掉方向键与 Enter：候选列表明明摆在眼前，Enter 却把
    // 带着裸 "@doc" 的整条消息发出去，是把选择动作静默变成了发送动作
    // （ref: 2026-09-05 跨标签页上下文最终评审 Important）。
    // 只在**有候选可选**时拦截：没有匹配项时列表是空的，再吞掉 Enter 就等于把用户困在
    // 一个只能按 Escape 才能离开的输入框里。
    if (openPopover === 'tabs' && mentionMatches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedTab((index) => (index + 1) % mentionMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedTab((index) => (index - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setHighlightedTab(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setHighlightedTab(mentionMatches.length - 1);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        pickTab(mentionMatches[highlightedTab] ?? mentionMatches[0]);
        return;
      }
    }

    if (event.key === 'Escape' && openPopover) {
      event.preventDefault();
      setOpenPopover(null);
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && canSend) {
      event.preventDefault();
      void handleSend();
    }
  }

  function isFileDrag(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (busy || !isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setFileDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (busy || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (busy || !isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setFileDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (busy || !isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setFileDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onAddAttachmentFiles(files);
  }

  return (
    <div ref={rootRef} onBlur={handleComposerBlur} className="relative border-t border-neutral-200 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-3xl">
        {pageContextNotice && (
          <div role={pageContextNotice.retryable ? 'alert' : 'status'} aria-live={pageContextNotice.retryable ? 'assertive' : 'polite'} className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="min-w-0 break-words">{pageContextNotice.message}</span>
            {pageContextNotice.retryable && (
              <button
                type="button"
                onClick={onRetryPageContext}
                className="shrink-0 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {t('workbench.retryPageContext')}
              </button>
            )}
          </div>
        )}
        {/* 工具条永不折行：一旦 flex-wrap 生效，它会随快捷指令条数在一行/两行之间跳，
            把下面的输入框一起顶上顶下。宽度不够时让胶囊横向滚出去。
            滚动只加在胶囊那一层，不加在整条工具条上，有两个原因：模型选择器不该被滚出视野；
            而且模型菜单是 absolute 定位、containing block 是最外层那个 relative 容器，
            任何夹在两者之间的 overflow 容器都会把它裁掉。 */}
        <div data-testid="composer-toolbar" className="mb-2 flex items-center gap-2">
          {providers.length > 0 && (
            <div className="shrink-0">
              <button
                ref={modelTriggerRef}
                type="button"
                onClick={() => setOpenPopover((open) => (open === 'models' ? null : 'models'))}
                onKeyDown={handleModelTriggerKeyDown}
                aria-label={t('chat.selectProviderModelAriaLabel')}
                aria-haspopup="menu"
                aria-expanded={openPopover === 'models'}
                aria-controls={openPopover === 'models' ? 'workbench-model-menu' : undefined}
                title={modelTriggerTitle}
                className="inline-flex max-w-[60vw] shrink-0 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
              >
                {/* provider 名不上触发器：下拉里每个分组标题都写着它，重复一遍只是在窄侧栏里吃宽度。 */}
                <span className="truncate font-medium text-neutral-700 dark:text-neutral-200">{modelLabel}</span>
                <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400 dark:text-neutral-500" />
              </button>
              {openPopover === 'models' && (
                <div id="workbench-model-menu" role="menu" aria-label={t('chat.modelSelectionAriaLabel')} className="absolute bottom-full left-3 right-3 z-20 mb-2 max-h-72 w-auto max-w-[calc(100%-1.5rem)] overflow-auto rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                  {providers.map((provider) => (
                    <div key={provider.id} className="py-1">
                      <div className="px-2 py-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">{provider.name}</div>
                      {providerModels(provider).map((model) => {
                        const active = provider.id === selectedProviderId && model === currentModel;
                        const optionIndex = modelOptions.findIndex((option) => option.provider.id === provider.id && option.model === model);
                        return (
                          <button
                            key={model}
                            ref={(element) => {
                              modelItemRefs.current[optionIndex] = element;
                            }}
                            type="button"
                            role="menuitem"
                            onKeyDown={(event) => handleModelItemKeyDown(event, optionIndex)}
                            onClick={() => selectModel(optionIndex)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-200 dark:hover:bg-neutral-800"
                          >
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">{active && <IconCheck className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />}</span>
                            <span className="truncate">{model}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div
            data-testid="composer-shortcuts"
            className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {quickShortcuts.map(({ config, resolved }) => (
              <button
                key={config.id}
                type="button"
                disabled={requestBlocked}
                onClick={() => onRunShortcut(config)}
                aria-label={resolved.name}
                title={resolved.name}
                className="inline-flex max-w-40 shrink-0 items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
              >
                <span className="truncate">{resolved.name}</span>
              </button>
            ))}
          </div>
        </div>


        {quotedSelection && (
          <div
            role="note"
            aria-label={t('workbench.quotedSelectionLabel')}
            className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-indigo-400 bg-neutral-100 py-1.5 pl-3 pr-2 dark:border-indigo-500 dark:bg-neutral-900"
          >
            <p className="line-clamp-3 min-w-0 flex-1 text-xs text-neutral-500 dark:text-neutral-400">
              {quotedSelection}
            </p>
            <button
              type="button"
              onClick={onClearQuotedSelection}
              aria-label={t('workbench.clearQuotedSelection')}
              title={t('workbench.clearQuotedSelection')}
              className="shrink-0 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                pending={attachment}
                onRemove={onRemoveAttachment}
                onRetry={onRetryAttachment}
              />
            ))}
          </div>
        )}

        {tabReferences.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2 pb-1">
            {tabReferences.map((reference) => (
              <TabRefChip key={reference.id} reference={reference} onRemove={onRemoveTabReference} />
            ))}
          </div>
        )}

        <div
          data-testid="composer-drop-zone"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`relative flex items-end gap-2 rounded-2xl border p-2 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-indigo-500/30 ${
            fileDragActive
              ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/30 dark:border-indigo-400 dark:bg-indigo-950/40'
              : 'border-neutral-300 bg-white focus-within:border-indigo-500 dark:border-neutral-700 dark:bg-neutral-900'
          }`}
        >
          {/* tabIndex={-1}：真实浏览器里 display:none 的元素天然不在 tab 序列里，
              但 jsdom 的 userEvent tab 模拟不遵循这条规则，需要显式声明保持行为一致。 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,application/pdf,image/*,.txt,.md,.markdown,.json,.csv,.log,.js,.jsx,.ts,.tsx,.py,.java,.go,.rs,.c,.cpp,.h,.hpp,.css,.html,.htm,.xml,.yaml,.yml,.sh,.bash,.ini,.toml,.rb,.php,.sql"
            className="hidden"
            tabIndex={-1}
            onChange={(event) => {
              const { files } = event.target;
              if (files && files.length > 0) onAddAttachmentFiles(files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={requestBlocked}
            onClick={toggleInsertMenu}
            aria-label={t('workbench.insertMenuAriaLabel')}
            title={t('workbench.insertMenuAriaLabel')}
            aria-haspopup="menu"
            aria-expanded={openPopover === 'insert'}
            aria-controls={openPopover === 'insert' ? 'workbench-insert-menu' : undefined}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <IconPlus className="h-5 w-5" />
          </button>
          {openPopover === 'insert' && (
            <div
              id="workbench-insert-menu"
              role="menu"
              aria-label={t('workbench.insertMenuAriaLabel')}
              className="absolute bottom-full left-0 z-20 mb-2 w-48 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
            >
              <button
                type="button"
                role="menuitem"
                onClick={chooseSlashCommands}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center text-sm font-semibold text-neutral-500 dark:text-neutral-400">/</span>
                <span className="truncate">{t('chat.slashCommandMenuAriaLabel')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={chooseAttachFile}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <IconPaperclip className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
                <span className="truncate">{t('workbench.attachButtonLabel')}</span>
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              syncMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyDown={handleTextareaKeyDown}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            rows={1}
            aria-label={t('chat.composerAriaLabel')}
            aria-haspopup="menu"
            aria-expanded={openPopover === 'commands'}
            aria-controls={openPopover === 'commands' ? 'workbench-slash-commands' : undefined}
            aria-activedescendant={openPopover === 'commands' && commands.length ? `workbench-command-${commands[highlightedCommand]?.config.id}` : undefined}
            placeholder={fileDragActive ? t('workbench.dropPdfPrompt') : t('workbench.composerPlaceholder')}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-600"
          />
          {busy ? (
            <button type="button" onClick={onStop} aria-label={t('chat.stopGenerating')} title={t('chat.stopGenerating')} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-neutral-700 dark:hover:bg-neutral-600">
              <IconStop className="h-5 w-5" />
            </button>
          ) : (
            <button type="button" onClick={() => void handleSend()} disabled={!canSend} aria-label={t('chat.sendMessage')} title={t('chat.sendMessage')} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-600">
              <IconSend className="h-5 w-5" />
            </button>
          )}

          {openPopover === 'commands' && (
            <div id="workbench-slash-commands" role="menu" aria-label={t('chat.slashCommandMenuAriaLabel')} className="absolute bottom-full left-0 z-20 mb-2 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
              {commands.map(({ config, resolved }, index) => (
                <button
                  id={`workbench-command-${config.id}`}
                  key={config.id}
                  type="button"
                  role="menuitem"
                  title={resolved.name}
                  aria-label={resolved.name}
                  onMouseEnter={() => setHighlightedCommand(index)}
                  disabled={requestBlocked}
                  aria-disabled={requestBlocked}
                  onClick={() => runCommand(index)}
                  className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${index === highlightedCommand ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
                >
                  {resolved.name}
                </button>
              ))}
              {commands.length === 0 && <div role="status" aria-live="polite" className="px-3 py-2 text-sm text-neutral-500">{t('chat.noMatchingSlashCommands')}</div>}
            </div>
          )}

          {openPopover === 'tabs' && (mentionMatches.length > 0 || pageContext.status === 'available') && (
            <ul id="workbench-tab-picker" className="absolute bottom-full mb-1 w-full overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              {/* 面板绑定的那个 tab 本来就是默认上下文。不列出来的话，用户会疑惑"我当前这个页面
                  为什么不在候选里"；列成可选项又会让它被重复计进 5 个上限。所以列成不可点的一行。 */}
              {pageContext.status === 'available' && (
                <li className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-500">
                  <span className="truncate">{pageContext.title}</span>
                  <span className="ml-auto shrink-0 text-xs">{t('workbench.currentPageIncluded')}</span>
                </li>
              )}
              {mentionMatches.map((tab, index) => (
                <li key={tab.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlightedTab(index)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${index === highlightedTab ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
                    onClick={() => pickTab(tab)}
                  >
                    {tab.favIconUrl && <img src={tab.favIconUrl} alt="" className="h-4 w-4 shrink-0" />}
                    <span className="truncate">{tab.title}</span>
                    <span className="ml-auto truncate text-xs text-neutral-500">{tab.url}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
