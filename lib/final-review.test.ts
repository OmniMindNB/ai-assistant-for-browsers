import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import storeConfig from '../wxt.config';
import { createBrowserTools } from './agent/tools';
import { en } from './i18n/locales/en';
import { zh } from './i18n/locales/zh';

const readRepoFile = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

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

  it('does not describe API keys as never uploaded in active settings copy', () => {
    const englishSettingsCopy = [
      en['settings.descriptionPrefix'],
      en['settings.optionsDescriptionSuffix'],
      en['settings.descriptionSuffix'],
    ].join(' ');
    const chineseSettingsCopy = [
      zh['settings.descriptionPrefix'],
      zh['settings.optionsDescriptionSuffix'],
      zh['settings.descriptionSuffix'],
    ].join(' ');

    expect(englishSettingsCopy).not.toMatch(/never uploaded/i);
    expect(englishSettingsCopy).toContain('sent only to your configured provider when you initiate a request');
    expect(chineseSettingsCopy).not.toContain('不会上传');
    expect(chineseSettingsCopy).toContain('仅在你发起请求时发送到配置的 Provider');
  });
});

describe('maintained privacy disclosure contract', () => {
  const maintainedPrivacyFiles = [
    'docs/privacy-policy.en.md',
    'docs/privacy-policy.md',
    'docs/chrome-store-listing.en.md',
    'docs/chrome-store-listing.zh-CN.md',
    'docs/chrome-store-permission-justifications.md',
    'docs/superpowers/plans/2026-08-02-runi-brand-renaming.md',
  ];
  const unsupportedPersistedConsentClaims =
    /consent state|consent version|acceptance time|first-use consent|current consent record|agree & continue|not now|fails closed|privacy-consent state|asks for current consent|同意状态|同意版本|接受时间|首次使用同意|有效同意记录|同意并继续|暂不继续|关闭方式失败|隐私同意状态/i;

  it('keeps both policy effective dates in parity at the current revision date', () => {
    const englishDate = readRepoFile('docs/privacy-policy.en.md').match(
      /^Effective date: (\d{4}-\d{2}-\d{2})$/m,
    )?.[1];
    const chineseDate = readRepoFile('docs/privacy-policy.md').match(
      /^生效日期：(\d{4}-\d{2}-\d{2})$/m,
    )?.[1];

    expect(englishDate).toBe('2026-08-02');
    expect(chineseDate).toBe('2026-08-02');
    expect(englishDate).toBe(chineseDate);
  });

  it.each(maintainedPrivacyFiles)('%s makes no persisted or gated consent claim', (file) => {
    expect(readRepoFile(file)).not.toMatch(unsupportedPersistedConsentClaims);
  });

  it('describes disclosure, user-directed provider transmission, and per-turn write approval in English', () => {
    const policy = readRepoFile('docs/privacy-policy.en.md');
    expect(policy).toContain('The Settings page provides privacy disclosures');
    expect(policy).toContain('When you initiate an Agent request, you direct Runi to send');
    expect(policy).toContain('Runi does not store a separate consent record.');
    expect(policy).toContain('Before the first write action in a turn');
    expect(policy).toContain('remembered only for the current turn');
  });

  it('describes disclosure, user-directed provider transmission, and per-turn write approval in Simplified Chinese', () => {
    const policy = readRepoFile('docs/privacy-policy.md');
    expect(policy).toContain('设置页会提供隐私说明');
    expect(policy).toContain('当你发起 Agent 请求时，即表示你指示 Runi');
    expect(policy).toContain('Runi 不会另行保存同意记录。');
    expect(policy).toContain('每轮第一次写操作执行前');
    expect(policy).toContain('仅在当前一轮内沿用');
  });

  it('keeps store and Task 6 copy aligned with the current request-driven behavior', () => {
    expect(readRepoFile('docs/chrome-store-listing.en.md')).toContain(
      'When you initiate an Agent request',
    );
    expect(readRepoFile('docs/chrome-store-listing.zh-CN.md')).toContain(
      '当你发起 Agent 请求时',
    );
    expect(readRepoFile('docs/chrome-store-permission-justifications.md')).not.toMatch(
      /consent|同意/i,
    );

    const task6 = readRepoFile('docs/superpowers/plans/2026-08-02-runi-brand-renaming.md');
    expect(task6).toContain('Confirm the Settings privacy disclosure accurately explains');
    expect(task6).toContain('does not store a separate consent record');
  });
});

