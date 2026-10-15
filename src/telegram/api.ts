// Клиент Telegram Bot API через fetch. Статус: модульные тесты с подменой HTTP;
// живой бот не запускался — нет токена.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

type FetchLike = typeof fetch;

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type Keyboard = { inline_keyboard: InlineButton[][] };

export class TelegramError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(status: number, description: string, retryAfter: number | null) {
    super(`Telegram ${status}: ${description}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class TelegramApi {
  private base: string;
  private fetchImpl: FetchLike;

  constructor(token: string, opts: { baseUrl?: string; fetchImpl?: FetchLike } = {}) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');
    this.base = `${opts.baseUrl ?? 'https://api.telegram.org'}/bot${token}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async parse(res: Response): Promise<unknown> {
    const data = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as { ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
    if (!data.ok) throw new TelegramError(res.status, data.description ?? 'ошибка', data.parameters?.retry_after ?? null);
    return data.result;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 40_000): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await this.parse(res)) as T;
  }

  async sendMessage(chatId: number | string, text: string, keyboard?: Keyboard): Promise<{ message_id: number }> {
    return this.call('sendMessage', { chat_id: chatId, text: text.slice(0, 4096), reply_markup: keyboard, link_preview_options: { is_disabled: true } });
  }

  async sendPhoto(chatId: number | string, path: string, caption: string, keyboard?: Keyboard): Promise<{ message_id: number }> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', caption.slice(0, 1024));
    if (keyboard) form.set('reply_markup', JSON.stringify(keyboard));
    form.set('photo', new Blob([await readFile(path)], { type: 'image/png' }), basename(path));
    const res = await this.fetchImpl(`${this.base}/sendPhoto`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    return (await this.parse(res)) as { message_id: number };
  }

  async sendMediaGroup(chatId: number | string, paths: string[], caption: string): Promise<Array<{ message_id: number }>> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    const media = paths.slice(0, 10).map((_, i) => ({ type: 'photo', media: `attach://f${i}`, ...(i === 0 ? { caption: caption.slice(0, 1024) } : {}) }));
    form.set('media', JSON.stringify(media));
    for (let i = 0; i < media.length; i++) form.set(`f${i}`, new Blob([await readFile(paths[i])], { type: 'image/png' }), basename(paths[i]));
    const res = await this.fetchImpl(`${this.base}/sendMediaGroup`, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) });
    return (await this.parse(res)) as Array<{ message_id: number }>;
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  async editKeyboard(chatId: number | string, messageId: number, keyboard: Keyboard): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: keyboard }).catch(() => undefined);
  }

  async react(chatId: number | string, messageId: number, emoji = '👌'): Promise<void> {
    await this.call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }).catch(() => undefined);
  }

  async getUpdates(offset: number, timeoutSec = 30): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 10) * 1000);
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  }
}

export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; from?: { id: number }; chat: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } };
}
