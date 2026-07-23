import { describe, expect, it, vi } from 'vitest';
import { sendMessage } from './messaging';

describe('sendMessage', () => {
  it('includes tabId in the posted message when provided', async () => {
    const sendSpy = vi.fn().mockResolvedValue({ id: 'x', ok: true, data: {} });
    (globalThis as any).browser = { runtime: { sendMessage: sendSpy } };

    await sendMessage('GET_HTML', { selector: 'body' }, 42);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const posted = sendSpy.mock.calls[0][0];
    expect(posted.type).toBe('GET_HTML');
    expect(posted.payload).toEqual({ selector: 'body' });
    expect(posted.tabId).toBe(42);
  });

  it('omits tabId when not provided', async () => {
    const sendSpy = vi.fn().mockResolvedValue({ id: 'x', ok: true, data: {} });
    (globalThis as any).browser = { runtime: { sendMessage: sendSpy } };

    await sendMessage('PING');

    const posted = sendSpy.mock.calls[0][0];
    expect(posted.tabId).toBeUndefined();
  });
});