describe('maintained release capability contract', () => {
  const maintainedCapabilityFiles = [
    'docs/privacy-policy.en.md',
    'docs/privacy-policy.md',
    'docs/chrome-store-listing.en.md',
    'docs/chrome-store-listing.zh-CN.md',
    'docs/chrome-store-permission-justifications.md',
    'docs/chrome-store-submission-guide.md',
    'docs/agent-plan.md',
    'docs/technical-plan.md',
    'demo/README.md',
    'demo/outreach-message.md',
    'demo/store-assets-frame.html',
    'demo/trust-demo.html',
  ];
  const removedPageRestorationPattern = new RegExp(
    [
      ['un', 'do'].join(''),
      ['re', 'vert'].join(''),
      ['snap', 'shot'].join(''),
      ['撤', '销'].join(''),
      ['快', '照'].join(''),
    ].join('|'),
    'i',
  );
  const perChangeConfirmationPattern = new RegExp(
    [
      'before every page change',
      'asks before every change',
      'every page change asks',
      ['逐', '项'].join(''),
    ].join('|'),
    'i',
  );

  it.each(maintainedCapabilityFiles)('%s makes no removed page-restoration claim', (file) => {
    expect(readRepoFile(file)).not.toMatch(removedPageRestorationPattern);
  });

  it.each([
    'README.en.md',
    'README.md',
    'demo/README.md',
    'demo/outreach-message.md',
    'demo/store-assets-frame.html',
  ])('%s makes no per-change confirmation claim', (file) => {
    expect(readRepoFile(file)).not.toMatch(perChangeConfirmationPattern);
  });

  it('aligns English maintained marketing with provider transmission and per-turn approval', () => {
    for (const file of ['README.en.md', 'demo/README.md']) {
      const source = readRepoFile(file);
      expect(source).toContain('recent conversation context');
      expect(source).toContain('configured provider');
      expect(source).toContain('first write action in a turn');
      expect(source).toContain('only for that turn');
    }
  });

  it('aligns Chinese maintained marketing with provider transmission and per-turn approval', () => {
    for (const file of ['README.md', 'demo/outreach-message.md']) {
      const source = readRepoFile(file);
      expect(source).toContain('近期对话上下文');
      expect(source).toContain('配置的 AI Provider');
      expect(source).toContain('每轮第一次写操作');
      expect(source).toContain('仅在该轮内复用');
    }
  });

  it('names the provider-transmission screenshot consistently across release surfaces', () => {
    expect(readRepoFile('docs/chrome-store-submission-guide.md')).toContain(
      'screenshot-04-provider.png',
    );
    expect(readRepoFile('demo/store-assets-frame.html')).toContain('04-provider.png');
    expect(readRepoFile('docs/chrome-store-listing.en.md')).toContain(
      'Your provider, your choice',
    );
    expect(readRepoFile('docs/chrome-store-listing.zh-CN.md')).toContain(
      '由你选择 Provider',
    );
  });

  it('describes only structured page writes and tab-to-conversation session state', () => {
    const permissions = readRepoFile('docs/chrome-store-permission-justifications.md');
    expect(permissions).toContain('packaged page-reading and structured page-write functions');
    expect(permissions).toContain('temporary tab-to-conversation state in chrome.storage.session');
    expect(permissions).toContain('随扩展打包的页面读取与结构化写入函数');
    expect(permissions).toContain('临时的标签页与对话对应状态');

    expect(readRepoFile('docs/privacy-policy.en.md')).toContain(
      'temporary tab-to-conversation state',
    );
    expect(readRepoFile('docs/privacy-policy.md')).toContain('临时的标签页与对话对应状态');
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
    expect(source).toContain("pageContext.status === 'error'");
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
