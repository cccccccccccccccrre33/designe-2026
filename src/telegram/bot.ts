// Бот владельца: пульт управления студией. Принимает только сообщения владельца,
// игнорирует повторные update_id, привязывает каждое решение к конкретной версии.
// Сообщения формируются кодом — без LLM-пересказов (PREF-007). Исключение по просьбе владельца\n// (2026-10-15): карточку результата подаёт ведущий — заголовок, 2–3 предложения и вопрос.

import type { Store } from '../store/store.ts';
import { truncate, type Clock } from '../core/util.ts';
import type { Outbox, OutboxItem } from '../pipeline/outbox.ts';
import type { Studio } from '../pipeline/studio.ts';
import type { Keyboard, TelegramApi, TgUpdate } from './api.ts';

interface Session {
  mode: 'feedback' | 'reject';
  approvalId: string;
  parts: string[];
  openedAt: number;
}

const HELP = [
  'DRIVE&KAVA Studio — команды:',
  '/new <задача> — новая задача для студии',
  '/status — что в работе',
  '/budget — расходы за день и месяц',
  '/history — последние решения',
  '/prefs — ваши сохранённые предпочтения',
  '/resume <id> — продолжить инициативу после паузы',
  '/pause — не запускать новую работу; /resume — снова запускать',
  '/auto off — студия не берёт задачи сама; /auto on — снова берёт',
  'Готовые результаты приходят карточкой с кнопками «Одобрить», «На доработку», «Отклонить».',
  'Короткая правка: просто напишите, что не так, и нажмите «Это правка к …».',
].join('\n');

export interface Scheduler {
  schedule(initiativeId: string): void;
  paused: boolean;
}

export class OwnerBot {
  private api: TelegramApi;
  private studio: Studio;
  private store: Store;
  private clock: Clock;
  private ownerId: number;
  private chatId: number;
  scheduler: Scheduler;
  /** Строка о рабочих часах для /status (сессия в GitHub Actions задаёт её сама). */
  statusNote: (() => string) | null = null;

  constructor(opts: { api: TelegramApi; studio: Studio; store: Store; clock: Clock; ownerId: number; chatId?: number; scheduler: Scheduler }) {
    this.api = opts.api;
    this.studio = opts.studio;
    this.store = opts.store;
    this.clock = opts.clock;
    this.ownerId = opts.ownerId;
    this.chatId = opts.chatId ?? opts.ownerId;
    this.scheduler = opts.scheduler;
  }

  /** Обработчики outbox: карточка результата и текст владельцу. */
  register(outbox: Outbox): void {
    outbox.on('owner.text', async (item) => this.api.sendMessage(this.chatId, String(item.payload.text)));
    outbox.on('owner.card', async (item) => this.sendCard(item, outbox));
  }

  private async sendCard(item: OutboxItem, outbox: Outbox): Promise<unknown> {
    const p = item.payload as unknown as CardPayload;
    let pr = '';
    if (p.githubKey) {
      const gh = await outbox.get(p.githubKey);
      if (gh?.status === 'done') pr = `GitHub: ${(gh.result as { prUrl?: string })?.prUrl ?? ''}`;
      else if (gh && gh.status === 'pending' && gh.attempts < 2) throw new Error('ждём публикацию в GitHub');
      else pr = 'GitHub: публикация задерживается, ссылка придёт отдельно';
    }
    const caption = cardCaption(p, pr);
    const keyboard = approvalKeyboard(p.approvalId);
    const images = p.images.filter(Boolean);
    if (images.length <= 1) {
      const msg = await this.api.sendPhoto(this.chatId, images[0], caption, keyboard);
      return { messageId: msg.message_id };
    }
    await this.api.sendMediaGroup(this.chatId, images, caption);
    const msg = await this.api.sendMessage(this.chatId, `Решение по «${truncate(p.title, 60)}» v${p.version}:`, keyboard);
    return { messageId: msg.message_id };
  }

  private inFlight = new Set<number>();

  /**
   * Повторная доставка того же update_id (ретрай вебхука, повтор после сбоя) не
   * обрабатывается дважды. Отметка ставится после обработки: сбой посередине даёт
   * повтор, а не потерю — решения владельца идемпотентны.
   */
  async handleUpdate(update: TgUpdate): Promise<void> {
    const seenKey = String(update.update_id);
    if (this.inFlight.has(update.update_id) || (await this.store.get('tg-seen', seenKey))) return;
    this.inFlight.add(update.update_id);
    try {
      await this.dispatch(update);
      await this.store.put('tg-seen', seenKey, { ts: this.clock.now() });
    } finally {
      this.inFlight.delete(update.update_id);
    }
  }

