// Сквозной сценарий первого milestone: задача в Telegram → команда → результат в
// Telegram → правки → новая версия → одобрение → решение в GitHub. Плюс сбои:
// недоступная модель, падение процесса, бюджет, отклонение, обрыв Telegram,
// повторные сообщения, чужие сообщения, устаревшие кнопки.
// Модели — сценарные, Telegram и GitHub — поддельные серверы; рендер — настоящий Chrome.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { ProviderError } from '../src/core/errors.ts';
import { ScriptedProvider, type ScriptHooks } from '../src/llm/scripted.ts';
import { ScreenRenderer, findBrowser } from '../src/render/renderer.ts';
import type { Tokens } from '../src/render/spec.ts';
import { handleWebhook } from '../src/telegram/bot.ts';
import { GitHubApi, Publisher } from '../src/github/publisher.ts';
import { PolicyViolation } from '../src/core/errors.ts';
import { FakeGitHub, FakeTelegram, REPO, callback, tempRepo, update } from './helpers.ts';

const OWNER = 4242;
const REQUEST = '/new Главный экран выглядит красиво, но пользователь слишком долго ищет нужный напиток';
const tokens = JSON.parse(await readFile(join(REPO, 'design-system/tokens.json'), 'utf8')) as Tokens;
const renderer = new ScreenRenderer(tokens, join(REPO, 'design-system'));
after(() => renderer.close());
const skip = !findBrowser() && 'нет Chrome/Edge для рендера';
const criteria = JSON.parse(await readFile(join(REPO, 'studio/org/rubric.json'), 'utf8')).criteria.map((c: { id: string }) => c.id);

interface Rig {
  app: App;
  tg: FakeTelegram;
  gh: FakeGitHub;
  provider: ScriptedProvider;
  repo: string;
  clock: { offset: number; now(): number };
}

async function rig(opts: { hooks?: ScriptHooks; budget?: Record<string, number> } = {}): Promise<Rig> {
  const repo = await tempRepo();
  const tg = new FakeTelegram();
  const gh = new FakeGitHub();
  const provider = new ScriptedProvider(criteria, opts.hooks);
  const clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const app = await createApp({
    repoRoot: repo, dataDir: join(repo, '.studio-data'), mode: 'scripted', provider, clock, renderer, imageProvider: null,
    telegram: { token: 'T', ownerId: OWNER, fetchImpl: tg.fetch },
    github: { token: 'G', repo: 'test/repo', fetchImpl: gh.fetch },
    budgetOverride: opts.budget, quiet: true,
  });
  return { app, tg, gh, provider, repo, clock };
}

async function send(r: Rig, u: ReturnType<typeof update> | ReturnType<typeof callback>): Promise<void> {
  await r.app.bot!.handleUpdate(u);
  await r.app.queue.idle;
}

function approvalFrom(r: Rig): string {
  const b = r.tg.lastApprovalKeyboard().find((x) => x.callback_data.endsWith(':ok'));
  assert.ok(b, 'нет карточки с кнопками решения');
  return b.callback_data.split(':')[1];
}

