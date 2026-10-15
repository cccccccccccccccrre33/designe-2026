// Рабочие часы студии (ADR-0007): когда сессии в GitHub Actions могут тратить бюджет.
// Время считается в часовом поясе владельца; переход на летнее время учитывает Intl,
// поэтому cron в workflow может быть грубым — точную границу проверяет этот модуль.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SchedulePolicy {
  timezone: string;
  workHours: { start: string; end: string };
  days: string[];
  session: {
    maxMinutes: number;
    stopBeforeCloseMinutes: number;
    saveEveryMinutes: number;
    telegramPollSeconds: number;
    finishStepGraceMinutes: number;
  };
  retention: { closedArtifactsDays: number; telegramSeenDays: number };
}

export interface WorkWindow {
  open: boolean;
  /** Минут до конца рабочего окна (0, если закрыто). */
  minutesToClose: number;
  /** Минут до начала следующего окна (0, если открыто). */
  minutesToOpen: number;
  /** Местное время, например «22:41 пт». */
  local: string;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_UA: Record<string, string> = { sun: 'нд', mon: 'пн', tue: 'вт', wed: 'ср', thu: 'чт', fri: 'пт', sat: 'сб' };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function loadSchedule(repoRoot: string): Promise<SchedulePolicy> {
  const p = JSON.parse(await readFile(join(repoRoot, 'studio/policies/schedule.json'), 'utf8')) as SchedulePolicy;
  const errors = validateSchedule(p);
  if (errors.length) throw new Error(`studio/policies/schedule.json: ${errors.join('; ')}`);
  return p;
}

export function validateSchedule(p: SchedulePolicy): string[] {
  const errors: string[] = [];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: p.timezone });
  } catch {
    errors.push(`неизвестный часовой пояс ${p.timezone}`);
  }
  for (const k of ['start', 'end'] as const) if (!HHMM.test(p.workHours?.[k] ?? '')) errors.push(`workHours.${k} должно быть ЧЧ:ММ`);
  if (p.workHours?.start === p.workHours?.end) errors.push('начало и конец рабочего дня совпадают');
  if (!Array.isArray(p.days) || !p.days.length || p.days.some((d) => !DAYS.includes(d))) errors.push('days — из mon…sun');
  if (!(p.session?.maxMinutes > 0 && p.session.maxMinutes <= 330)) errors.push('session.maxMinutes — от 1 до 330 (лимит задания GitHub — 6 часов)');
  return errors;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function localClock(now: number, timezone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return { day: get('weekday').toLowerCase().slice(0, 3), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function openAt(now: number, p: SchedulePolicy): { open: boolean; minutesToClose: number } {
  const { day, minutes } = localClock(now, p.timezone);
  const start = minutesOf(p.workHours.start);
  const end = minutesOf(p.workHours.end);
  const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];
  if (start < end) {
    const open = p.days.includes(day) && minutes >= start && minutes < end;
    return { open, minutesToClose: open ? end - minutes : 0 };
  }
  // Окно через полночь (например, 20:00–02:00): день окна — день его начала.
  if (p.days.includes(day) && minutes >= start) return { open: true, minutesToClose: 1440 - minutes + end };
  if (p.days.includes(prev) && minutes < end) return { open: true, minutesToClose: end - minutes };
  return { open: false, minutesToClose: 0 };
}

export function workWindow(now: number, p: SchedulePolicy): WorkWindow {
  const { day, minutes } = localClock(now, p.timezone);
  const local = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${DAY_UA[day] ?? day}`;
  const here = openAt(now, p);
  if (here.open) return { open: true, minutesToClose: here.minutesToClose, minutesToOpen: 0, local };
  // До открытия — шагами по 5 минут реального времени: переход на летнее время учтён.
  let minutesToOpen = 0;
  for (let t = 5; t <= 8 * 1440; t += 5) {
    if (openAt(now + t * 60_000, p).open) {
      minutesToOpen = t;
      break;
    }
  }
  return { open: false, minutesToClose: 0, minutesToOpen, local };
}

export function describeHours(p: SchedulePolicy): string {
  const days = p.days.length === 7 ? 'ежедневно' : p.days.map((d) => DAY_UA[d]).join(', ');
  return `${p.workHours.start}–${p.workHours.end} (${p.timezone}), ${days}`;
}