  private async dispatch(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      const q = update.callback_query;
      if (q.from.id !== this.ownerId) {
        await this.api.answerCallback(q.id, 'Недоступно');
        return;
      }
      await this.onCallback(q.id, q.data ?? '', q.message?.chat.id ?? this.chatId, q.message?.message_id);
      return;
    }
    const m = update.message;
    if (!m || !m.text) return;
    if (m.from?.id !== this.ownerId) return; // чужие сообщения игнорируются молча
    const text = m.text.trim();
    if (text.startsWith('/')) {
      await this.onCommand(text);
      return;
    }
    const session = await this.store.get<Session>('tg-session', 'owner');
    if (session) {
      if (session.mode === 'reject') {
        await this.store.delete('tg-session', 'owner');
        await this.finishDecision(session.approvalId, 'reject', { reason: text });
        return;
      }
      session.parts.push(text);
      await this.store.put('tg-session', 'owner', session);
      await this.api.react(this.chatId, m.message_id);
      return;
    }
    const pendingId = `p${this.clock.now().toString(36)}`;
    await this.store.put('tg-pending', pendingId, { text, ts: this.clock.now() });
    // Если версия ждёт решения, короткое сообщение чаще всего — правка к ней: одна кнопка.
    const waiting = (await this.studio.approvals()).filter((a) => a.status === 'pending').at(-1);
    const ini = waiting ? await this.studio.get(waiting.initiativeId).catch(() => null) : null;
    const rows: Keyboard['inline_keyboard'] = [];
    if (waiting && ini) rows.push([{ text: `✏️ Это правка к «${truncate(ini.title, 28)}» v${waiting.version}`, callback_data: `q:${pendingId}:${waiting.id}` }]);
    rows.push([{ text: waiting ? 'Новая задача' : 'Создать задачу', callback_data: `n:${pendingId}:y` }, { text: 'Нет', callback_data: `n:${pendingId}:n` }]);
    await this.api.sendMessage(this.chatId, waiting && ini ? `Это правка или новая задача?\n«${truncate(text, 300)}»` : `Создать задачу для студии?\n«${truncate(text, 300)}»`, { inline_keyboard: rows });
  }

  private async onCommand(text: string): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd.split('@')[0]) {
      case '/start':
      case '/help':
        await this.api.sendMessage(this.chatId, HELP);
        return;
      case '/new':
        if (!arg) {
          await this.api.sendMessage(this.chatId, 'Опишите задачу после /new, например: /new главный экран — долго ищу нужный напиток');
          return;
        }
        await this.createInitiative(arg);
        return;
      case '/status': {
        const open = (await this.studio.list()).filter((i) => !['approved', 'rejected', 'declined'].includes(i.status));
        const list = open.length ? open.map((i) => `• ${i.title} — ${i.pauseKind === 'schedule' ? 'ждёт рабочих часов' : STATUS[i.status] ?? i.status}${i.version ? `, v${i.version}` : ''}${i.pauseReason && i.pauseKind !== 'schedule' ? ` (${truncate(i.pauseReason, 80)})` : ''}\n  ${i.id}`).join('\n') : 'Сейчас ничего не в работе.';
        const paused = this.scheduler.paused ? '\n⏸ Новая работа не запускается (/resume — снова запускать).' : '';
        await this.api.sendMessage(this.chatId, `${list}${paused}${this.statusNote ? `\n\n${this.statusNote()}` : ''}`);
        return;
      }
      case '/budget': {
        const s = await this.studio.d.ledger.summary();
        const models = Object.entries(s.byModel).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}: $${v}`).join(', ');
        await this.api.sendMessage(this.chatId, `Сегодня: $${s.day.spentUsd} из $${s.day.limitUsd}\nМесяц: $${s.month.spentUsd} из $${s.month.limitUsd}\nПо моделям: ${models || '—'}`);
        return;
      }
      case '/history': {
        const approvals = (await this.studio.approvals()).filter((a) => a.status !== 'pending').slice(-10);
        const inis = new Map((await this.studio.list()).map((i) => [i.id, i]));
        await this.api.sendMessage(this.chatId, approvals.length ? approvals.map((a) => `${DECISION[a.status] ?? a.status} ${inis.get(a.initiativeId)?.title ?? a.initiativeId} v${a.version}${a.feedback ? ` — «${truncate(a.feedback, 60)}»` : ''}${a.reason ? ` — ${truncate(a.reason, 60)}` : ''}`).join('\n') : 'Решений пока нет.');
        return;
      }
      case '/prefs': {
        const file = await this.studio.d.prefs.load();
        const active = file.preferences.filter((p) => p.status === 'active');
        await this.api.sendMessage(this.chatId, `Активные:\n${active.map((p) => `${p.id} ${p.statement}`).join('\n')}${file.candidates.length ? `\n\nКандидаты (станут правилом при повторе):\n${file.candidates.map((c) => `${c.statement} (${c.count}×)`).join('\n')}` : ''}`);
        return;
      }
      case '/pause':
        this.scheduler.paused = true;
        // Флаг переживает перезапуск: сессии в GitHub Actions читают его при старте.
        await this.store.put('control', 'studio', { paused: true, ts: this.clock.now() });
        await this.api.sendMessage(this.chatId, '⏸ Новая работа не запускается. /resume — снова запускать.');
        return;
      case '/resume':
        if (!arg) {
          this.scheduler.paused = false;
          await this.store.put('control', 'studio', { paused: false, ts: this.clock.now() });
          const paused = (await this.studio.list()).filter((i) => ['paused', 'running', 'failed'].includes(i.status));
          for (const i of paused) this.scheduler.schedule(i.id);
          await this.api.sendMessage(this.chatId, `▶️ Работа возобновлена${paused.length ? `: ${paused.length} инициатив(ы) продолжаются` : ''}.`);
          return;
        }
        this.scheduler.schedule(arg);
        await this.api.sendMessage(this.chatId, `▶️ Продолжаю ${arg}.`);
        return;
      case '/auto': {
        const on = arg !== 'off';
        await this.store.put('control', 'autonomy', { enabled: on, ts: this.clock.now() });
        await this.api.sendMessage(this.chatId, on
          ? '💡 Студия снова сама берёт задачи, когда очередь пустая (днём, одна за раз, следующая — после вашего решения).'
          : '⏹ Студия больше не берёт задачи сама. Ваши задачи и правки выполняются как обычно. /auto on — включить.');
        return;
      }
      default:
        await this.api.sendMessage(this.chatId, HELP);
    }
  }

  private async createInitiative(text: string): Promise<void> {
    try {
      const { initiative, duplicate } = await this.studio.intake(text, 'owner');
      if (duplicate) {
        await this.api.sendMessage(this.chatId, `Похожая задача уже в работе: «${initiative.title}» (${STATUS[initiative.status] ?? initiative.status}).`);
        return;
      }
      if (initiative.status === 'declined') return;
      if (initiative.pauseKind === 'schedule') {
        await this.api.sendMessage(this.chatId, `Принял: «${initiative.title}». Сейчас нерабочее время студии — начну в рабочие часы и пришлю готовый результат.`);
        return;
      }
      await this.api.sendMessage(this.chatId, `Принял: «${initiative.title}». Команда работает; пришлю готовый результат, без черновиков.`);
      this.scheduler.schedule(initiative.id);
    } catch (err) {
      await this.api.sendMessage(this.chatId, `Не получилось начать: ${truncate((err as Error).message, 300)}`);
    }
  }

  private async onCallback(queryId: string, data: string, chatId: number, messageId?: number): Promise<void> {
    const [kind, id, action] = data.split(':');
    if (kind === 'n') {
      const pending = await this.store.get<{ text: string }>('tg-pending', id);
      await this.store.delete('tg-pending', id);
      await this.api.answerCallback(queryId);
      if (messageId) await this.api.editKeyboard(chatId, messageId, { inline_keyboard: [] });
      if (pending && action === 'y') await this.createInitiative(pending.text);
      return;
    }
    if (kind === 'q') {
      // q:<pendingId>:<approvalId> — короткое сообщение владельца как правка к версии.
      const approvalId = data.slice(`q:${id}:`.length);
      const pending = await this.store.get<{ text: string }>('tg-pending', id);
      await this.store.delete('tg-pending', id);
      await this.api.answerCallback(queryId, 'Принимаю правку…');
      if (messageId) await this.api.editKeyboard(chatId, messageId, { inline_keyboard: [] });
      if (pending) await this.finishDecision(approvalId, 'changes', { feedback: pending.text });
      return;
    }
    if (kind === 'a') {
      if (action === 'ok') {
        await this.api.answerCallback(queryId, 'Фиксирую…');
        const res = await this.finishDecision(id, 'approve', {});
        if (res && messageId) await this.api.editKeyboard(chatId, messageId, { inline_keyboard: [[{ text: '✅ Одобрено', callback_data: `x:${id}` }]] });
        return;
      }
      if (action === 'ch' || action === 'rej') {
        const approval = (await this.studio.approvals()).find((a) => a.id === id);
        if (!approval || approval.status !== 'pending') {
          await this.api.answerCallback(queryId, 'Эта версия уже не ждёт решения');
          return;
        }
        await this.store.put<Session>('tg-session', 'owner', { mode: action === 'ch' ? 'feedback' : 'reject', approvalId: id, parts: [], openedAt: this.clock.now() });
        await this.api.answerCallback(queryId);
        if (action === 'ch') {
          await this.api.sendMessage(this.chatId, 'Напишите правки — можно несколькими сообщениями. Когда закончите, нажмите «Готово».', {
            inline_keyboard: [[{ text: 'Готово', callback_data: `f:${id}:done` }, { text: 'Отмена', callback_data: `f:${id}:cancel` }]],
          });
        } else {
          await this.api.sendMessage(this.chatId, 'Почему отклоняете? Одним сообщением — это учтётся в следующих задачах.', { inline_keyboard: [[{ text: 'Без причины', callback_data: `r:${id}:none` }]] });
        }
        return;
      }
      if (action === 'hist') {
        await this.api.answerCallback(queryId);
        const approval = (await this.studio.approvals()).find((a) => a.id === id);
        const ini = approval ? await this.studio.get(approval.initiativeId) : null;
        if (ini) await this.api.sendMessage(this.chatId, `История «${ini.title}»:\n${ini.history.slice(-12).map((h) => `${new Date(h.ts).toISOString().slice(5, 16).replace('T', ' ')} ${EVENT[h.event] ?? h.event}${h.detail ? ` — ${truncate(h.detail, 60)}` : ''}`).join('\n')}`);
        return;
      }
    }
    if (kind === 'f') {
      const session = await this.store.get<Session>('tg-session', 'owner');
      await this.api.answerCallback(queryId);
      await this.store.delete('tg-session', 'owner');
      if (messageId) await this.api.editKeyboard(chatId, messageId, { inline_keyboard: [] });
      if (action === 'done' && session && session.approvalId === id) {
        if (!session.parts.length) {
          await this.api.sendMessage(this.chatId, 'Правок не получил — версия остаётся на решении.');
          return;
        }
        await this.finishDecision(id, 'changes', { feedback: session.parts.join('\n') });
      }
      return;
    }
    if (kind === 'r') {
      await this.store.delete('tg-session', 'owner');
      await this.api.answerCallback(queryId);
      await this.finishDecision(id, 'reject', {});
      return;
    }
    await this.api.answerCallback(queryId);
  }

  private async finishDecision(approvalId: string, action: 'approve' | 'changes' | 'reject', opts: { feedback?: string; reason?: string }): Promise<boolean> {
    try {
      const res = await this.studio.decide(approvalId, action, opts);
      if (!res.ok) {
        await this.api.sendMessage(this.chatId, res.message);
        return false;
      }
      if (action === 'changes' && res.initiative) this.scheduler.schedule(res.initiative.id);
      return true;
    } catch (err) {
      await this.api.sendMessage(this.chatId, `Не получилось зафиксировать решение: ${truncate((err as Error).message, 200)}. Версия остаётся на решении — можно повторить.`);
      return false;
    }
  }
}

export interface CardPayload {
  initiativeId: string;
  approvalId: string;
  version: number;
  title: string;
  changed: string;
  why: string;
  schools?: string[];
  /** Подача ведущего: старшая роль в манере своей школы, подписана как AI. */
  presenter?: { label: string; headline: string; story: string; question: string } | null;
  references?: Array<{ title: string; url: string }>;
  autonomous?: boolean;
  problem: string;
  status: string;
  checks: string;
  score: number;
  costUsd: number;
  images: string[];
  githubKey: string | null;
}

export function cardCaption(p: CardPayload, prLine: string): string {
  const pr = p.presenter;
  const lines = [
    `DRIVE&KAVA — ${p.title} · v${p.version}${p.autonomous ? ' · студия взяла сама' : ''}`,
    '',
    ...(pr ? [`🎙 ${pr.label}`, `«${truncate(pr.headline, 90)}»`, truncate(pr.story, 360), `❓ ${truncate(pr.question, 140)}`, ''] : []),
    p.version > 1 || !pr ? `Что изменено:\n${truncate(p.changed, pr ? 220 : 320)}` : '',
    pr ? '' : `Почему сильно: ${truncate(p.why, 200)}`,
    p.schools?.length ? `Школы: ${truncate(p.schools.slice(0, 3).join('; '), 180)}` : '',
    p.references?.length ? `Референсы: ${p.references.slice(0, 2).map((r) => `${truncate(r.title, 40)} — ${r.url}`).join('; ')}` : '',
    pr ? '' : `Решает: ${truncate(p.problem, 160)}`,
    `Статус: ${p.status}`,
    `Проверки: ${p.checks} · оценка ${p.score}/5 · $${p.costUsd}`,
    prLine,
  ].filter((l) => l !== '');
  let caption = lines.join('\n');
  if (caption.length > 1024) caption = caption.slice(0, 1020) + '…';
  return caption;
}

export function approvalKeyboard(approvalId: string): Keyboard {
  return {
    inline_keyboard: [
      [{ text: '✅ Одобрить', callback_data: `a:${approvalId}:ok` }],
      [{ text: '✏️ На доработку', callback_data: `a:${approvalId}:ch` }, { text: '❌ Отклонить', callback_data: `a:${approvalId}:rej` }],
      [{ text: '🕘 История', callback_data: `a:${approvalId}:hist` }],
    ],
  };
}

const STATUS: Record<string, string> = { running: 'в работе', awaiting_owner: 'ждёт вашего решения', paused: 'на паузе', blocked: 'не прошло внутренний контроль', failed: 'сбой', approved: 'утверждено', rejected: 'отклонено', declined: 'не задача студии' };
const DECISION: Record<string, string> = { approved: '✅', rejected: '❌', changes_requested: '✏️', superseded: '↪️' };
const EVENT: Record<string, string> = { created: 'создана', delivered: 'отправлена версия', changes_requested: 'правки', approved: 'одобрено', rejected: 'отклонено', paused_budget: 'пауза: бюджет', paused_models: 'пауза: модели', paused_schedule: 'пауза: нерабочее время', failed: 'сбой', blocked_quality_gate: 'остановлено контролем качества', duplicate_request: 'повторный запрос', declined: 'не задача студии', senior_review: 'проверка старших', autonomy: 'студия взяла сама' };

/** Очередь запусков: инициативы выполняются по одной, после каждой — доставка outbox. */
export class RunQueue implements Scheduler {
  private studio: Studio;
  private outbox: Outbox;
  private queue: string[] = [];
  private busy = false;
  paused = false;
  idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  constructor(studio: Studio, outbox: Outbox) {
    this.studio = studio;
    this.outbox = outbox;
  }

  /** Идёт работа или в очереди есть инициативы. */
  get active(): boolean {
    return this.busy || this.queue.length > 0;
  }

  schedule(initiativeId: string): void {
    if (this.paused) return;
    if (!this.queue.includes(initiativeId)) this.queue.push(initiativeId);
    if (!this.busy) {
      this.idle = new Promise((r) => { this.resolveIdle = r; });
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.queue.length && !this.paused) {
        const id = this.queue.shift()!;
        try {
          await this.studio.run(id);
        } catch (err) {
          console.error(`[queue] ${id}: ${(err as Error).message}`);
        }
        await this.outbox.flush();
      }
    } finally {
      this.busy = false;
      this.resolveIdle?.();
    }
  }
}

/** Long polling: локальный режим без публичного адреса. */
export async function pollForever(api: TelegramApi, bot: OwnerBot, store: Store, signal?: AbortSignal): Promise<void> {
  let offset = (await store.get<{ offset: number }>('tg-state', 'poll'))?.offset ?? 0;
  while (!signal?.aborted) {
    try {
      const updates = await api.getUpdates(offset, 25);
      for (const u of updates) {
        await bot.handleUpdate(u);
        offset = u.update_id + 1;
        await store.put('tg-state', 'poll', { offset });
      }
    } catch (err) {
      console.error(`[telegram] ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** Вебхук (этап 5: Lambda Function URL). Проверяет секрет Telegram. */
export async function handleWebhook(req: { headers: Record<string, string | undefined>; body: string }, bot: OwnerBot, secret: string): Promise<{ statusCode: number }> {
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return { statusCode: 401 };
  let update: TgUpdate;
  try {
    update = JSON.parse(req.body) as TgUpdate;
  } catch {
    return { statusCode: 400 };
  }
  await bot.handleUpdate(update);
  return { statusCode: 200 };
}