test('milestone: задача → v1 → правки → v2 → одобрение → решение в GitHub', { skip }, async () => {
  const designerPrompts: string[] = [];
  const designerUser: string[] = [];
  const critiqueImages: string[][] = [];
  const r = await rig({ hooks: { before: (req, meta) => {
    if (meta.role === 'senior-product-designer') { designerPrompts.push(req.system); designerUser.push(req.user); }
    if (meta.output === 'critique') critiqueImages.push((req.images ?? []).map((i) => `${i.format}:${i.label}`));
  } } });
  await send(r, update(1, OWNER, REQUEST));

  // Роль автора работает в почерке своих школ.
  assert.ok(designerPrompts.length > 0);
  assert.ok(designerPrompts.every((s) => s.includes('Основная школа — Дарья Калинина') && s.includes('PEROV-USUAL')));
  // Триаж пометил задачу тегом pickup: автор видит реальное окно, критики — фото владельца.
  assert.ok(designerUser.every((u) => u.includes('Реальное окно выдачи') && u.includes('Одно окно: заказ, оплата и выдача')));
  assert.ok(critiqueImages.length > 0 && critiqueImages.every((imgs) => imgs.some((l) => l.startsWith('jpeg:реальное окно DRIVE&KAVA'))));

  // Владелец получил одну карточку: экран + состояние, кнопки решения, ссылка на PR.
  assert.equal(r.tg.cards().length, 1);
  const card = r.tg.cards()[0];
  assert.equal(card.method, 'sendMediaGroup');
  assert.equal(card.files.length, 2);
  const caption = String((card.params.media as Array<{ caption?: string }>)[0].caption);
  assert.match(caption, /DRIVE&KAVA — .* · v1/);
  assert.match(caption, /github\.com\/test\/repo\/pull\/1/);
  assert.match(caption, /заглушки/); // честно: фото не генерировались
  const v1 = approvalFrom(r);
  assert.equal(r.gh.pulls.length, 1);
  assert.equal(r.gh.pulls[0].state, 'open');

  // Внутренняя работа не утекала владельцу: ни позиций, ни черновиков вариантов.
  assert.ok(!r.tg.texts().some((t) => /вариант b|вариант c/i.test(t)));
  const ini = (await r.app.studio.list())[0];
  assert.equal(ini.status, 'awaiting_owner');

  // Правки несколькими сообщениями и «Готово».
  await send(r, callback(2, OWNER, `a:${v1}:ch`));
  await send(r, update(3, OWNER, 'Уберите большую плашку снизу, сделайте кнопки прозрачнее,'));
  await send(r, update(4, OWNER, 'а сам напиток немного крупнее. Я вообще не люблю тяжёлые плашки.'));
  assert.ok(r.tg.calls.some((c) => c.method === 'setMessageReaction'));
  await send(r, callback(5, OWNER, `f:${v1}:done`));
  assert.ok(r.tg.texts().some((t) => t.includes('Принял правки') && t.includes('плашку') && t.includes('крупнее')));

  // v2 пришла, в том же PR, правки отмечены выполненными.
  assert.equal(r.tg.cards().length, 2);
  const caption2 = String((r.tg.cards()[1].params.media as Array<{ caption?: string }>)[0].caption);
  assert.match(caption2, /v2/);
  assert.match(caption2, /✓ Убрать большую плашку/);
  assert.match(caption2, /Школы: Перов: «Как обычно\?»/);
  assert.doesNotMatch(caption2, /НЕСУЩЕСТВУЮЩИЙ/); // выдуманный приём отброшен
  assert.equal(r.gh.pulls.length, 1);
  const v2 = approvalFrom(r);
  assert.notEqual(v1, v2);

  // Повторная доставка того же update_id ничего не делает.
  const before = r.tg.calls.length;
  await send(r, callback(5, OWNER, `f:${v1}:done`));
  assert.equal(r.tg.calls.length, before);

  // Устаревшая кнопка v1 не утверждает старую версию.
  await send(r, callback(6, OWNER, `a:${v1}:ok`));
  assert.ok(r.tg.texts().some((t) => /уже/.test(t)));
  assert.notEqual((await r.app.studio.get(ini.id)).status, 'approved');

  // Чужой пользователь не может ничего.
  await send(r, update(7, 999, '/new взломать'));
  await send(r, callback(8, 999, `a:${v2}:ok`));
  assert.equal((await r.app.studio.list()).length, 1);
  assert.notEqual((await r.app.studio.get(ini.id)).status, 'approved');

  // Одобрение v2: решение записано, PR влит, в основной ветке спецификация и решение.
  await send(r, callback(9, OWNER, `a:${v2}:ok`));
  const done = await r.app.studio.get(ini.id);
  assert.equal(done.status, 'approved');
  assert.ok(r.tg.texts().some((t) => t.includes('утверждено как дизайн-направление') && t.includes('Разработка и выпуск — отдельные этапы')));
  assert.equal(r.gh.pulls[0].merged, true);
  const main = [...r.gh.mainFiles().keys()];
  assert.ok(main.some((p) => p.startsWith('studio/decisions/DEC-')));
  assert.ok(main.includes(`studio/initiatives/${ini.id}/v2/spec.json`));
  assert.ok(main.every((p) => p === 'README.md' || p.startsWith('studio/')));
  const decision = r.gh.mainFiles().get(main.find((p) => p.startsWith('studio/decisions/'))!)!;
  assert.match(decision, /v2/);

  // Кандидат в предпочтения сохранён в реестре.
  const prefs = JSON.parse(await readFile(join(r.repo, 'studio/context/owner-preferences.json'), 'utf8'));
  assert.ok(prefs.version > 1);

  // Учёт денег: каждый вызов записан, сумма в пределах лимита инициативы.
  const s = await r.app.ledger.summary(ini.id);
  assert.ok(s.initiative!.spentUsd > 0 && s.initiative!.spentUsd < 5);
  await r.app.close();
});

