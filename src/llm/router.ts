// Маршрутизатор моделей. Агент объявляет класс задачи и схему ответа; модель
// выбирается здесь: дешёвая и проверенная — первой, с fallback, circuit breaker,
// правилом независимости критика, резервом бюджета и одной попыткой ремонта JSON.

import type { Store } from '../store/store.ts';
import type { BudgetLedger, BudgetAlert, SpendCategory } from '../budget/ledger.ts';
import { BudgetExceeded, ModelChainExhausted, ProviderError } from '../core/errors.ts';
import { extractJson } from '../core/json.ts';
import { validate, type Schema } from '../core/schema.ts';
import { round, sleep, type Clock } from '../core/util.ts';
import type { ImagePart, LlmProvider, ModelEntry, ModelRegistryConfig, TaskClass } from './types.ts';

export interface CompleteRequest {
  taskClass: TaskClass;
  initiativeId: string;
  role: string;
  autonomous: boolean;
  system: string;
  user: string;
  images?: ImagePart[];
  schema: Schema;
  maxTokens: number;
  temperature?: number;
  /** Семейство модели автора — критик по возможности берётся из другого семейства. */
  avoidFamily?: string;
  /** Причина вызова premium-модели (обязательна для arbiter). */
  reason?: string;
  /** Дополнительная проверка сверх схемы (например, токены Screen Spec). */
  check?: (value: unknown) => string[];
}

export interface CallAttempt {
  model: string;
  outcome: 'ok' | 'invalid_json' | 'provider_error' | 'skipped';
  error?: string;
  costUsd?: number;
}

export interface CompleteResult<T> {
  value: T;
  model: string;
  family: string;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number };
  attempts: CallAttempt[];
  raw: string;
}

type EvalScores = Partial<Record<TaskClass, Record<string, number>>>;

export class ModelRouter {
  private config: ModelRegistryConfig;
  private provider: LlmProvider;
  private ledger: BudgetLedger;
  private store: Store;
  private clock: Clock;
  private evals: EvalScores;
  private failures = new Map<string, number>();
  private openUntil = new Map<string, number>();
  onBudgetAlert: (alerts: BudgetAlert[]) => Promise<void> = async () => {};

  constructor(opts: { config: ModelRegistryConfig; provider: LlmProvider; ledger: BudgetLedger; store: Store; clock: Clock; evals?: EvalScores }) {
    this.config = opts.config;
    this.provider = opts.provider;
    this.ledger = opts.ledger;
    this.store = opts.store;
    this.clock = opts.clock;
    this.evals = opts.evals ?? {};
  }

  model(key: string): ModelEntry | undefined {
    return this.config.models.find((m) => m.key === key);
  }

  /** Кандидаты в порядке попыток с причинами отсева (для журнала и отладки). */
  candidates(req: Pick<CompleteRequest, 'taskClass' | 'images' | 'system' | 'user' | 'avoidFamily'>): { usable: ModelEntry[]; skipped: Array<{ key: string; reason: string }> } {
    const keys = this.config.assignments[req.taskClass] ?? [];
    const skipped: Array<{ key: string; reason: string }> = [];
    const needsImages = (req.images?.length ?? 0) > 0;
    const inputTokens = estimateTokens(req.system + req.user) + (req.images?.length ?? 0) * 1600;
    const now = this.clock.now();
    let usable: ModelEntry[] = [];
    for (const key of keys) {
      const m = this.model(key);
      if (!m) { skipped.push({ key, reason: 'нет в реестре' }); continue; }
      if (!m.enabled) { skipped.push({ key, reason: 'отключена' }); continue; }
      if (!m.price || m.price.inputPer1M === undefined || m.price.outputPer1M === undefined) { skipped.push({ key, reason: 'цена не подтверждена' }); continue; }
      if (needsImages && !m.input.includes('image')) { skipped.push({ key, reason: 'не принимает изображения' }); continue; }
      if (m.contextTokens && inputTokens > m.contextTokens * 0.9) { skipped.push({ key, reason: 'контекст мал' }); continue; }
      if ((this.openUntil.get(key) ?? 0) > now) { skipped.push({ key, reason: 'circuit breaker открыт' }); continue; }
      usable.push(m);
    }
    if (req.avoidFamily) {
      const independent = usable.filter((m) => m.family !== req.avoidFamily);
      if (independent.length > 0) {
        for (const m of usable) if (m.family === req.avoidFamily) skipped.push({ key: m.key, reason: 'то же семейство, что у автора' });
        usable = independent;
      }
    }
    const scores = this.evals[req.taskClass];
    const threshold = this.config.evalThresholds[req.taskClass];
    if (scores && threshold !== undefined) {
      // Модели, измеренно не дотянувшие до порога, — только последним резервом.
      const passed = usable.filter((m) => (scores[m.key] ?? 1) >= threshold);
      const failed = usable.filter((m) => (scores[m.key] ?? 1) < threshold);
      usable = [...passed, ...failed];
    }
    return { usable, skipped };
  }

