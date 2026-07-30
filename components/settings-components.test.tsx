import { render, screen, waitFor } from '@testing-library/react';
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
    (globalThis as any).browser.storage.onChanged = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    };
    (globalThis as any).browser.storage.local = {
      get: vi.fn(async (key: string) => ({
        'aluminum:settings': {
          activeProviderId: 'deepseek',
          providers: [
            {
              id: 'deepseek',
              name: 'DeepSeek',
              baseURL: 'https://api.deepseek.com',
              apiKey: 'secret-key',
              model: 'deepseek-v4-pro',
              models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
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
      })),
      set: vi.fn(async () => {}),
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
});
