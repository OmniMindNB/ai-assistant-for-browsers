import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import storeConfig from '../wxt.config';
import { createBrowserTools } from './agent/tools';
import { en } from './i18n/locales/en';
import { zh } from './i18n/locales/zh';

describe('Chrome Web Store release surface', () => {
  it('does not request userScripts or expose AI-generated script execution', () => {
    const manifest = storeConfig.manifest as { permissions?: string[] };
    expect(manifest.permissions).not.toContain('userScripts');
    expect(createBrowserTools(7).map((tool) => tool.name)).not.toContain('browser_inject_script');
  });
});

describe('privacy settings translations', () => {
  it('distinguishes local storage from provider transmission in English', () => {
    expect(en['privacy.localDataTitle']).toBe('Stored locally in your browser');
    expect(en['privacy.localDataBody']).toContain(
      'Provider settings, API keys, and conversation history are stored locally in your browser.',
    );
    expect(en['privacy.pageDataBody']).toContain(
      'your API key, current prompt, recent conversation context, and relevant page-derived results are sent directly to your configured AI provider endpoint',
    );
    expect(en['privacy.noBackendBody']).toContain('no developer-operated backend or analytics');
  });

  it('distinguishes local storage from provider transmission in Simplified Chinese', () => {
    expect(zh['privacy.localDataTitle']).toBe('保存在浏览器本地');
    expect(zh['privacy.localDataBody']).toContain('Provider 设置、API Key 和对话历史保存在浏览器本地');
    expect(zh['privacy.pageDataBody']).toContain(
      'API Key、当前提示词、近期对话上下文和相关页面结果会直接发送到你配置的 AI Provider 端点',
    );
    expect(zh['privacy.noBackendBody']).toContain('不运营开发者后端，也不收集分析数据');
  });
});

describe('side-panel custom shortcut wiring', () => {
  const storeSource = fs.readFileSync(
    path.resolve(process.cwd(), 'entrypoints/sidepanel/store.ts'),
    'utf8',
  );
  const appSource = fs.readFileSync(
    path.resolve(process.cwd(), 'entrypoints/sidepanel/App.tsx'),
    'utf8',
  );

  it('uses one generic shortcut action instead of hard-coded actions', () => {
    expect(storeSource).toContain('runShortcut: async (shortcut) =>');
    expect(storeSource).toContain(
      'buildShortcutExecution(resolved, t, selection?.text)',
    );
    expect(storeSource).not.toContain('summarizePage: async');
    expect(storeSource).not.toContain('explainSelection: async');
  });

  it('passes an empty tool list for isolated scopes', () => {
    expect(storeSource).toContain('tools: options.withoutBrowserTools ? [] : undefined');
    expect(storeSource).toContain('withoutBrowserTools: execution.browserTools ===');
    expect(storeSource).toContain("'none'");
  });

  it('allows ordinary user messages to opt out of browser tools', () => {
    expect(storeSource).toContain(
      'send: async (text, options) =>',
    );
    expect(storeSource).toContain('withoutBrowserTools: options?.withoutBrowserTools');
  });

  it('routes shortcut controls through the generic shortcut action', () => {
    expect(appSource).toContain('refreshShortcuts();');
    expect(appSource).toContain('runShortcut(shortcut);');
    expect(appSource).not.toContain('summarizePage,');
    expect(appSource).not.toContain('explainSelection,');
  });

  it('subscribes to external shortcut storage changes', () => {
    expect(appSource).toContain('SHORTCUTS_STORAGE_KEY');
    expect(appSource).toContain('browser.storage.onChanged.addListener');
    expect(appSource).toContain('browser.storage.onChanged.removeListener');
  });
});

