// Самостоятельная работа студии, проверка старшими и подача ведущего.
// Telegram — поддельный, модели — сценарные, рендер — настоящий Chrome.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { autonomousTick } from '../src/pipeline/autonomy.ts';
import { ScreenRenderer, findBrowser } from '../src/render/renderer.ts';
import type { Tokens } from '../src/render/spec.ts';
import { loadSchedule } from '../src/runtime/schedule.ts';
import { formatSessionSummary, runSession } from '../src/runtime/session.ts';
import { FakeTelegram, REPO, callback, tempRepo, update } from './helpers.ts';

const OWNER = 4242;
const base = await loadSchedule(REPO);
const schedule = { ...base, autonomy: { enabled: true, idleMinutes: 0, maxPerDay: 3, minMinutesLeft: 15 } };
const criteria = JSON.parse(await readFile(join(REPO, 'studio/org/rubric.json'), 'utf8')).criteria.map((c: { id: string }) => c.id);
const tokens = JSON.parse(await readFile(join(REPO, 'design-system/tokens.json'), 'utf8')) as Tokens;
const renderer = new ScreenRenderer(tokens, join(REPO, 'design-system'));
after(() => renderer.close());
const noChrome = !findBrowser() && 'нет Chrome/Edge';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)));
/** Подпись карточки: у одного фото — caption, у альбома — подпись первого кадра. */
const captionOf = (c: { params: Record<string, unknown> }) => String(c.params.caption ?? (c.params.media as Array<{ caption?: string }> | undefined)?.[0]?.caption ?? '');

async function makeApp(tg: FakeTelegram | null, clock: { now(): number }, provider: ScriptedProvider) {
  const repo = await tempRepo();
  return createApp({
    repoRoot: repo, dataDir: join(repo, '.studio-data'), mode: 'scripted', provider, clock, renderer, imageProvider: null,
    telegram: tg ? { token: 'T', ownerId: OWNER, fetchImpl: tg.fetch } : null, github: null, quiet: true,
  });
}

test('сама: приложение уже утверждено, очередь пустая днём — директор студии берёт задачу, старшие проверяют, ведущий показывает, следующая ждёт решения', { skip: noChrome }, async () => {
  const tg = new FakeTelegram();
  const clock = { t: Date.parse('2026-07-15T09:00:00Z'), now() { return this.t; } }; // 12:00 по Киеву
  const provider = new ScriptedProvider(criteria, { before: () => { clock.t += 20_000; } });
  const app = await makeApp(tg, clock, provider);
  // Приложение целиком уже сделано и утверждено — дальше студия берёт отдельные улучшения.
  await app.store.put('projects', 'prj-done', { id: 'prj-done', title: 'Приложение', source: 'owner', status: 'approved', screens: [], version: 1, round: 0, createdAt: 1, updatedAt: 1, history: [] });
  const report = await runSession({ app, schedule, clock, maxMs: 50 * 60_000, exitWhenIdle: true, sleep });

  assert.match(report.autonomy[0], /взята задача «/);
  assert.ok(report.autonomy.some((a) => /своя задача уже открыта/.test(a)), 'вторая не берётся, пока владелец не решил по первой');
  assert.match(formatSessionSummary(report), /Сама: взята задача/);
  const [ini] = await app.studio.list();
  assert.equal(ini.source, 'autonomous');
  assert.equal(ini.status, 'awaiting_owner');
  assert.ok(ini.history.some((h) => h.event === 'autonomy'));
  assert.ok(ini.history.some((h) => h.event === 'senior_review'));
  assert.ok(provider.calls.some((c) => c.output === 'critique' && c.role === 'head-of-product-design'), 'старший продуктовый дизайн смотрел до владельца');
  assert.equal(provider.calls.filter((c) => c.output === 'autonomyPlan').length, 1);
  assert.ok(tg.texts().some((t) => t.startsWith('💡 Студия взяла задачу сама')));

  const [card] = tg.cards();
  const caption = captionOf(card);
  assert.match(caption, /студия взяла сама/);
  assert.match(caption, /🎙 Директор студии \(AI · школа: [^)]+\)/);
  assert.match(caption, /❓ /);
  assert.doesNotMatch(caption, /НЕСУЩЕСТВУЮЩИЙ/);
  const summary = await readFile(join(app.studio.d.repoRoot, `studio/initiatives/${ini.id}/v1/summary.md`), 'utf8');
  assert.match(summary, /Вопрос владельцу:/);

  // Короткий ответ владельца — правка к версии в одно касание.
  // (сессия закончилась и закрыла очередь — дальше бот работает как в следующей сессии)
  app.queue.paused = false;
  app.studio.stopCheck = null;
  await app.bot!.handleUpdate(update(10, OWNER, 'Сделайте кнопки прозрачнее'));
  const keyboard = (tg.calls.at(-1)!.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard.flat();
  const fix = keyboard.find((b) => b.callback_data.startsWith('q:'))!;
  assert.match(fix.text, /Это правка к «.+» v1/);
  await app.bot!.handleUpdate(callback(11, OWNER, fix.callback_data));
  await app.queue.idle;
  const v2 = await app.studio.get(ini.id);
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'awaiting_owner');
  assert.equal(tg.cards().length, 2);
  assert.match(captionOf(tg.cards().at(-1)!), /Что изменено/);
});

test('сама: /auto off, бюджет и дневной лимит останавливают без вызова моделей', { skip: noChrome }, async () => {
  const clock = { now: () => Date.parse('2026-07-15T09:00:00Z') };
  const provider = new ScriptedProvider(criteria);
  const app = await makeApp(null, clock, provider);
  const deps = { studio: app.studio, store: app.store, ledger: app.ledger, outbox: app.outbox, clock, schedule: () => undefined };
  assert.deepEqual(await autonomousTick(deps, { enabled: false, maxPerDay: 3 }, '2026-07-15'), { skipped: 'выключено в schedule.json' });
  await app.store.put('control', 'autonomy', { enabled: false });
  assert.match((await autonomousTick(deps, { enabled: true, maxPerDay: 3 }, '2026-07-15') as { skipped: string }).skipped, /auto off/);
  await app.store.put('control', 'autonomy', { enabled: true });
  await app.store.put('autonomy', '2026-07-15', { started: 3, proposals: 3 });
  assert.match((await autonomousTick(deps, { enabled: true, maxPerDay: 3 }, '2026-07-15') as { skipped: string }).skipped, /лимит/);
  assert.equal(provider.calls.length, 0);
});

test('сама: без Telegram студия не берёт задачи — владелец не увидит результат', { skip: noChrome }, async () => {
  const clock = { now: () => Date.parse('2026-07-15T09:00:00Z') };
  const provider = new ScriptedProvider(criteria);
  const app = await makeApp(null, clock, provider);
  const report = await runSession({ app, schedule, clock, maxMs: 50 * 60_000, exitWhenIdle: true, sleep });
  assert.deepEqual(report.autonomy, []);
  assert.equal(provider.calls.length, 0);
});
