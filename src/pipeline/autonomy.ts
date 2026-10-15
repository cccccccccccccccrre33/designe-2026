// Самостоятельная работа студии: когда днём очередь пустая, директор студии сам
// выбирает следующую задачу к цели и ставит её в работу. Ограничители — в коде, а не
// в промпте: одна такая задача одновременно (следующая — после решения владельца),
// лимит в день, только при нормальном бюджете, /pause и /auto off владельца.

import { BudgetExceeded, ModelChainExhausted } from '../core/errors.ts';
import { truncate, type Clock } from '../core/util.ts';
import type { BudgetLedger } from '../budget/ledger.ts';
import type { Store } from '../store/store.ts';
import type { Outbox } from './outbox.ts';
import type { Studio } from './studio.ts';

export interface AutonomyPolicy {
  enabled: boolean;
  maxPerDay: number;
}

export interface AutonomyDeps {
  studio: Studio;
  store: Store;
  ledger: BudgetLedger;
  outbox: Outbox;
  clock: Clock;
  schedule(initiativeId: string): void;
}

export type AutonomyResult =
  | { started: { id: string; title: string; why: string } }
  | { skipped: string };

interface DayCounter {
  started: number;
  proposals: number;
}

/** Попробовать взять задачу самостоятельно. day — дата по часовому поясу студии. */
export async function autonomousTick(d: AutonomyDeps, policy: AutonomyPolicy, day: string): Promise<AutonomyResult> {
  if (!policy.enabled) return { skipped: 'выключено в schedule.json' };
  const control = await d.store.get<{ enabled: boolean }>('control', 'autonomy');
  if (control && !control.enabled) return { skipped: 'выключено владельцем (/auto off)' };
  if ((await d.ledger.level()) !== 'normal') return { skipped: 'бюджет не на нормальном уровне' };
  const open = (await d.studio.list()).filter((i) => i.source === 'autonomous' && ['running', 'awaiting_owner', 'paused'].includes(i.status));
  if (open.length) return { skipped: `своя задача уже открыта: «${open[0].title}»` };
  const counter = (await d.store.get<DayCounter>('autonomy', day)) ?? { started: 0, proposals: 0 };
  // Отказы модели тоже стоят денег: предложений не больше, чем вдвое против лимита задач.
  if (counter.started >= policy.maxPerDay || counter.proposals >= policy.maxPerDay * 2) return { skipped: `лимит на ${day}` };
  counter.proposals++;
  await d.store.put('autonomy', day, counter);

  let plan;
  try {
    plan = await d.studio.proposeAutonomous(day);
  } catch (err) {
    if (err instanceof BudgetExceeded || err instanceof ModelChainExhausted) return { skipped: truncate((err as Error).message, 160) };
    throw err;
  }
  if (plan.skip) return { skipped: `директор студии: ${plan.reason ?? 'нет стоящей задачи'}` };

  const { initiative, duplicate } = await d.studio.intake(plan.request, 'autonomous');
  if (duplicate) return { skipped: `уже в работе: «${initiative.title}»` };
  if (initiative.status === 'declined') return { skipped: 'триаж: не задача студии' };
  counter.started++;
  await d.store.put('autonomy', day, counter);
  initiative.history.push({ ts: d.clock.now(), event: 'autonomy', detail: truncate(plan.why, 300) });
  await d.store.put('initiatives', initiative.id, initiative);
  await d.outbox.enqueue(`tg:text:autonomy:${initiative.id}`, 'owner.text', {
    text: `💡 Студия взяла задачу сама: «${initiative.title}».\nПочему сейчас: ${truncate(plan.why, 300)}\nСтаршие проверят результат до показа — пришлю готовое. Не брать задачи самим — /auto off.`,
  });
  await d.outbox.flush();
  d.schedule(initiative.id);
  return { started: { id: initiative.id, title: initiative.title, why: plan.why } };
}
