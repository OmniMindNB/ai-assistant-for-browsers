interface QueueJob<T> {
  id: string;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  active: boolean;
}

export class PdfParseQueue {
  private pending: QueueJob<unknown>[] = [];
  private jobs = new Map<string, QueueJob<unknown>>();
  private running = 0;

  constructor(private readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('concurrency must be positive');
    }
  }

  get activeCount(): number {
    return this.running;
  }

  enqueue<T>(id: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.jobs.has(id)) {
      return Promise.reject(new Error(`Duplicate PDF task: ${id}`));
    }

    return new Promise<T>((resolve, reject) => {
      const job: QueueJob<T> = {
        id,
        controller: new AbortController(),
        run,
        resolve,
        reject,
        active: false,
      };
      this.jobs.set(id, job as QueueJob<unknown>);
      this.pending.push(job as QueueJob<unknown>);
      this.pump();
    });
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    if (job.active) {
      job.controller.abort(new DOMException('Aborted', 'AbortError'));
      return;
    }

    this.pending = this.pending.filter((candidate) => candidate !== job);
    this.jobs.delete(id);
    job.reject(new DOMException('Aborted', 'AbortError'));
  }

  cancelAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      job.active = true;
      this.running += 1;

      let result: Promise<unknown>;
      try {
        result = job.run(job.controller.signal);
      } catch (error) {
        result = Promise.reject(error);
      }

      void result
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running -= 1;
          this.jobs.delete(job.id);
          this.pump();
        });
    }
  }
}
