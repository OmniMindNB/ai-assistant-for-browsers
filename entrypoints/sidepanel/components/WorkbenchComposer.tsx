import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useTranslation } from '@/lib/i18n';
import { providerModels, type ProviderConfig } from '@/lib/settings';
import type { ShortcutConfig, ResolvedShortcut } from '@/lib/shortcuts';
import { filterShortcutCommands } from '@/lib/workbench/presentation';
import type { PageContextState } from '../store';
import { IconCheck, IconChevronDown, IconSend, IconStop } from '../icons';

export interface WorkbenchComposerProps {
  input: string;
  busy: boolean;
  pageAttached: boolean;
  pageContext: PageContextState;
  providers: ProviderConfig[];
  selectedProviderId: string | null;
  selectedModel: string;
  shortcuts: Array<{ config: ShortcutConfig; resolved: ResolvedShortcut }>;
  onInput(value: string): void;
  onSend(): void;
  onStop(): void;
  onTogglePageAttached(): void;
  onRunShortcut(shortcut: ShortcutConfig): void;
  onSelectProviderModel(providerId: string, model: string): void;
}

type Popover = 'commands' | 'models' | null;

function startsSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

export function WorkbenchComposer({
  input,
  busy,
  pageAttached,
  pageContext,
  providers,
  selectedProviderId,
  selectedModel,
  shortcuts,
  onInput,
  onSend,
  onStop,
  onTogglePageAttached,
  onRunShortcut,
  onSelectProviderModel,
}: WorkbenchComposerProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [openPopover, setOpenPopover] = useState<Popover>(null);
  const [highlightedCommand, setHighlightedCommand] = useState(0);
  const [composing, setComposing] = useState(false);
  const slashCommands = filterShortcutCommands(shortcuts, input);
  const commands = startsSlashCommand(input) || openPopover === 'commands'
    ? startsSlashCommand(input) ? slashCommands : filterShortcutCommands(shortcuts, '/')
    : [];
  const canSend = input.trim().length > 0 && !busy;
  const pageIsAvailable = pageContext.status === 'available';
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const currentModel = selectedModel || selectedProvider?.model || '';
  const modelOptions = providers.flatMap((provider) =>
    providerModels(provider).map((model) => ({ provider, model })),
  );
  const pageContextStatus =
    pageContext.status === 'available'
      ? pageContext.title
      : pageContext.status === 'loading'
        ? t('workbench.pageContextLoading')
        : pageContext.status === 'error'
          ? t('workbench.pageContextUnavailable', { message: pageContext.message })
          : t('workbench.restrictedPage');

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [input]);

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

  useEffect(() => {
    if (!openPopover) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenPopover(null);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [openPopover]);

  function updateInput(value: string) {
    onInput(value);
  }

  function runCommand(index: number) {
    const command = commands[index];
    if (!command || busy) return;
    onRunShortcut(command.config);
    setOpenPopover(null);
    if (startsSlashCommand(input)) onInput('');
    textareaRef.current?.focus();
  }

  function openSlashCommands() {
    if (busy) return;
    setOpenPopover('commands');
    setHighlightedCommand(0);
    if (!input.trim()) onInput('/');
    textareaRef.current?.focus();
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

    if (event.key === 'Escape' && openPopover) {
      event.preventDefault();
      setOpenPopover(null);
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !busy && input.trim()) {
      event.preventDefault();
      onSend();
    }
  }

  return (
    <div ref={rootRef} onBlur={handleComposerBlur} className="relative border-t border-neutral-200 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={openSlashCommands}
            aria-label={t('chat.openSlashCommands')}
            title={t('chat.openSlashCommands')}
            aria-haspopup="menu"
            aria-expanded={openPopover === 'commands'}
            aria-controls={openPopover === 'commands' ? 'workbench-slash-commands' : undefined}
            className="inline-flex items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            /
          </button>
          <button
            type="button"
            disabled={!pageIsAvailable}
            aria-pressed={pageIsAvailable ? pageAttached : undefined}
            aria-label={`${t('workbench.pageContext')}: ${pageContextStatus}`}
            title={pageContextStatus}
            onClick={onTogglePageAttached}
            className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <span className="min-w-0 truncate">
              {pageContextStatus}
            </span>
            {pageIsAvailable && <span className="shrink-0 text-neutral-400">{pageAttached ? t('workbench.pageContextAttached') : t('workbench.pageContextDetached')}</span>}
          </button>

          {providers.length > 0 && (
            <div>
              <button
                ref={modelTriggerRef}
                type="button"
                onClick={() => setOpenPopover((open) => (open === 'models' ? null : 'models'))}
                onKeyDown={handleModelTriggerKeyDown}
                aria-label={t('chat.selectProviderModelAriaLabel')}
                aria-haspopup="menu"
                aria-expanded={openPopover === 'models'}
                aria-controls={openPopover === 'models' ? 'workbench-model-menu' : undefined}
                className="inline-flex max-w-[60vw] items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
              >
                {selectedProvider && <span className="shrink-0 text-neutral-400 dark:text-neutral-500">{selectedProvider.name}</span>}
                <span className="truncate font-medium text-neutral-700 dark:text-neutral-200">{currentModel || t('chat.noModelSelected')}</span>
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
        </div>

        <div className="relative flex items-end gap-2 rounded-2xl border border-neutral-300 bg-white p-2 shadow-sm transition-colors focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/30 dark:border-neutral-700 dark:bg-neutral-900">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => updateInput(event.target.value)}
            onKeyDown={handleTextareaKeyDown}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            rows={1}
            aria-label={t('chat.composerAriaLabel')}
            aria-haspopup="menu"
            aria-expanded={openPopover === 'commands'}
            aria-controls={openPopover === 'commands' ? 'workbench-slash-commands' : undefined}
            aria-activedescendant={openPopover === 'commands' && commands.length ? `workbench-command-${commands[highlightedCommand]?.config.id}` : undefined}
            placeholder={t('workbench.composerPlaceholder')}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100 dark:placeholder:text-neutral-600"
          />
          {busy ? (
            <button type="button" onClick={onStop} aria-label={t('chat.stopGenerating')} title={t('chat.stopGenerating')} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-neutral-700 dark:hover:bg-neutral-600">
              <IconStop className="h-5 w-5" />
            </button>
          ) : (
            <button type="button" onClick={onSend} disabled={!canSend} aria-label={t('chat.sendMessage')} title={t('chat.sendMessage')} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-600">
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
                  disabled={busy}
                  aria-disabled={busy}
                  onClick={() => runCommand(index)}
                  className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${index === highlightedCommand ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
                >
                  {resolved.name}
                </button>
              ))}
              {commands.length === 0 && <div role="status" aria-live="polite" className="px-3 py-2 text-sm text-neutral-500">{t('chat.noMatchingSlashCommands')}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
