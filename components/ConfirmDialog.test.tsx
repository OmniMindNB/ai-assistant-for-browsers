import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/lib/i18n';
import ConfirmDialog from './ConfirmDialog';

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const props = {
    open: true,
    title: 'Restore preset shortcuts?',
    description: 'This cannot be undone.',
    confirmLabel: 'Restore presets',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  } satisfies React.ComponentProps<typeof ConfirmDialog>;
  render(
    <LocaleProvider>
      <ConfirmDialog {...props} />
    </LocaleProvider>,
  );
  return props;
}

describe('ConfirmDialog', () => {
  it('renders nothing while closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('labels and describes the dialog with its own copy', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Restore preset shortcuts?');
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
  });

  // 破坏性操作：打开时焦点落在「取消」上，直接回车不会触发确认按钮。
  it('puts the initial focus on cancel, not on the destructive action', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('confirms when the confirm button is pressed', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Restore presets' }));

    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.keyboard('{Escape}');

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels when the backdrop is pressed', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByTestId('confirm-dialog-backdrop'));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a press inside the panel from cancelling', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByText('This cannot be undone.'));

    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Restore presets' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Restore presets' })).toHaveFocus();
  });

  it('disables both actions while the confirmed work is running', () => {
    renderDialog({ busy: true });

    expect(screen.getByRole('button', { name: 'Restore presets' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
