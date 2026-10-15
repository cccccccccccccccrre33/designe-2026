// Задание study: чтение ссылок школ, выводы только с цитатой со страницы.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { KnowledgeBase } from '../src/knowledge/base.ts';
import { fetchPage, formatStudySummary, htmlToText, quoteOnPage, readableUrl, runStudy, studyTargets } from '../src/knowledge/study.ts';
import { REPO, tempRepo } from './helpers.ts';

const criteria = JSON.parse(await readFile(join(REPO, 'studio/org/rubric.json'), 'utf8')).criteria.map((c: { id: string }) => c.id);

test('изучение: все ссылки владельца попадают в список, Telegram читается через веб-превью', async () => {
  const app = await createApp({ repoRoot: REPO, mode: 'scripted', provider: new ScriptedProvider(criteria), renderer: { render: async () => { throw new Error('не нужен'); } }, imageProvider: null, telegram: null, github: null, quiet: true, dataDir: join(await tempRepo(), '.d') });
  const targets = await studyTargets(app.studio.d.practitioners!, REPO);
  const urls = new Set(targets.map((t) => t.url));
  assert.ok(targets.length >= 170, `ссылок ${targets.length}`);
  assert.ok(urls.has('https://dribbble.com/shots/27413072-Drinkit-Lab-AI-Drink-Generation'));
  assert.equal(targets.find((t) => t.url === 'https://t.me/orlovsdev')?.practitioner, 'orlov');
  assert.equal(readableUrl('https://t.me/orlovsdev'), 'https://t.me/s/orlovsdev');
  assert.equal(readableUrl('https://t.me/s/orlovsdev?before=5'), 'https://t.me/s/orlovsdev?before=5');
  await app.close();
});

test('изучение: HTML в текст, стена входа и пустые страницы — «не прочитано»', async () => {
  assert.equal(htmlToText('<meta property="og:description" content="Сет-дизайн &laquo;Drinkit&raquo;"><script>x()</script><p>Голубые&nbsp;градиенты</p>'), 'Сет-дизайн «Drinkit»\nГолубые градиенты');
  const fake = (body: string, status = 200, type = 'text/html') => (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
  assert.deepEqual(await fetchPage('https://x.test/a', fake('', 404)), { ok: false, reason: 'HTTP 404' });
  assert.match((await fetchPage('https://x.test/a', fake('<p>Sign in to LinkedIn</p>'.repeat(30))) as { reason: string }).reason, /входа/);
  assert.match((await fetchPage('https://x.test/a', fake('<div id=root></div>')) as { reason: string }).reason, /пустая/);
  assert.ok(quoteOnPage('«Голубые градиенты»', 'фон: голубые   градиенты и стекло'));
  assert.ok(!quoteOnPage('коротко', 'коротко'));
});

test('изучение: выводы без цитаты со страницы отбрасываются, недоступное записывается, файл попадает в базу знаний', async () => {
  const repo = await tempRepo();
  const provider = new ScriptedProvider(criteria);
  const app = await createApp({ repoRoot: repo, mode: 'scripted', provider, renderer: { render: async () => { throw new Error('не нужен'); } }, imageProvider: null, telegram: null, github: null, quiet: true, dataDir: join(repo, '.d') });
  const page = `<html><head><meta name="description" content="Set design for Drinkit"></head><body><p>${'Мы строим каждую сцену вокруг вкуса напитка и прозрачных материалов. '.repeat(8)}</p></body></html>`;
  const fetchImpl = (async (url: string) => (String(url).includes('behance')
    ? new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    : new Response('nope', { status: 403 }))) as unknown as typeof fetch;
  const targets = [
    { practitioner: 'priadko', url: 'https://www.behance.net/gallery/210009497/Set-design-for-Drinkit' },
    { practitioner: 'priadko', url: 'https://www.instagram.com/x/' },
  ];
  const results = await runStudy({ router: app.router, book: app.studio.d.practitioners!, roles: app.studio.d.roles, repoRoot: repo, fetchImpl, date: '2026-10-15' }, targets);
  const [r] = results;
  assert.deepEqual(r.read, [targets[0].url]);
  assert.deepEqual(r.blocked, [{ url: targets[1].url, reason: 'HTTP 403' }]);
  assert.equal(r.likes.length, 1);
  assert.equal(r.dropped, 1, 'вывод без цитаты на странице отброшен');
  const md = await readFile(join(repo, 'knowledge/study/priadko.md'), 'utf8');
  assert.match(md, /Ценит:\n- ценит ясную структуру — «/);
  assert.doesNotMatch(md, /этой цитаты на странице нет/);
  assert.match(md, /не прочитано автоматически[\s\S]*instagram[\s\S]*HTTP 403/);
  const kb = await KnowledgeBase.load(repo, ['knowledge/study']);
  assert.ok(kb.get('ST-priadko')?.tags.includes('taste'));
  assert.match(formatStudySummary(results, 0.01), /Прочитано страниц: 1, недоступно: 1/);
  assert.equal(provider.calls.filter((c) => c.output === 'studyNotes').length, 1, 'недоступная страница модель не тратит');
  await app.close();
});