test('сбой: основная модель недоступна → работает следующая, результат доставлен', { skip }, async () => {
  const r = await rig({ hooks: { before: (req) => { if (req.model.key === 'deepseek-v3.2') throw new ProviderError('unavailable', 403, "You don't have access to the model"); } } });
  await send(r, update(1, OWNER, REQUEST));
  assert.equal((await r.app.studio.list())[0].status, 'awaiting_owner');
  assert.ok(r.provider.calls.some((c) => c.model === 'gpt-5.6-luna' && c.output === 'position'));
  assert.ok(!r.provider.calls.some((c) => c.model === 'deepseek-v3.2'));
  await r.app.close();
});

test('сбой: все модели класса недоступны → пауза с причиной; после восстановления — продолжение без повторных вызовов', { skip }, async () => {
  let broken = true;
  const r = await rig({ hooks: { before: (_req, meta) => { if (broken && meta.output === 'brief') throw new ProviderError('retryable', 503, 'Service Unavailable'); } } });
  await send(r, update(1, OWNER, REQUEST));
  const ini = (await r.app.studio.list())[0];
  assert.equal(ini.status, 'paused');
  assert.match(ini.pauseReason!, /Нет доступной модели/);
  assert.equal(r.tg.texts().filter((t) => t.includes('на паузе')).length, 1);
  assert.equal(r.tg.cards().length, 0); // черновик не отправлен
  const positionsBefore = r.provider.calls.filter((c) => c.output === 'position').length;

  broken = false;
  await send(r, update(2, OWNER, `/resume ${ini.id}`));
  assert.equal((await r.app.studio.get(ini.id)).status, 'awaiting_owner');
  assert.equal(r.provider.calls.filter((c) => c.output === 'position').length, positionsBefore);
  assert.equal(r.provider.calls.filter((c) => c.output === 'triage').length, 1);
  await r.app.close();
});

test('сбой: падение процесса посреди конвейера → перезапуск продолжает с места остановки', { skip }, async () => {
  const r = await rig();
  const { initiative } = await r.app.studio.intake(REQUEST.replace('/new ', ''));
  r.app.studio.crashBefore = 'critique:0';
  const failed = await r.app.studio.run(initiative.id);
  assert.equal(failed.status, 'failed');
  const callsAfterCrash = r.provider.calls.length;
  const variants = r.provider.calls.filter((c) => c.output === 'screenVariant').length;
  assert.equal(variants, 3);

  // «Новый процесс»: другое приложение поверх тех же данных.
  const app2 = await createApp({ repoRoot: r.repo, dataDir: join(r.repo, '.studio-data'), mode: 'scripted', provider: r.provider, renderer, imageProvider: null, telegram: { token: 'T', ownerId: OWNER, fetchImpl: r.tg.fetch }, github: { token: 'G', repo: 'test/repo', fetchImpl: r.gh.fetch }, quiet: true });
  const resumed = await app2.studio.run(initiative.id);
  assert.equal(resumed.status, 'awaiting_owner');
  assert.equal(r.provider.calls.filter((c) => c.output === 'screenVariant').length, variants + 1); // +1 доработка, варианты не переделывались
  assert.ok(r.provider.calls.length > callsAfterCrash);
  assert.equal(r.tg.cards().length, 1);
  await r.app.close();
});

test('бюджет: лимит инициативы исчерпан → пауза, одно уведомление, лимит не превышен', { skip }, async () => {
  const r = await rig({ budget: { initiativeUsd: 0.006 } });
  await send(r, update(1, OWNER, REQUEST));
  const ini = (await r.app.studio.list())[0];
  assert.equal(ini.status, 'paused');
  assert.match(ini.pauseReason!, /Лимит «initiative» исчерпан/);
  assert.equal(r.tg.texts().filter((t) => t.includes('на паузе')).length, 1);
  assert.equal(r.tg.cards().length, 0);
  const s = await r.app.ledger.summary(ini.id);
  assert.ok(s.initiative!.spentUsd <= 0.006 + 1e-9);
  await r.app.close();
});

test('отклонение: причина сохраняется уроком, PR закрыт, следующий бриф видит отказ', { skip }, async () => {
  const prompts: string[] = [];
  const r = await rig({ hooks: { before: (req, meta) => { if (meta.output === 'position') prompts.push(req.user); } } });
  await send(r, update(1, OWNER, REQUEST));
  const v1 = approvalFrom(r);
  await send(r, callback(2, OWNER, `a:${v1}:rej`));
  await send(r, update(3, OWNER, 'Слишком тёмно и похоже на ночной клуб'));
  const ini = (await r.app.studio.list())[0];
  assert.equal(ini.status, 'rejected');
  assert.ok(existsSync(join(r.repo, `studio/lessons/LES-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${ini.id}.md`)));
  assert.equal(r.gh.pulls.find((p) => p.head === `studio/${ini.id}`)!.state, 'closed');
  assert.ok([...r.gh.mainFiles().keys()].some((p) => p.startsWith('studio/lessons/')));

  prompts.length = 0;
  await send(r, update(4, OWNER, '/new Главный экран: другой подход к поиску напитка, быстрее находить'));
  assert.ok(prompts.some((p) => p.includes('[REJECTED]') && p.includes('ночной клуб')), 'новые позиции видят причину отказа');
  await r.app.close();
});