  async complete<T>(req: CompleteRequest): Promise<CompleteResult<T>> {
    if (req.taskClass === 'arbiter' && !req.reason) throw new Error('Вызов premium-арбитра требует причину');
    const { usable, skipped } = this.candidates(req);
    const attempts: CallAttempt[] = skipped.map((s) => ({ model: s.key, outcome: 'skipped' as const, error: s.reason }));
    const maxCalls = this.config.retry.maxAttemptsPerCall;
    let calls = 0;
    const category: SpendCategory = req.taskClass === 'arbiter' ? 'premium' : 'llm';

    for (const model of usable) {
      let retried = false;
      let repair: { previous: string; errors: string[] } | undefined;
      while (calls < maxCalls) {
        calls++;
        const estimate = this.estimateCost(model, req);
        // BudgetExceeded пробрасывается наверх: дальше пробовать бессмысленно.
        const reservation = await this.ledger.reserve({
          initiativeId: req.initiativeId,
          category,
          amountUsd: estimate,
          autonomous: req.autonomous,
          model: model.key,
          role: req.role,
        });
        let raw = '';
        try {
          const res = await this.provider.chat({
            model,
            region: model.region ?? this.config.region,
            system: req.system,
            user: req.user,
            images: req.images,
            maxTokens: Math.min(req.maxTokens, model.maxOutputTokens ?? req.maxTokens),
            temperature: req.temperature,
            repair,
          });
          raw = res.text;
          const cost = this.actualCost(model, res.usage);
          const alerts = await this.ledger.settle(reservation.id, cost);
          if (alerts.length) await this.onBudgetAlert(alerts);
          this.failures.set(model.key, 0);
          await this.log(req, model, 'ok', cost, res.usage, res.latencyMs);

          let parsed: unknown;
          let errors: string[];
          try {
            parsed = extractJson(raw);
            errors = validate(req.schema, parsed);
            if (errors.length === 0 && req.check) errors = req.check(parsed);
          } catch (err) {
            errors = [(err as Error).message];
          }
          if (errors.length === 0) {
            attempts.push({ model: model.key, outcome: 'ok', costUsd: cost });
            return { value: parsed as T, model: model.key, family: model.family, costUsd: cost, usage: res.usage, attempts, raw };
          }
          attempts.push({ model: model.key, outcome: 'invalid_json', error: errors.slice(0, 3).join('; '), costUsd: cost });
          if (repair) break; // ремонт уже был — следующая модель
          repair = { previous: raw, errors };
          continue;
        } catch (err) {
          if (err instanceof BudgetExceeded) throw err;
          await this.ledger.release(reservation.id);
          const pe = err instanceof ProviderError ? err : new ProviderError('retryable', 0, (err as Error).message);
          attempts.push({ model: model.key, outcome: 'provider_error', error: pe.message.slice(0, 200) });
          await this.log(req, model, `error:${pe.kind}`, 0, undefined, undefined, pe.message);
          this.registerFailure(model.key, pe.kind);
          if (pe.kind === 'retryable' && !retried) {
            retried = true;
            await sleep(this.config.retry.retryDelayMs);
            continue;
          }
          break;
        }
      }
      if (calls >= maxCalls) break;
    }
    throw new ModelChainExhausted(req.taskClass, attempts.map((a) => ({ model: a.model, error: a.error ?? a.outcome, outcome: a.outcome })));
  }

  private registerFailure(key: string, kind: ProviderError['kind']): void {
    if (kind === 'unavailable' || kind === 'auth') {
      // Модель не включена в аккаунте или ключ не подходит — ждать бессмысленно.
      this.openUntil.set(key, this.clock.now() + this.config.breaker.cooldownMs * 6);
      return;
    }
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    if (n >= this.config.breaker.failures) {
      this.openUntil.set(key, this.clock.now() + this.config.breaker.cooldownMs);
      this.failures.set(key, 0);
    }
  }

  estimateCost(model: ModelEntry, req: Pick<CompleteRequest, 'system' | 'user' | 'images' | 'maxTokens'>): number {
    const p = model.price!;
    const input = estimateTokens(req.system + req.user) + (req.images?.length ?? 0) * 1600;
    const output = Math.min(req.maxTokens, model.maxOutputTokens ?? req.maxTokens);
    return round((input * (p.inputPer1M ?? 0) + output * (p.outputPer1M ?? 0)) / 1e6, 6);
  }

  actualCost(model: ModelEntry, usage: { inputTokens: number; outputTokens: number }): number {
    const p = model.price!;
    return round((usage.inputTokens * (p.inputPer1M ?? 0) + usage.outputTokens * (p.outputPer1M ?? 0)) / 1e6, 6);
  }

  private async log(req: CompleteRequest, model: ModelEntry, outcome: string, costUsd: number, usage?: { inputTokens: number; outputTokens: number }, latencyMs?: number, error?: string): Promise<void> {
    await this.store.append('calls', {
      ts: this.clock.now(),
      initiativeId: req.initiativeId,
      role: req.role,
      taskClass: req.taskClass,
      model: model.key,
      outcome,
      costUsd,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      latencyMs,
      reason: req.reason,
      error: error?.slice(0, 300),
    });
  }
}

/** Грубая оценка токенов: ~3.2 символа на токен для смеси кириллицы и JSON. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}
