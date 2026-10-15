// Учёт денег с резервированием. Резерв выдаётся до вызова модели по оценке,
// после вызова закрывается фактической стоимостью. Параллельные вызовы не могут
// превысить лимит: все операции идут через один мьютекс.
// AWS Budgets остаётся вторым, запаздывающим контуром — ограничитель здесь.

import type { Store } from '../store/store.ts';
import { BudgetExceeded } from '../core/errors.ts';
import { Mutex, dayKey, monthKey, newId, round, type Clock } from '../core/util.ts';

export type SpendCategory = 'llm' | 'premium' | 'image';

export interface BudgetPolicy {
  limits: {
    initiativeUsd: number;
    dailyUsd: number;
    monthlyUsd: number;
    imagePerInitiativeUsd: number;
    premiumMonthlyUsd: number;
    autonomousMonthlyShare: number;
  };
  thresholds: number[];
  process: {
    maxLlmCallsPerInitiative: number;
    maxVariants: number;
    maxCritiqueRounds: number;
    maxRefineIterations: number;
    maxPositions: number;
    parallelism: number;
  };
}

export interface LedgerEntry {
  id: string;
  initiativeId: string;
  category: SpendCategory;
  autonomous: boolean;
  amount: number;
  status: 'reserved' | 'settled' | 'released';
  ts: number;
  day: string;
  model?: string;
  role?: string;
}

interface LedgerState {
  month: string;
  entries: LedgerEntry[];
  alerted: string[];
}

export type BudgetLevel = 'normal' | 'restricted' | 'critical' | 'stopped';

export interface BudgetAlert {
  scope: 'day' | 'month';
  threshold: number;
  ratio: number;
  spentUsd: number;
  limitUsd: number;
}

export interface ReserveRequest {
  initiativeId: string;
  category: SpendCategory;
  amountUsd: number;
  autonomous: boolean;
  model?: string;
  role?: string;
}

export class BudgetLedger {
  private store: Store;
  private clock: Clock;
  private mutex = new Mutex();
  policy: BudgetPolicy;

  constructor(store: Store, policy: BudgetPolicy, clock: Clock) {
    this.store = store;
    this.policy = policy;
    this.clock = clock;
  }

  private async load(): Promise<LedgerState> {
    const month = monthKey(this.clock.now());
    const state = await this.store.get<LedgerState>('ledger', month);
    return state ?? { month, entries: [], alerted: [] };
  }

  private async save(state: LedgerState): Promise<void> {
    await this.store.put('ledger', state.month, state);
  }

  private static sum(entries: LedgerEntry[]): number {
    return entries.filter((e) => e.status !== 'released').reduce((acc, e) => acc + e.amount, 0);
  }

  async reserve(req: ReserveRequest): Promise<LedgerEntry> {
    return this.mutex.run(async () => {
      const state = await this.load();
      const now = this.clock.now();
      const today = dayKey(now);
      const live = state.entries.filter((e) => e.status !== 'released');
      const { limits, process } = this.policy;
      const amount = Math.max(0, req.amountUsd);

      const checks: Array<[string, number, number]> = [
        ['initiative', BudgetLedger.sum(live.filter((e) => e.initiativeId === req.initiativeId)), limits.initiativeUsd],
        ['day', BudgetLedger.sum(live.filter((e) => e.day === today)), limits.dailyUsd],
        ['month', BudgetLedger.sum(live), limits.monthlyUsd],
      ];
      if (req.category === 'image') {
        checks.push(['image', BudgetLedger.sum(live.filter((e) => e.initiativeId === req.initiativeId && e.category === 'image')), limits.imagePerInitiativeUsd]);
      }
      if (req.category === 'premium') {
        checks.push(['premium', BudgetLedger.sum(live.filter((e) => e.category === 'premium')), limits.premiumMonthlyUsd]);
      }
      if (req.autonomous) {
        checks.push(['autonomous', BudgetLedger.sum(live.filter((e) => e.autonomous)), limits.monthlyUsd * limits.autonomousMonthlyShare]);
      }
      for (const [scope, used, limit] of checks) {
        if (used + amount > limit + 1e-9) {
          throw new BudgetExceeded(scope, `Лимит «${scope}» исчерпан: $${round(used, 3)} из $${limit}, нужно ещё $${round(amount, 3)}`, { used, limit, amount });
        }
      }
      if (req.category !== 'image') {
        const calls = live.filter((e) => e.initiativeId === req.initiativeId && e.category !== 'image').length;
        if (calls >= process.maxLlmCallsPerInitiative) {
          throw new BudgetExceeded('calls', `Достигнут лимит вызовов моделей на инициативу (${process.maxLlmCallsPerInitiative})`, { calls });
        }
      }

      const entry: LedgerEntry = {
        id: newId('res', now),
        initiativeId: req.initiativeId,
        category: req.category,
        autonomous: req.autonomous,
        amount,
        status: 'reserved',
        ts: now,
        day: today,
        model: req.model,
        role: req.role,
      };
      state.entries.push(entry);
      await this.save(state);
      return entry;
    });
  }

