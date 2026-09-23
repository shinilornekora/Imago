/**
 * Ограничитель параллелизма с приоритетом (режим F: фиксированный параллелизм чтений страниц,
 * активная страница — первой). Задачи помечены ключом (pageId): `prioritize(key)` поднимает
 * все ожидающие задачи с этим ключом в начало очереди. Дедупликации нет — она делается в адаптере.
 */
export interface Limiter {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  prioritize(key: string): void;
  /** Отклонить все ожидающие задачи (AbortError); выполняющиеся дорабатывают. */
  clear(): void;
  readonly pending: number;
  readonly running: number;
}

interface Queued {
  key: string;
  start: () => Promise<void>;
  cancel: () => void;
}

export function createLimiter(concurrency: number): Limiter {
  const queue: Queued[] = [];
  let running = 0;

  const pump = (): void => {
    while (running < concurrency && queue.length > 0) {
      const item = queue.shift() as Queued;
      running += 1;
      void item.start().finally(() => {
        running -= 1;
        pump();
      });
    }
  };

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          key,
          start: () => task().then(resolve, reject),
          cancel: () => reject(new DOMException('limiter cleared', 'AbortError')),
        });
        pump();
      });
    },
    prioritize(key) {
      const mine = queue.filter((q) => q.key === key);
      if (mine.length === 0) return;
      const rest = queue.filter((q) => q.key !== key);
      queue.length = 0;
      queue.push(...mine, ...rest);
    },
    clear() {
      const items = queue.splice(0, queue.length);
      for (const q of items) q.cancel();
    },
    get pending() {
      return queue.length;
    },
    get running() {
      return running;
    },
  };
}
