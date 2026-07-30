import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import OptionsApp from '@/entrypoints/options/App';
import GeneralSettings from './GeneralSettings';

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

describe('grouped options settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preferencesMocks.load.mockResolvedValue({ defaultMode: 'ask', attachPageByDefault: true });
    preferencesMocks.save.mockResolvedValue(undefined);
    (globalThis as any).browser.storage.onChanged = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
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

  it('saves workbench defaults and preserves input on failure', async () => {
    const user = userEvent.setup();
    preferencesMocks.save.mockRejectedValue(new Error('storage failed'));
    renderWithLocale(<GeneralSettings />);

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ask questions' })).toBeChecked());
    await user.click(screen.getByRole('radio', { name: 'Agent tasks' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('storage failed');
    expect(screen.getByRole('radio', { name: 'Agent tasks' })).toBeChecked();
  });
});