  /** Закрыть резерв фактической стоимостью. Возвращает новые пересечённые пороги. */
  async settle(reservationId: string, actualUsd: number): Promise<BudgetAlert[]> {
    return this.mutex.run(async () => {
      const state = await this.load();
      const entry = state.entries.find((e) => e.id === reservationId);
      if (!entry) return [];
      entry.amount = Math.max(0, actualUsd);
      entry.status = 'settled';
      const alerts = this.collectAlerts(state);
      await this.save(state);
      return alerts;
    });
  }

  async release(reservationId: string): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.load();
      const entry = state.entries.find((e) => e.id === reservationId);
      if (entry && entry.status === 'reserved') {
        entry.status = 'released';
        await this.save(state);
      }
    });
  }

  private collectAlerts(state: LedgerState): BudgetAlert[] {
    const now = this.clock.now();
    const today = dayKey(now);
    const live = state.entries.filter((e) => e.status !== 'released');
    const scopes: Array<['day' | 'month', number, number, string]> = [
      ['day', BudgetLedger.sum(live.filter((e) => e.day === today)), this.policy.limits.dailyUsd, today],
      ['month', BudgetLedger.sum(live), this.policy.limits.monthlyUsd, state.month],
    ];
    const alerts: BudgetAlert[] = [];
    for (const [scope, spent, limit, key] of scopes) {
      const ratio = limit > 0 ? spent / limit : 1;
      for (const threshold of this.policy.thresholds) {
        const mark = `${scope}:${key}:${threshold}`;
        if (ratio >= threshold && !state.alerted.includes(mark)) {
          state.alerted.push(mark);
          alerts.push({ scope, threshold, ratio: round(ratio, 3), spentUsd: round(spent, 4), limitUsd: limit });
        }
      }
    }
    return alerts;
  }

  async level(): Promise<BudgetLevel> {
    const s = await this.summary();
    const ratio = Math.max(s.day.ratio, s.month.ratio);
    if (ratio >= 1) return 'stopped';
    if (ratio >= 0.95) return 'critical';
    if (ratio >= 0.8) return 'restricted';
    return 'normal';
  }

  async summary(initiativeId?: string): Promise<{
    day: { spentUsd: number; limitUsd: number; ratio: number };
    month: { spentUsd: number; limitUsd: number; ratio: number };
    initiative?: { spentUsd: number; limitUsd: number; calls: number };
    byModel: Record<string, number>;
    byRole: Record<string, number>;
  }> {
    const state = await this.load();
    const today = dayKey(this.clock.now());
    const live = state.entries.filter((e) => e.status !== 'released');
    const day = BudgetLedger.sum(live.filter((e) => e.day === today));
    const month = BudgetLedger.sum(live);
    const byModel: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    for (const e of live) {
      if (e.model) byModel[e.model] = round((byModel[e.model] ?? 0) + e.amount, 4);
      if (e.role) byRole[e.role] = round((byRole[e.role] ?? 0) + e.amount, 4);
    }
    const result: Awaited<ReturnType<BudgetLedger['summary']>> = {
      day: { spentUsd: round(day, 4), limitUsd: this.policy.limits.dailyUsd, ratio: round(day / this.policy.limits.dailyUsd, 3) },
      month: { spentUsd: round(month, 4), limitUsd: this.policy.limits.monthlyUsd, ratio: round(month / this.policy.limits.monthlyUsd, 3) },
      byModel,
      byRole,
    };
    if (initiativeId) {
      const mine = live.filter((e) => e.initiativeId === initiativeId);
      result.initiative = {
        spentUsd: round(BudgetLedger.sum(mine), 4),
        limitUsd: this.policy.limits.initiativeUsd,
        calls: mine.filter((e) => e.category !== 'image').length,
      };
    }
    return result;
  }
}
