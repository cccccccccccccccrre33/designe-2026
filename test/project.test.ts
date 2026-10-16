// Проект «приложение целиком»: старшие → концепция → ключевой экран → остальные экраны →
// показ всего приложения → короткая правка владельца → переделка только затронутых экранов.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { autonomousTick } from '../src/pipeline/autonomy.ts';
import { projectContext } from '../src/pipeline/project.ts';
import { ScreenRenderer, findBrowser } from '../src/render/renderer.ts';
import type { Tokens } from '../src/render/spec.ts';
import { FakeTelegram, REPO, callback, tempRepo, update } from './helpers.ts';

const OWNER = 4242;
const criteria = JSON.parse(await readFile(join(REPO, 'studio/org/rubric.json'), 'utf8')).criteria.map((c: { id: string }) => c.id);
const tokens = JSON.parse(await readFile(join(REPO, 'design-system/tokens.json'), 'utf8')) as Tokens;
const renderer = new ScreenRenderer(tokens, join(REPO, 'design-system'));
after(() => renderer.close());
const noChrome = !findBrowser() && 'нет Chrome/Edge';
const captionOf = (c: { params: Record<string, unknown> }) => String(c.params.caption ?? (c.params.media as Array<{ caption?: string }> | undefined)?.[0]?.caption ?? '');

test('приложение целиком: концепция старших, ключевой экран первым, показ одной карточкой, правка только затронутого экрана', { skip: noChrome }, async () => {
  const tg = new FakeTelegram();
  const repo = await tempRepo();
  const provider = new ScriptedProvider(criteria);
  const app = await createApp({ repoRoot: repo, dataDir: join(repo, '.studio-data'), mode: 'scripted', provider, renderer, imageProvider: null, telegram: { token: 'T', ownerId: OWNER, fetchImpl: tg.fetch }, github: null, quiet: true });

  await app.bot!.handleUpdate(update(1, OWNER, '/app'));
  await app.queue.idle;
  const [p] = await app.projects.list();
  assert.equal(p.status, 'awaiting_owner');
  assert.deepEqual(p.screens.map((s) => s.screen), ['home', 'catalog', 'pickup'], 'дубль экрана из концепции отброшен');
  assert.ok(p.screens.every((s) => s.state === 'ready'));
  // Старшие дали позиции до концепции.
  for (const role of ['studio-director', 'creative-director', 'head-of-product-design']) assert.ok(provider.calls.some((c) => c.output === 'position' && c.role === role), role);
  const inis = await app.studio.list();
  assert.equal(inis[0].screen, 'home', 'ключевой экран делается первым');
  assert.ok(inis.every((i) => i.projectId === p.id && i.status === 'ready'));
  // Остальные экраны видят концепцию и визуальный язык ключевого.
  const ctx = await projectContext(app.store, inis.find((i) => i.screen === 'catalog')!);
  assert.equal(ctx.length, 2);
  assert.match(ctx[1].title, /визуальный язык — ключевой экран «Главная»/);

  assert.equal(tg.cards().length, 1, 'владельцу — одна карточка на всё приложение, без карточек по экранам');
  const caption = captionOf(tg.cards()[0]);
  assert.match(caption, /🎙 Директор студии \(AI · школа: Сергей Мекрюков\)/);
  assert.match(caption, /экраны \(3\): Главная, Меню, Получение у окна/);
  assert.equal((tg.cards()[0].params.media as unknown[]).length, 3);
  const texts = tg.texts();
  assert.ok(texts.some((t) => t.startsWith('🚀 Начали делать приложение целиком')));
  assert.ok(texts.some((t) => t.startsWith('🧭 Концепция готова: «Тёплое окно»')));
  assert.ok(texts.some((t) => t.startsWith('🎯 Ключевой экран готов')));
  assert.ok(existsSync(join(repo, `studio/projects/${p.id}/v1/README.md`)));
  assert.ok(existsSync(join(repo, `studio/projects/${p.id}/v1/home.png`)));
  assert.match(await readFile(join(repo, `studio/projects/${p.id}/concept.md`), 'utf8'), /🎯 Главная/);

  // Короткая правка владельца — только к главной.
  await app.bot!.handleUpdate(update(2, OWNER, 'На главной сделайте кнопки прозрачнее'));
  const kb = (tg.calls.at(-1)!.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard.flat();
  const fix = kb.find((b) => b.callback_data.startsWith('q:'))!;
  assert.match(fix.text, /Это правка к «Утро у окна» v1/);
  await app.bot!.handleUpdate(callback(3, OWNER, fix.callback_data));
  await app.queue.idle;
  const p2 = await app.projects.get(p.id);
  assert.equal(p2.version, 2);
  assert.equal(p2.status, 'awaiting_owner');
  const after2 = await app.studio.list();
  assert.equal(after2.find((i) => i.screen === 'home')!.round, 1);
  assert.equal(after2.find((i) => i.screen === 'catalog')!.round, 0, 'незатронутый экран не переделывается');
  assert.equal(tg.cards().length, 2);
  assert.match(captionOf(tg.cards()[1]), /Что изменено:\nГлавная: ✓/);

  // Одобрение всего приложения.
  await app.bot!.handleUpdate(callback(4, OWNER, `a:${p2.approvalId}:ok`));
  assert.equal((await app.projects.get(p.id)).status, 'approved');
  assert.ok((await app.studio.list()).every((i) => i.status === 'approved'));
  assert.ok(tg.texts().some((t) => t.startsWith('✅ Приложение v2 утверждено')));
});

test('приложение целиком: самостоятельная работа начинает с него и закрывает одиночную задачу', async () => {
  const repo = await tempRepo();
  const app = await createApp({ repoRoot: repo, dataDir: join(repo, '.studio-data'), mode: 'scripted', provider: new ScriptedProvider(criteria), renderer: { render: async () => { throw new Error('не нужен'); } }, imageProvider: null, telegram: null, github: null, quiet: true });
  await app.store.put('initiatives', 'ini-old', { id: 'ini-old', title: 'Экран получения', source: 'autonomous', status: 'paused', pauseKind: 'models', history: [], createdAt: 1, updatedAt: 1 });
  const scheduled: string[] = [];
  const deps = { studio: app.studio, projects: app.projects, store: app.store, ledger: app.ledger, outbox: app.outbox, clock: { now: () => Date.now() }, schedule: (id: string) => scheduled.push(id) };
  const first = await autonomousTick(deps, { enabled: true, maxPerDay: 3 }, '2026-10-16');
  assert.ok('started' in first && first.started.id.startsWith('prj-'));
  assert.deepEqual(scheduled, [(first as { started: { id: string } }).started.id]);
  assert.equal((await app.studio.get('ini-old')).status, 'declined', 'одиночная самостоятельная задача вошла в приложение');
  assert.match((await autonomousTick(deps, { enabled: true, maxPerDay: 3 }, '2026-10-16') as { skipped: string }).skipped, /приложение в работе/);
  await app.close();
});