test('Telegram недоступен при доставке → карточка ждёт в outbox и уходит ровно один раз', { skip }, async () => {
  const r = await rig();
  const { initiative } = await r.app.studio.intake(REQUEST.replace('/new ', ''));
  r.tg.failNext = 50;
  await r.app.studio.run(initiative.id);
  r.tg.failNext = 0;
  assert.equal(r.tg.cards().length, 0);
  const ini = await r.app.studio.get(initiative.id);
  assert.equal(ini.status, 'awaiting_owner'); // работа не потеряна, ждёт только доставка
  r.clock.offset += 60 * 60_000;
  await r.app.outbox.flush();
  r.clock.offset += 60 * 60_000;
  await r.app.outbox.flush();
  assert.equal(r.tg.cards().length, 1);
  await r.app.close();
});

test('фото: при подключённой генерации герой заменяется сгенерированным ассетом с метаданными и бюджетом генераций', { skip }, async () => {
  const repo = await tempRepo();
  const { ScriptedImages } = await import('../src/llm/scripted.ts');
  const app = await createApp({ repoRoot: repo, dataDir: join(repo, '.studio-data'), mode: 'scripted', renderer, imageProvider: new ScriptedImages(), telegram: null, github: null, quiet: true });
  const { initiative } = await app.studio.intake(REQUEST.replace('/new ', ''));
  const done = await app.studio.run(initiative.id);
  assert.equal(done.status, 'awaiting_owner');
  const delivered = await app.store.get<{ photo: string; spec: { nodes: Array<{ id: string; kind: string; asset?: string }> } }>('delivered', `${initiative.id}-v1`);
  assert.equal(delivered!.photo, 'generated');
  const hero = delivered!.spec.nodes.find((n) => n.id === 'hero')!;
  assert.equal(hero.kind, 'image');
  const asset = await app.store.get<{ model: string; prompt: string; rights: string }>('assets', hero.asset!);
  assert.equal(asset!.model, 'stable-image-ultra');
  assert.equal(asset!.rights, 'generated-bedrock');
  const ledger = await app.store.get<{ entries: Array<{ category: string }> }>('ledger', new Date().toISOString().slice(0, 7));
  assert.ok(ledger!.entries.some((e) => e.category === 'image'));
  await app.close();
});

test('вебхук: без секрета Telegram — 401', { skip }, async () => {
  const r = await rig();
  assert.equal((await handleWebhook({ headers: {}, body: '{}' }, r.app.bot!, 'secret')).statusCode, 401);
  assert.equal((await handleWebhook({ headers: { 'x-telegram-bot-api-secret-token': 'secret' }, body: JSON.stringify(update(1, OWNER, '/help')) }, r.app.bot!, 'secret')).statusCode, 200);
  assert.ok(r.tg.texts().some((t) => t.includes('/new')));
  await r.app.close();
});

test('GitHub: бот не пишет вне studio/ и не вливает PR с кодом', async () => {
  const gh = new FakeGitHub();
  const policy = JSON.parse(await readFile(join(REPO, 'studio/policies/approvals.json'), 'utf8'));
  const pub = new Publisher(new GitHubApi('G', 'test/repo', { fetchImpl: gh.fetch }), policy);
  await assert.rejects(pub.commitFiles('main', [{ path: 'src/app.ts', content: 'x' }], 'нельзя'), PolicyViolation);
  // PR, в котором кто-то изменил код, не вливается автоматически даже после одобрения.
  gh.refs.set('studio/x', gh.refs.get('main')!);
  await pub.commitFiles('studio/x', [{ path: 'studio/a.md', content: 'ok' }], 'ok');
  const head = gh.commits.get(gh.refs.get('studio/x')!)!;
  head.tree.set('src/evil.ts', 'код');
  gh.pulls.push({ number: 1, head: 'studio/x', base: 'main', title: 't', body: '', state: 'open', merged: false, html_url: 'u', labels: [] });
  await assert.rejects(pub.mergeGuarded(1, 'merge'), PolicyViolation);
  assert.equal(gh.pulls[0].merged, false);
});
