// Сессия студии в GitHub Actions (ADR-0007). Запуск по расписанию днём:
//   1. вне рабочих часов — выход без вызовов моделей;
//   2. продолжить начатое (в том числе остановленное вчера вечером) и задачу из ручного запуска;
//   3. до конца сессии слушать Telegram владельца и вести очередь инициатив;
//   4. каждые несколько минут и в конце — сохранить состояние;
//   5. если очередь пустая — директор студии сам берёт следующую задачу к цели (autonomy);
//   6. перед закрытием новые шаги не начинаются: инициатива встаёт на паузу на границе
//      шага и утром продолжается без повторной оплаты сделанного.

import type { App } from '../app.ts';
import { truncate, type Clock } from '../core/util.ts';
import { autonomousTick } from '../pipeline/autonomy.ts';
import { describeHours, localDate, workWindow, type SchedulePolicy } from './schedule.ts';

export interface SessionOptions {
  app: App;
  schedule: SchedulePolicy;
  clock: Clock;
  /** Максимальная длительность сессии, мс. */
  maxMs: number;
  /** Работать вне рабочих часов — только для ручного запуска с галочкой. */
  force?: boolean;
  /** Сохранение состояния (StateSync.save): периодически и в конце. */
  save?: (reason: string) => Promise<unknown>;
  /** Новая задача из ручного запуска workflow. */
  task?: string;
  /** Для тестов: закончить, когда очередь пуста и новых сообщений нет. */
  exitWhenIdle?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface SessionReport {
  status: 'night' | 'done';
  local: string;
  minutesToOpen: number;
  hours: string;
  stoppedBy: 'deadline' | 'close' | 'idle' | null;
  paused: boolean;
  updates: number;
  resumed: string[];
  task: { id: string; title: string; status: string } | null;
  /** Что студия сделала сама: взятые задачи и причины пропуска. */
  autonomy: string[];
  initiatives: Array<{ id: string; title: string; status: string; version: number; waiting: boolean }>;
  budget: { daySpent: number; dayLimit: number; monthSpent: number; monthLimit: number } | null;
  saves: number;
  errors: string[];
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSession(o: SessionOptions): Promise<SessionReport> {
  const { app, schedule, clock } = o;
  const sleep = o.sleep ?? realSleep;
  const log = o.log ?? (() => undefined);
  const start = clock.now();
  const window = workWindow(start, schedule);
  const report: SessionReport = {
    status: 'done', local: window.local, minutesToOpen: window.minutesToOpen, hours: describeHours(schedule), stoppedBy: null,
    paused: false, updates: 0, resumed: [], task: null, autonomy: [], initiatives: [], budget: null, saves: 0, errors: [],
  };
  if (!window.open && !o.force) {
    report.status = 'night';
    return report;
  }

  const s = schedule.session;
  const closeAt = window.open && !o.force ? start + Math.max(0, window.minutesToClose - s.stopBeforeCloseMinutes) * 60_000 : Number.POSITIVE_INFINITY;
  const deadline = Math.min(start + o.maxMs, closeAt);
  const stopMessage = () => (clock.now() >= closeAt
    ? `Рабочее время студии закончилось (${describeHours(schedule)}) — продолжу с этого шага в рабочие часы`
    : 'Сессия GitHub Actions закончилась — следующая продолжит с этого шага');
  app.studio.stopCheck = () => (clock.now() >= deadline ? stopMessage() : null);
  if (app.bot) {
    app.bot.statusNote = () => {
      const w = workWindow(clock.now(), schedule);
      return `Часы работы: ${describeHours(schedule)}. Сейчас ${w.local} — ${w.open ? 'работаю' : 'нерабочее время'}.`;
    };
  }

  const control = await app.store.get<{ paused: boolean }>('control', 'studio');
  app.queue.paused = Boolean(control?.paused);
  report.paused = app.queue.paused;

  // Продолжить начатое: упавшее посреди шага и остановленное концом рабочего дня.
  if (!app.queue.paused) {
    // Приложение целиком ведёт проект: он сам продолжает свои экраны.
    for (const p of await app.projects.list()) {
      if (p.status === 'running' || (p.status === 'paused' && p.pauseKind === 'schedule')) {
        report.resumed.push(p.id);
        app.queue.schedule(p.id);
      }
    }
    for (const ini of await app.studio.list()) {
      if (ini.projectId) continue;
      if (ini.status === 'running' || (ini.status === 'paused' && ini.pauseKind === 'schedule')) {
        report.resumed.push(ini.id);
        app.queue.schedule(ini.id);
      }
    }
  }

  if (o.task) {
    try {
      const { initiative, duplicate } = await app.studio.intake(o.task, 'owner');
      report.task = { id: initiative.id, title: initiative.title, status: duplicate ? 'duplicate' : initiative.status };
      if (!duplicate && initiative.status !== 'declined') {
        await app.outbox.enqueue(`task:${initiative.id}`, 'owner.text', { text: `Принял задачу из GitHub: «${initiative.title}». Пришлю готовый результат.` });
        app.queue.schedule(initiative.id);
      }
    } catch (err) {
      report.errors.push(`задача из GitHub: ${truncate((err as Error).message, 200)}`);
    }
  }

  let offset = (await app.store.get<{ offset: number }>('tg-state', 'poll'))?.offset ?? 0;
  let lastSave = clock.now();
  const saveEvery = s.saveEveryMinutes * 60_000;
  const save = async (reason: string) => {
    if (!o.save) return;
    try {
      await o.save(reason);
      report.saves++;
    } catch (err) {
      report.errors.push(`сохранение состояния: ${truncate((err as Error).message, 200)}`);
    }
  };

  // Самостоятельная работа: только при Telegram (иначе владелец не увидит результат),
  // не на паузе, после idleMinutes пустой очереди и если до конца сессии хватает времени.
  const auto = schedule.autonomy;
  let idleSince = clock.now();
  const tryAutonomy = async (): Promise<boolean> => {
    if (!auto?.enabled || !app.telegram || app.queue.paused || app.queue.active) return false;
    if (clock.now() - idleSince < auto.idleMinutes * 60_000 || deadline - clock.now() < auto.minMinutesLeft * 60_000) return false;
    idleSince = clock.now(); // одна попытка на период простоя
    try {
      const r = await autonomousTick({ studio: app.studio, projects: app.projects, store: app.store, ledger: app.ledger, outbox: app.outbox, clock, schedule: (id) => app.queue.schedule(id) }, auto, localDate(clock.now(), schedule.timezone));
      const line = 'started' in r ? `взята задача «${r.started.title}»` : `пропуск: ${r.skipped}`;
      if (report.autonomy.at(-1) !== line) report.autonomy.push(line);
      return 'started' in r;
    } catch (err) {
      report.errors.push(`самостоятельная задача: ${truncate((err as Error).message, 200)}`);
      return false;
    }
  };

  while (true) {
    const now = clock.now();
    if (now >= deadline) {
      report.stoppedBy = now >= closeAt ? 'close' : 'deadline';
      break;
    }
    if (app.queue.active) idleSince = now;
    else await tryAutonomy();
    if (app.telegram && app.bot) {
      const timeout = Math.max(0, Math.min(s.telegramPollSeconds, Math.floor((deadline - now) / 1000) - 1));
      try {
        const polledAt = clock.now();
        const updates = await app.telegram.getUpdates(offset, timeout);
        for (const u of updates) {
          await app.bot.handleUpdate(u);
          offset = u.update_id + 1;
          await app.store.put('tg-state', 'poll', { offset });
          report.updates++;
        }
        if (!updates.length) {
          if (o.exitWhenIdle && !app.queue.active) {
            report.stoppedBy = 'idle';
            break;
          }
          // Сервер вернул пусто быстрее таймаута — не крутить цикл вхолостую.
          if (clock.now() - polledAt < 1000) await sleep(1000);
        }
      } catch (err) {
        report.errors.push(`telegram: ${truncate((err as Error).message, 160)}`);
        log(`[telegram] ${(err as Error).message}`);
        await sleep(5000);
      }
    } else if (app.queue.active) {
      await sleep(2000);
    } else {
      // Без Telegram новых задач не будет — сессия заканчивается, когда работа сделана.
      report.stoppedBy = 'idle';
      break;
    }
    await app.outbox.flush();
    if (clock.now() - lastSave >= saveEvery) {
      await save('periodic');
      lastSave = clock.now();
    }
  }

  // Завершение: новых запусков нет, текущий шаг доделывается, следующий — уже нет.
  app.queue.paused = true;
  app.studio.stopCheck = () => stopMessage();
  if (app.queue.active) {
    log('Жду завершения текущего шага…');
    await Promise.race([app.queue.idle, sleep(s.finishStepGraceMinutes * 60_000)]);
  }
  await app.outbox.flush();
  await save('end');

  const s2 = await app.ledger.summary();
  report.budget = { daySpent: s2.day.spentUsd, dayLimit: s2.day.limitUsd, monthSpent: s2.month.spentUsd, monthLimit: s2.month.limitUsd };
  const project = app.projects.open(await app.projects.list());
  report.initiatives = [
    ...(project ? [{ id: project.id, title: `${project.title} (${project.screens.filter((s) => s.state === 'ready').length}/${project.screens.length || '?'} экранов)`, status: project.pauseKind === 'schedule' ? 'paused:schedule' : project.status, version: project.version, waiting: project.status === 'awaiting_owner' }] : []),
    ...(await app.studio.list())
    .filter((i) => !i.projectId && !['approved', 'rejected', 'declined'].includes(i.status))
    .map((i) => ({ id: i.id, title: i.title, status: i.pauseKind === 'schedule' ? 'paused:schedule' : i.status, version: i.version, waiting: i.status === 'awaiting_owner' })),
  ];
  return report;
}

const STOP: Record<string, string> = { deadline: 'закончилось время сессии', close: 'закончилось рабочее время', idle: 'работа сделана' };
const STATUS: Record<string, string> = {
  running: 'в работе', awaiting_owner: 'ждёт вашего решения в Telegram', 'paused:schedule': 'продолжит в рабочие часы',
  paused: 'на паузе', blocked: 'не прошло внутренний контроль', failed: 'сбой',
};

/** Сводка для страницы запуска в GitHub Actions — коротко и по делу. */
export function formatSessionSummary(r: SessionReport, extra: string[] = []): string {
  const lines = ['## Студия DRIVE&KAVA', ''];
  if (r.status === 'night') {
    const h = Math.floor(r.minutesToOpen / 60);
    const m = r.minutesToOpen % 60;
    lines.push(`🌙 Нерабочее время (${r.local}). Часы работы: ${r.hours}. Модели не вызывались. До начала работы: ${h} ч ${m} мин.`);
    return [...lines, ...extra].join('\n') + '\n';
  }
  const stop = r.stoppedBy ? STOP[r.stoppedBy] : '';
  lines.push(`Начало: ${r.local}. Часы работы: ${r.hours}.${stop ? ` Остановка: ${stop}.` : ''}`);
  if (r.paused) lines.push('⏸ Новая работа на паузе (команда /pause в Telegram; /resume — снова запускать).');
  if (r.task) lines.push(`Задача из GitHub: «${r.task.title}» — ${r.task.status === 'duplicate' ? 'уже в работе' : r.task.id}.`);
  if (r.resumed.length) lines.push(`Продолжено с прошлой сессии: ${r.resumed.length}.`);
  for (const a of r.autonomy) lines.push(`Сама: ${a}.`);
  lines.push(`Сообщений из Telegram обработано: ${r.updates}. Сохранений состояния: ${r.saves}.`);
  if (r.budget) lines.push(`Бюджет: сегодня $${r.budget.daySpent} из $${r.budget.dayLimit}, месяц $${r.budget.monthSpent} из $${r.budget.monthLimit}.`);
  lines.push('', r.initiatives.length ? '| Задача | Статус | Версия |\n|---|---|---|' : 'Открытых задач нет.');
  for (const i of r.initiatives) lines.push(`| ${i.title.replace(/\|/g, '/')} | ${STATUS[i.status] ?? i.status} | ${i.version ? `v${i.version}` : '—'} |`);
  if (r.errors.length) lines.push('', '**Проблемы:**', ...r.errors.map((e) => `- ${e}`));
  return [...lines, ...extra].join('\n') + '\n';
}
