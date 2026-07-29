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

describe('privacy consent translations', () => {
  it('distinguishes local storage from provider transmission in English', () => {
    expect(en['privacy.localDataTitle']).toBe('Stored locally in your browser');
    expect(en['privacy.localDataBody']).toContain(
      'Provider settings, API keys, consent state, and conversation history are stored locally in your browser.',
    );
    expect(en['privacy.pageDataBody']).toContain(
      'your API key, current prompt, recent conversation context, and relevant page-derived results are sent directly to your configured AI provider endpoint',
    );
    expect(en['privacy.noBackendBody']).toContain('no developer-operated backend or analytics');
  });

  it('distinguishes local storage from provider transmission in Simplified Chinese', () => {
    expect(zh['privacy.localDataTitle']).toBe('保存在浏览器本地');
    expect(zh['privacy.localDataBody']).toContain('Provider 设置、API Key、同意状态和对话历史保存在浏览器本地');
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

  it('keeps ordinary user messages unchanged', () => {
    expect(storeSource).toContain(
      "await runAgent(set, get, makeMessage('user', content, 'input'), content);",
    );
  });

  it('routes the existing built-in controls through the generic shortcut action', () => {
    expect(appSource).toContain(
      'shortcuts.find((shortcut) => shortcut.id === BUILTIN_SUMMARIZE_ID)',
    );
    expect(appSource).toContain(
      'shortcuts.find((shortcut) => shortcut.id === BUILTIN_EXPLAIN_ID)',
    );
    expect(appSource).toContain('refreshShortcuts();');
    expect(appSource).toContain('runShortcut(shortcut);');
    expect(appSource).not.toContain('summarizePage,');
    expect(appSource).not.toContain('explainSelection,');
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

  it('uses the shortcut settings in both settings surfaces', () => {
    expect(optionsSource).toContain('<ShortcutSettings />');
    expect(optionsSource).toContain("'shortcuts'");
    expect(sidepanelSource).toContain('<ShortcutSettings />');
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
    expect(componentSource).toContain('console.error');
    expect(zh['shortcut.invalidConfig']).toBe('快捷方式配置无效。');
    expect(en['shortcut.invalidConfig']).toBe('The shortcut configuration is invalid.');
  });

  it('provides localized field-level guidance in both languages', () => {
    expect(zh['shortcut.nameRequired']).toBe('请输入快捷方式名称');
    expect(zh['shortcut.promptRequired']).toBe('请输入提示词');
    expect(en['shortcut.nameRequired']).toBe('Enter a shortcut name');
    expect(en['shortcut.promptRequired']).toBe('Enter a prompt');
  });
});