describe('side-panel shortcut rendering', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'entrypoints/sidepanel/components/WorkbenchComposer.tsx'),
    'utf8',
  );

  it('opens slash commands, prevents unmatched queries from sending, and runs a highlighted shortcut', () => {
    expect(source).toContain('filterShortcutCommands(shortcuts, input)');
    expect(source).toContain("if (openPopover === 'commands')");
    expect(source).toContain("aria-expanded={openPopover === 'commands'}");
    expect(source).toContain('if (commands.length > 0) runCommand(highlightedCommand)');
    expect(source).toContain('onRunShortcut(command.config)');
    expect(source).toContain("t('chat.noMatchingSlashCommands')");
    expect(source).toContain("input.trim()");
  });

  it('renders page context status and configured provider models inside the composer', () => {
    expect(source).toContain("pageContext.status === 'restricted'");
    expect(source).toContain("pageContext.status === 'error'");
    expect(source).toContain("t('workbench.restrictedPage')");
    expect(source).toContain('providerModels(provider)');
    expect(source).toContain('onRetryPageContext');
  });

  it('connects slash and model popups to their controls with keyboard focus behavior', () => {
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).toContain("aria-controls={openPopover === 'commands' ? 'workbench-slash-commands' : undefined}");
    expect(source).toContain("aria-expanded={openPopover === 'models'}");
    expect(source).toContain("aria-controls={openPopover === 'models' ? 'workbench-model-menu' : undefined}");
    expect(source).toContain('id="workbench-model-menu"');
    expect(source).toContain('handleModelTriggerKeyDown');
    expect(source).toContain('handleModelItemKeyDown');
    expect(source).toContain('handleComposerBlur');
    expect(source).toContain('modelItemRefs.current[nextIndex]?.focus()');
  });

  it('truncates long shortcut names while preserving the full accessible name and title', () => {
    expect(source).toContain('className={`block w-full truncate');
    expect(source).toContain('title={resolved.name}');
    expect(source).toContain('aria-label={resolved.name}');
  });
});

describe('shortcut settings wiring', () => {
  const read = (file: string) => {
    const absolute = path.resolve(process.cwd(), file);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
  };
  const componentSource = read('components/ShortcutSettings.tsx');
  const optionsSource = read('entrypoints/options/App.tsx');
  const sidepanelSource = read('entrypoints/sidepanel/App.tsx');

  it('provides reusable CRUD, restore, drag, and keyboard reorder controls', () => {
    expect(componentSource).toContain('updateShortcutConfigs');
    expect(componentSource).toContain('restoreDefaultShortcuts');
    expect(componentSource).toContain('moveShortcut');
    expect(componentSource).toContain('draggable');
    expect(componentSource).toContain("move(item.id, 'up')");
    expect(componentSource).toContain("move(item.id, 'down')");
  });

  it('keeps shortcut settings on the dedicated options page', () => {
    expect(optionsSource).toContain('<ShortcutSettings />');
    expect(optionsSource).toContain("'shortcuts'");
    expect(sidepanelSource).not.toContain('<ShortcutSettings />');
  });

  it('locates required-field errors and focuses the first invalid field', () => {
    expect(componentSource).toContain('const [fieldErrors, setFieldErrors]');
    expect(componentSource).toContain('nameInputRef.current?.focus()');
    expect(componentSource).toContain('promptInputRef.current?.focus()');
    expect(componentSource).toContain('aria-invalid={Boolean(fieldErrors.name)}');
    expect(componentSource).toContain(
      "aria-describedby={fieldErrors.name ? 'shortcut-name-error' : undefined}",
    );
    expect(componentSource).toContain('aria-invalid={Boolean(fieldErrors.prompt)}');
    expect(componentSource).toContain(
      "aria-describedby={fieldErrors.prompt ? 'shortcut-prompt-error' : undefined}",
    );
  });

  it('keeps malformed-config diagnostics out of both localized interfaces', () => {
    expect(componentSource).not.toContain('...result.errors');
    expect(componentSource).not.toContain('setErrors(details)');
    expect(componentSource).toContain('console.error');
    expect(zh['shortcut.invalidConfig']).toBe('快捷方式配置无效。');
    expect(en['shortcut.invalidConfig']).toBe('The shortcut configuration is invalid.');
  });

  it('offers a confirmed bilingual repair action without rendering raw invalid records', () => {
    expect(componentSource).toContain('repairShortcutConfigs');
    expect(componentSource).toContain(
      "if (!window.confirm(t('shortcut.confirmRepairInvalid'))) return;",
    );
    expect(componentSource).toContain('const next = await repairShortcutConfigs();');
    expect(componentSource).toContain("{t('shortcut.repairInvalid')}");
    expect(componentSource).toContain("setFlash(t('shortcut.repaired'))");
    expect(zh['shortcut.repairInvalid']).toBe('删除无效项');
    expect(zh['shortcut.confirmRepairInvalid']).toBe(
      '删除无效的快捷方式并保留有效项？此操作无法撤销。',
    );
    expect(en['shortcut.repairInvalid']).toBe('Remove invalid items');
    expect(en['shortcut.confirmRepairInvalid']).toBe(
      'Remove invalid shortcuts and keep valid ones? This cannot be undone.',
    );
  });

  it('provides localized field-level guidance in both languages', () => {
    expect(zh['shortcut.nameRequired']).toBe('请输入快捷方式名称');
    expect(zh['shortcut.promptRequired']).toBe('请输入提示词');
    expect(en['shortcut.nameRequired']).toBe('Enter a shortcut name');
    expect(en['shortcut.promptRequired']).toBe('Enter a prompt');
  });
});
