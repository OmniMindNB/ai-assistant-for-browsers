import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTextFile } from './download-file';

describe('downloadTextFile', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('clicks a temporary download anchor and revokes the object url afterwards', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });

    downloadTextFile('runi-a.md', '# hi');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('runi-a.md');
    expect(clicked[0].href).toBe('blob:x');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});
