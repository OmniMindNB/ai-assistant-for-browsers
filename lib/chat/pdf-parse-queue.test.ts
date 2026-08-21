import { describe, expect, it, vi } from 'vitest';
import { PdfParseQueue } from './pdf-parse-queue';

describe('PdfParseQueue', () => {
  it('runs jobs FIFO with at most the configured concurrency', async () => {
    const queue = new PdfParseQueue(2);
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const jobs = ['a', 'b', 'c'].map((id) => queue.enqueue(id, () => {
      started.push(id);
      return new Promise<string>((resolve) => releases.push(() => resolve('done')));
    }));

    expect(started).toEqual(['a', 'b']);
    expect(queue.activeCount).toBe(2);
    releases[0]();
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    expect(queue.activeCount).toBe(2);
    releases[1]();
    releases[2]();
    await expect(Promise.all(jobs)).resolves.toEqual(['done', 'done', 'done']);
    expect(queue.activeCount).toBe(0);
  });

  it('cancels queued work without starting it', async () => {
    const queue = new PdfParseQueue(1);
    let resolveFirst: () => void = () => undefined;
    const first = queue.enqueue('a', () => new Promise<string>((resolve) => { resolveFirst = () => resolve('a'); }));
    const neverRun = vi.fn().mockResolvedValue('b');
    const second = queue.enqueue('b', neverRun);

    queue.cancel('b');
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(neverRun).not.toHaveBeenCalled();
    resolveFirst();
    await expect(first).resolves.toBe('a');
  });

  it('aborts active work and rejects it with AbortError', async () => {
    const queue = new PdfParseQueue(1);
    let signal!: AbortSignal;
    const first = queue.enqueue('a', (jobSignal) => {
      signal = jobSignal;
      return new Promise<never>((_resolve, reject) => jobSignal.addEventListener('abort', () => reject(jobSignal.reason)));
    });

    queue.cancel('a');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal.aborted).toBe(true);
    expect(queue.activeCount).toBe(0);
  });

  it('rejects duplicate live IDs and permits reuse after settlement', async () => {
    const queue = new PdfParseQueue(1);
    let finish!: () => void;
    const first = queue.enqueue('same', () => new Promise<string>((resolve) => { finish = () => resolve('first'); }));
    await expect(queue.enqueue('same', async () => 'duplicate')).rejects.toThrow('Duplicate PDF task: same');
    finish();
    await expect(first).resolves.toBe('first');
    await expect(queue.enqueue('same', async () => 'second')).resolves.toBe('second');
  });

  it('cancelAll rejects pending and active jobs and leaves bookkeeping empty', async () => {
    const queue = new PdfParseQueue(2);
    const signals: AbortSignal[] = [];
    const run = (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    };
    const jobs = [queue.enqueue('a', run), queue.enqueue('b', run), queue.enqueue('c', run)];

    queue.cancelAll();
    await expect(Promise.allSettled(jobs)).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) }),
    ]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(queue.activeCount).toBe(0);
  });

  it('settles a synchronously throwing job without an unhandled rejection', async () => {
    const queue = new PdfParseQueue(1);
    const rejection = queue.enqueue('bad', () => { throw new Error('parse failed'); });
    await expect(rejection).rejects.toThrow('parse failed');
    expect(queue.activeCount).toBe(0);
  });
});
