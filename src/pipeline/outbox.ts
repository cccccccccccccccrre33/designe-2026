// Outbox: побочные эффекты (Telegram, GitHub) записываются как задания с ключом
// идемпотентности и доставляются отдельно. Сбой сети не теряет сообщение, а
// перезапуск конвейера не дублирует его.

import type { Store } from '../store/store.ts';
import { Mutex, type Clock } from '../core/util.ts';

export interface OutboxItem {
  key: string;
  kind: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  result?: unknown;
  createdAt: number;
}

export type OutboxHandler = (item: OutboxItem) => Promise<unknown>;

export class Outbox {
  private store: Store;
  private clock: Clock;
  private handlers = new Map<string, OutboxHandler>();
  private mutex = new Mutex();
  private lastCreated = 0;
  maxAttempts = 8;

  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  on(kind: string, handler: OutboxHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Повторная постановка с тем же ключом ничего не меняет. */
  async enqueue(key: string, kind: string, payload: Record<string, unknown>): Promise<OutboxItem> {
    const existing = await this.store.get<OutboxItem>('outbox', key);
    if (existing) return existing;
    // Строго возрастающее время постановки: порядок доставки = порядок постановки
    // (публикация в GitHub раньше карточки, которая ссылается на PR).
    const createdAt = Math.max(this.clock.now(), this.lastCreated + 1);
    this.lastCreated = createdAt;
    const item: OutboxItem = { key, kind, payload, status: 'pending', attempts: 0, nextAttemptAt: 0, createdAt };
    await this.store.put('outbox', key, item);
    return item;
  }

  async get(key: string): Promise<OutboxItem | undefined> {
    return this.store.get<OutboxItem>('outbox', key);
  }

  /** Доставить всё, что пора доставлять. Возвращает число успешно доставленных. */
  async flush(): Promise<{ delivered: number; pending: number; failed: number }> {
    return this.mutex.run(async () => {
      const items = (await this.store.list<OutboxItem>('outbox')).filter((i) => i.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
      let delivered = 0;
      const now = this.clock.now();
      for (const item of items) {
        if (item.nextAttemptAt > now) continue;
        const handler = this.handlers.get(item.kind);
        if (!handler) continue;
        try {
          item.result = await handler(item);
          item.status = 'done';
          delivered++;
        } catch (err) {
          item.attempts += 1;
          item.lastError = (err as Error).message.slice(0, 300);
          // Экспоненциальная пауза: 5 с, 10 с, 20 с … до 10 минут.
          item.nextAttemptAt = now + Math.min(600_000, 5_000 * 2 ** (item.attempts - 1));
          if (item.attempts >= this.maxAttempts) item.status = 'failed';
        }
        await this.store.put('outbox', item.key, item);
      }
      const all = await this.store.list<OutboxItem>('outbox');
      return { delivered, pending: all.filter((i) => i.status === 'pending').length, failed: all.filter((i) => i.status === 'failed').length };
    });
  }
}
