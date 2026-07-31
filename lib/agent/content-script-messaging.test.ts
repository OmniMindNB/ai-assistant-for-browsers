import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/messaging';
import { sendToContentScript } from './content-script-messaging';

const sendMessage = vi.fn();
const executeScript = vi.fn();

(globalThis as any).browser = {
  tabs: { sendMessage },
  scripting: { executeScript },
};

const MESSAGE: Message = { id: 'm1', type: 'GET_SELECTION' };

describe('sendToContentScript', () => {
  beforeEach(() => {
    sendMessage.mockReset();
    executeScript.mockReset();
  });

  it('returns the response directly when the content script is already listening', async () => {
    sendMessage.mockResolvedValueOnce({ id: 'm1', ok: true, data: { text: 'hi' } });

    const result = await sendToContentScript(7, MESSAGE);

    expect(result).toEqual({ id: 'm1', ok: true, data: { text: 'hi' } });
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('injects the content script and retries once when no receiver exists yet', async () => {
    sendMessage
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValueOnce({ id: 'm1', ok: true, data: { text: 'hi' } });
    executeScript.mockResolvedValueOnce([{}]);

    const result = await sendToContentScript(7, MESSAGE);

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['/content-scripts/content.js'],
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 'm1', ok: true, data: { text: 'hi' } });
  });

  it('rethrows unrelated errors without attempting injection', async () => {
    sendMessage.mockRejectedValueOnce(new Error('some other failure'));

    await expect(sendToContentScript(7, MESSAGE)).rejects.toThrow('some other failure');
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('surfaces a clear error when injection itself fails (e.g. a restricted page)', async () => {
    sendMessage.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'));
    executeScript.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));

    await expect(sendToContentScript(7, MESSAGE)).rejects.toThrow('Cannot access a chrome:// URL');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
