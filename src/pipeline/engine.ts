// Устойчивое выполнение шагов (ADR-0003). Результат шага записывается до перехода
// к следующему; повторный запуск после сбоя пропускает выполненные шаги и не платит
// за них второй раз. В облаке те же шаги — состояния Step Functions.

import type { Store } from '../store/store.ts';
import type { Clock } from '../core/util.ts';

interface StepRecord<T> {
  key: string;
  status: 'done';
  result: T;
  finishedAt: number;
  durationMs: number;
}

export class StepJournal {
  private store: Store;
  private clock: Clock;
  private runId: string;
  /** Для тестов сбоев: бросить ошибку перед выполнением шага с этим ключом. */
  crashBefore: string | null = null;

  constructor(store: Store, clock: Clock, runId: string) {
    this.store = store;
    this.clock = clock;
    this.runId = runId;
  }

  private id(key: string): string {
    return `${this.runId}__${key}`;
  }

  async has(key: string): Promise<boolean> {
    return Boolean(await this.store.get(`steps`, this.id(key)));
  }

  async step<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const done = await this.store.get<StepRecord<T>>('steps', this.id(key));
    if (done) return done.result;
    if (this.crashBefore === key) {
      this.crashBefore = null;
      throw new Error(`Имитация сбоя перед шагом ${key}`);
    }
    const started = this.clock.now();
    const result = await fn();
    await this.store.put<StepRecord<T>>('steps', this.id(key), {
      key,
      status: 'done',
      result,
      finishedAt: this.clock.now(),
      durationMs: this.clock.now() - started,
    });
    return result;
  }
}
