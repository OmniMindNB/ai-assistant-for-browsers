import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import OptionsApp from '@/entrypoints/options/App';
import GeneralSettings from './GeneralSettings';
import ProviderSettings from './ProviderSettings';
import ShortcutSettings from './ShortcutSettings';

const preferencesMocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));

let storageData: Record<string, unknown>;
let providerStorageListener:
  | ((changes: Record<string, { newValue?: unknown }>, areaName: string) => void)
  | undefined;

vi.mock('@/lib/workbench/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workbench/preferences')>();
  return {
    ...actual,
    loadWorkbenchPreferences: preferencesMocks.load,
    saveWorkbenchPreferences: preferencesMocks.save,
  };
});

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
    preferencesMocks.load.mockResolvedValue({ defaultMode: 'ask', attachPageByDefault: true });
    preferencesMocks.save.mockResolvedValue(undefined);
    storageData = {
      'aluminum:settings': {
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
      'aluminum:shortcuts': [
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

  it('navigates between grouped settings sections', async () => {
    const user = userEvent.setup();
    renderWithLocale(<OptionsApp />);

    await user.click(screen.getByRole('button', { name: 'Model providers' }));

    expect(screen.getByRole('heading', { name: 'Model providers' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Model providers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps preference controls disabled until the initial preferences load', async () => {
    const loading = deferred<{ defaultMode: 'ask' | 'agent'; attachPageByDefault: boolean }>();
    preferencesMocks.load.mockReturnValue(loading.promise);
    renderWithLocale(<GeneralSettings />);

    expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    loading.resolve({ defaultMode: 'agent', attachPageByDefault: false });

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked());
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).not.toBeChecked();
  });

  it('locks the preference draft while saving and reports success for the saved value', async () => {
    const user = userEvent.setup();
    const saving = deferred<void>();
    preferencesMocks.save.mockReturnValue(saving.promise);
    renderWithLocale(<GeneralSettings />);

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: 'Agent tasks' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Ask questions' }));
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked();

    saving.resolve();

    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked();
  });

  it('restores controls and preserves the draft after a save failure', async () => {
    const user = userEvent.setup();
    const saving = deferred<void>();
    preferencesMocks.save.mockReturnValue(saving.promise);
    renderWithLocale(<GeneralSettings />);

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: 'Agent tasks' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeDisabled();

    saving.reject(new Error('storage failed'));

    expect(await screen.findByRole('alert')).toHaveTextContent('storage failed');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Attach current page by default' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked();
  });

  it('shows providers as compact cards before opening an editor', async () => {
    renderWithLocale(<ProviderSettings />);

    expect(await screen.findByRole('list', { name: 'Configured providers' })).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Provider editor' })).not.toBeInTheDocument();
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

    const add = screen.getByRole('button', { name: 'Add provider' });
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

    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    await user.selectOptions(screen.getByLabelText('Quick preset'), 'OpenAI');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save provider');
    expect(screen.getByRole('form', { name: 'Provider editor' })).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('radio', { name: 'Set as active provider: Other' }));

    const persisted = set.mock.calls.at(-1)?.[0]['aluminum:settings'];
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

    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    await user.selectOptions(screen.getByLabelText('Quick preset'), 'OpenAI');
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

    const persisted = set.mock.calls.at(-1)?.[0]['aluminum:settings'];
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
          'aluminum:settings': {
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

    const persisted = set.mock.calls.at(-1)?.[0]['aluminum:shortcuts'];
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
      const persisted = set.mock.calls.at(-1)?.[0]['aluminum:shortcuts'];
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

    const persisted = set.mock.calls.at(-1)?.[0]['aluminum:shortcuts'];
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
});
