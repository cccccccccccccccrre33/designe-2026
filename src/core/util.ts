import { createHash, randomBytes } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Короткий сортируемый по времени ID: префикс + base36 времени + случайный хвост. */
export function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}-${now.toString(36)}${randomBytes(3).toString('hex')}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/** Простой мьютекс: операции ledger и outbox выполняются строго по очереди. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Ограниченная параллельность для пачки задач (позиции, критики). После первой
 * ошибки новые задачи не берутся (например, бюджет исчерпан), уже начатые
 * дожидаются, затем ошибка пробрасывается.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && failure === null) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (failure === null) failure = err;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== null) throw failure;
  return results;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
