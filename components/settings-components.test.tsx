import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import OptionsApp from '@/entrypoints/options/App';
import ProviderSettings from './ProviderSettings';
import RedactionSettings from './RedactionSettings';
import ShortcutSettings from './ShortcutSettings';
import SettingsShell, {
  type SettingsSectionDescriptor,
  type SettingsSectionGroup,
} from './SettingsShell';

let storageData: Record<string, unknown>;
let providerStorageListener:
  | ((changes: Record<string, { newValue?: unknown }>, areaName: string) => void)
  | undefined;

function renderWithLocale(node: React.ReactNode) {
  return render(<LocaleProvider>{node}</LocaleProvider>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('grouped options settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageData = {
      'runi:settings': {
        activeProviderId: 'deepseek',
        providers: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            baseURL: 'https://api.deepseek.com',
            apiKey: 'key-a',
            model: 'deepseek-v4-pro',
            models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
          },
          {
            id: 'other',
            name: 'Other',
            baseURL: 'https://example.test/v1',
            apiKey: 'key-b',
            model: 'other-model',
          },
        ],
      },
      'runi:shortcuts': [
        {
          id: 'builtin:explain-selection',
          origin: 'builtin',
          scope: 'selection',
          customized: false,
        },
        {
          id: 'builtin:summarize-page',
          origin: 'builtin',
          scope: 'page',
          customized: false,
        },
      ],
    };
    providerStorageListener = undefined;
    (globalThis as any).browser.storage.onChanged = {
      addListener: vi.fn((listener) => {
        providerStorageListener = listener;
      }),
      removeListener: vi.fn(),
    };
    (globalThis as any).browser.storage.local = {
      get: vi.fn(async () => storageData),
      set: vi.fn(async (next: Record<string, unknown>) => {
        Object.assign(storageData, next);
      }),
    };
    (globalThis as any).browser.runtime.getManifest = vi.fn(() => ({ version: '1.1.0' }));
    window.matchMedia = vi.fn().mockReturnValue({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matches: false,
    });
  });

  it('defaults to the Model providers section and highlights it in the nav', async () => {
    renderWithLocale(<OptionsApp />);

    expect(screen.getByRole('button', { name: 'Model providers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByRole('list', { name: 'Configured providers' })).toBeVisible();
  });

  it('navigates between grouped settings sections without re-rendering the nav label as a heading', async () => {
    const user = userEvent.setup();
    renderWithLocale(<OptionsApp />);

    await user.click(screen.getByRole('button', { name: 'Privacy & permissions' }));

    expect(screen.getByRole('button', { name: 'Privacy & permissions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Page data is sent to your AI provider')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Configured providers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Privacy & permissions' })).not.toBeInTheDocument();
  });

  it('lists nav items in the specified order', async () => {
    renderWithLocale(<OptionsApp />);

    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const labels = within(nav).getAllByRole('button').map((button) => button.textContent);

    expect(labels).toEqual([
      'Model providers',
      'Appearance',
      'Language',
      'Shortcuts',
      'Privacy & permissions',
      'About · v1.1.0',
    ]);
  });

  it('shows the About footer item with the current version and opens the About panel', async () => {
    const user = userEvent.setup();
    renderWithLocale(<OptionsApp />);

    const aboutButton = screen.getByRole('button', { name: 'About · v1.1.0' });
    expect(aboutButton).toBeVisible();

    await user.click(aboutButton);

    expect(aboutButton).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Version 1.1.0')).toBeVisible();
  });

  it('shows providers as compact cards before opening an editor', async () => {
    renderWithLocale(<ProviderSettings />);

    expect(await screen.findByRole('list', { name: 'Configured providers' })).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Provider editor' })).not.toBeInTheDocument();
  });

  it('keeps provider actions gated while initial settings are loading and permits retry after a read error', async () => {
    const loading = deferred<Record<string, unknown>>();
    (globalThis as any).browser.storage.local.get.mockReturnValueOnce(loading.promise);
    renderWithLocale(<ProviderSettings />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByRole('button', { name: 'Add provider' })).not.toBeInTheDocument();
    loading.reject(new Error('read rejected'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Add provider' })).toBeVisible();
  });

  it('opens the existing editor without losing Provider values', async () => {
    const user = userEvent.setup();
    renderWithLocale(<ProviderSettings />);

    await user.click(await screen.findByRole('button', { name: 'Edit DeepSeek' }));

    expect(screen.getByRole('form', { name: 'Provider editor' })).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('DeepSeek');
  });

  it('resets API key reveal state when switching provider editors', async () => {
    const user = userEvent.setup();
    renderWithLocale(<ProviderSettings />);

    await user.click(await screen.findByRole('button', { name: 'Edit DeepSeek' }));
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Edit Other' }));
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
  });

  it('isolates API key reveal state when an existing editor opens a new Provider session', async () => {
    const user = userEvent.setup();
    renderWithLocale(<ProviderSettings />);

    await user.click(await screen.findByRole('button', { name: 'Edit DeepSeek' }));
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByRole('list', { name: 'Configured providers' })).not.toHaveTextContent('key-a');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add provider' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
  });

  it('does not render an API key in the Provider landing cards', async () => {
    renderWithLocale(<ProviderSettings />);

    expect(await screen.findByRole('list', { name: 'Configured providers' })).not.toHaveTextContent(
      'key-a',
    );
  });

  it('cancels a new Provider editor and restores focus to Add provider', async () => {
    const user = userEvent.setup();
    renderWithLocale(<ProviderSettings />);

    const add = await screen.findByRole('button', { name: 'Add provider' });
    await user.click(add);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('form', { name: 'Provider editor' })).not.toBeInTheDocument();
    expect(add).toHaveFocus();
  });

  it('keeps failed Provider saves out of the landing state and later writes', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    set.mockRejectedValueOnce(new Error('write rejected'));
    renderWithLocale(<ProviderSettings />);

    await user.click(await screen.findByRole('button', { name: 'Add provider' }));
    await user.selectOptions(screen.getByLabelText('Quick preset'), 'OpenAI');
    await user.type(screen.getByLabelText('API Key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save provider');
    expect(screen.getByRole('form', { name: 'Provider editor' })).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('radio', { name: 'Set as active provider: Other' }));

    const persisted = set.mock.calls.at(-1)?.[0]['runi:settings'];
    expect(persisted.providers).toHaveLength(2);
    expect(persisted.activeProviderId).toBe('other');
  });

  it('keeps the persisted Provider card and edit draft after an edit save rejects', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ProviderSettings />);

    await user.click(await screen.findByRole('button', { name: 'Edit Other' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Unsaved Provider');
    set.mockRejectedValueOnce(new Error('write rejected'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save provider');
    expect(screen.getByRole('list', { name: 'Configured providers' })).toHaveTextContent('Other');
    expect(screen.getByRole('list', { name: 'Configured providers' })).not.toHaveTextContent(
      'Unsaved Provider',
    );
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved Provider');
  });

  it('persists Provider add, edit, default selection, and deletion', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ProviderSettings />);

    await user.click(await screen.findByRole('button', { name: 'Add provider' }));
    await user.selectOptions(screen.getByLabelText('Quick preset'), 'OpenAI');
    await user.type(screen.getByLabelText('API Key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Edit Other' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Renamed')).toBeVisible();

    await user.click(screen.getByRole('radio', { name: 'Set as active provider: Renamed' }));
    await user.click(screen.getByRole('button', { name: 'Delete Renamed' }));
    await user.click(screen.getByRole('button', { name: 'Delete Renamed' }));

    const persisted = set.mock.calls.at(-1)?.[0]['runi:settings'];
    expect(persisted.activeProviderId).toBe('deepseek');
    expect(persisted.providers.map((item: { name: string }) => item.name)).not.toContain('Renamed');
  });

  it('does not optimistically change active or delete a Provider after storage rejects', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ProviderSettings />);

    set.mockRejectedValueOnce(new Error('write rejected'));
    await user.click(await screen.findByRole('radio', { name: 'Set as active provider: Other' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save provider');
    expect(screen.getByRole('radio', { name: 'Set as active provider: DeepSeek' })).toBeChecked();

    set.mockRejectedValueOnce(new Error('write rejected'));
    await user.click(screen.getByRole('button', { name: 'Delete Other' }));
    await user.click(screen.getByRole('button', { name: 'Delete Other' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save provider');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('refreshes the Provider cards from a storage change', async () => {
    renderWithLocale(<ProviderSettings />);
    await screen.findByText('DeepSeek');

    act(() => {
      providerStorageListener?.(
        {
          'runi:settings': {
            newValue: {
              activeProviderId: 'remote',
              providers: [
                {
                  id: 'remote',
                  name: 'Remote provider',
                  baseURL: 'https://remote.test/v1',
                  apiKey: '',
                  model: 'remote-model',
                },
              ],
            },
          },
        },
        'local',
      );
    });

    expect(screen.getByText('Remote provider')).toBeVisible();
    expect(screen.queryByText('DeepSeek')).not.toBeInTheDocument();
  });

  it('shows slash labels and keeps keyboard reorder actions', async () => {
    renderWithLocale(<ShortcutSettings />);

    expect(await screen.findByText('/Summarizepage')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move Summarize page up' })).toBeEnabled();
  });

  it('opens one shortcut editor at a time', async () => {
    const user = userEvent.setup();
    renderWithLocale(<ShortcutSettings />);

    await user.click(await screen.findByRole('button', { name: 'Edit Summarize page' }));

    expect(screen.getAllByRole('form')).toHaveLength(1);
  });

  it('persists keyboard shortcut reordering', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ShortcutSettings />);

    await user.click(await screen.findByRole('button', { name: 'Move Summarize page up' }));

    const persisted = set.mock.calls.at(-1)?.[0]['runi:shortcuts'];
    expect(persisted.map((item: { id: string }) => item.id)).toEqual([
      'builtin:summarize-page',
      'builtin:explain-selection',
    ]);
  });

  it('persists drag shortcut reordering without removing keyboard controls', async () => {
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ShortcutSettings />);
    const summarize = (await screen.findByText('Summarize page')).closest('li')!;
    const explain = screen.getByText('Explain selection').closest('li')!;
    const dataTransfer = { effectAllowed: '', setData: vi.fn() };

    fireEvent.dragStart(summarize, { dataTransfer });
    fireEvent.drop(explain, { dataTransfer });

    await waitFor(() => {
      const persisted = set.mock.calls.at(-1)?.[0]['runi:shortcuts'];
      expect(persisted.map((item: { id: string }) => item.id)).toEqual([
        'builtin:summarize-page',
        'builtin:explain-selection',
      ]);
    });
    expect(screen.getByRole('button', { name: 'Move Summarize page down' })).toBeEnabled();
  });

  it('confirms shortcut deletion before persisting it', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithLocale(<ShortcutSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete Summarize page' }));

    const persisted = set.mock.calls.at(-1)?.[0]['runi:shortcuts'];
    expect(persisted.map((item: { id: string }) => item.id)).toEqual([
      'builtin:explain-selection',
    ]);
  });

  it('does not persist shortcut deletion when confirmation is declined', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithLocale(<ShortcutSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete Summarize page' }));

    expect(set).not.toHaveBeenCalled();
    expect(screen.getByText('Summarize page')).toBeVisible();
  });

  it('defaults the selection-ask toggle to checked and persists a change', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ShortcutSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable selection-ask bubble' });
    expect(toggle).toBeChecked();

    await user.click(toggle);

    expect(set).toHaveBeenCalledWith({ 'runi:selection-ask-enabled': false });
  });

  it('reflects a previously saved disabled state for the selection-ask toggle', async () => {
    storageData['runi:selection-ask-enabled'] = false;
    renderWithLocale(<ShortcutSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable selection-ask bubble' });
    expect(toggle).not.toBeChecked();
  });

  it('reverts the selection-ask toggle and shows an error when persisting it fails', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<ShortcutSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable selection-ask bubble' });
    expect(toggle).toBeChecked();

    set.mockRejectedValueOnce(new Error('write rejected'));
    await user.click(toggle);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save shortcuts.');
    expect(toggle).toBeChecked();
  });

  it('loads default redaction settings enabled with all four built-in rules', async () => {
    renderWithLocale(<RedactionSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    expect(toggle).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '手机号' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '邮箱' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '身份证号' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '银行卡号' })).toBeChecked();
  });

  it('persists toggling the master switch off', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<RedactionSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    await user.click(toggle);

    expect(toggle).not.toBeChecked();
    const persisted = set.mock.calls.at(-1)?.[0]['runi:redaction'];
    expect(persisted.enabled).toBe(false);
  });

  it('persists disabling a single built-in rule', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<RedactionSettings />);

    const phoneToggle = await screen.findByRole('checkbox', { name: '手机号' });
    await user.click(phoneToggle);

    expect(phoneToggle).not.toBeChecked();
    const persisted = set.mock.calls.at(-1)?.[0]['runi:redaction'];
    expect(persisted.rules.find((rule: { id: string }) => rule.id === 'phone').enabled).toBe(false);
  });

  it('reverts the toggle and shows an error when persisting fails', async () => {
    const user = userEvent.setup();
    const set = (globalThis as any).browser.storage.local.set as ReturnType<typeof vi.fn>;
    renderWithLocale(<RedactionSettings />);

    const toggle = await screen.findByRole('checkbox', { name: 'Enable page content redaction' });
    expect(toggle).toBeChecked();

    set.mockRejectedValueOnce(new Error('write rejected'));
    await user.click(toggle);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save redaction settings.');
    expect(toggle).toBeChecked();
  });

  it('refreshes from a live storage change', async () => {
    renderWithLocale(<RedactionSettings />);
    await screen.findByRole('checkbox', { name: 'Enable page content redaction' });

    act(() => {
      providerStorageListener?.(
        {
          'runi:redaction': {
            newValue: {
              enabled: false,
              rules: [{ id: 'phone', label: '手机号', pattern: '1[3-9]\\d{9}', enabled: true, builtin: true }],
            },
          },
        },
        'local',
      );
    });

    expect(screen.getByRole('checkbox', { name: 'Enable page content redaction' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: '邮箱' })).not.toBeInTheDocument();
  });
});

describe('SettingsShell', () => {
  function DummyIcon({ className }: { className?: string }) {
    return <svg data-testid="dummy-icon" className={className} />;
  }

  const groupA: SettingsSectionGroup = {
    label: 'Group A',
    sections: [
      { id: 'providers', label: 'Providers', icon: DummyIcon },
      { id: 'appearance', label: 'Appearance', icon: DummyIcon },
    ],
  };
  const groupB: SettingsSectionGroup = {
    label: 'Group B',
    sections: [{ id: 'privacy', label: 'Privacy', icon: DummyIcon }],
  };
  const footer: SettingsSectionDescriptor[] = [{ id: 'about', label: 'About', icon: DummyIcon }];

  it('exposes group boundaries to assistive tech without visible group titles', () => {
    render(
      <SettingsShell
        groups={[groupA, groupB]}
        activeSection="providers"
        onSelect={() => {}}
        navigationLabel="Settings"
      >
        content
      </SettingsShell>,
    );

    expect(screen.getByRole('group', { name: 'Group A' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Group B' })).toBeVisible();
    expect(screen.queryByText('Group A')).not.toBeInTheDocument();
    expect(screen.queryByText('Group B')).not.toBeInTheDocument();
  });

  it('renders every nav button with an icon', () => {
    render(
      <SettingsShell
        groups={[groupA]}
        footerSections={footer}
        activeSection="providers"
        onSelect={() => {}}
        navigationLabel="Settings"
      >
        content
      </SettingsShell>,
    );

    expect(screen.getAllByTestId('dummy-icon')).toHaveLength(3);
  });

  it('renders a divider between groups and before the footer, none for a single group with no footer', () => {
    const { container, rerender } = render(
      <SettingsShell groups={[groupA]} activeSection="providers" onSelect={() => {}} navigationLabel="Settings">
        content
      </SettingsShell>,
    );
    expect(container.querySelectorAll('hr')).toHaveLength(0);

    rerender(
      <SettingsShell
        groups={[groupA, groupB]}
        footerSections={footer}
        activeSection="providers"
        onSelect={() => {}}
        navigationLabel="Settings"
      >
        content
      </SettingsShell>,
    );
    expect(container.querySelectorAll('hr')).toHaveLength(2);
  });

  it('reaches the footer section via arrow-key navigation', () => {
    const handleSelect = vi.fn();
    render(
      <SettingsShell
        groups={[groupA, groupB]}
        footerSections={footer}
        activeSection="privacy"
        onSelect={handleSelect}
        navigationLabel="Settings"
      >
        content
      </SettingsShell>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Privacy' }), { key: 'ArrowDown' });
    expect(handleSelect).toHaveBeenCalledWith('about');
  });

  it('omits the footer entirely when footerSections is not provided', () => {
    render(
      <SettingsShell groups={[groupA]} activeSection="providers" onSelect={() => {}} navigationLabel="Settings">
        content
      </SettingsShell>,
    );
    expect(screen.queryByRole('button', { name: 'About' })).not.toBeInTheDocument();
  });
});
