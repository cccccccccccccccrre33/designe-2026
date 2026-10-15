import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ScreenRenderer, findBrowser, type Measurements } from '../src/render/renderer.ts';
import { validateSpec, type Tokens } from '../src/render/spec.ts';
import { runChecks } from '../src/review/checks.ts';
import { variantA, variantB, variantC } from '../src/llm/fixtures.ts';
import { PreferenceRegistry, decisionFile } from '../src/memory/memory.ts';
import { springFromDurationBounce } from '../src/science/spring.ts';
import { estimateEta, erlangC } from '../src/science/queueing.ts';
import { RoleBook, REQUIRED_FIELDS } from '../src/agents/roles.ts';
import { KnowledgeBase } from '../src/knowledge/base.ts';
import { REPO, tempRepo } from './helpers.ts';

const tokens = JSON.parse(await readFile(join(REPO, 'design-system/tokens.json'), 'utf8')) as Tokens;
const ctx = { allowedLatin: new Set(['drive', 'kava', 'lab']), ownerHardChecks: new Set(['hero-occlusion', 'promo-banner-size', 'background-variety', 'ukrainian-only']) };
const renderer = new ScreenRenderer(tokens, join(REPO, 'design-system'));
after(() => renderer.close());
const browser = findBrowser();

test('Screen Spec: валидатор ловит не-токены и битые ссылки', () => {
  assert.deepEqual(validateSpec(variantA('initial', 'a'), tokens), []);
  const bad = variantA('initial', 'a');
  bad.nodes[0].fill = '#ff0000';
  bad.states = [{ id: 's', label: 's', patches: [{ nodeId: 'нет-такого', set: {} }] }];
  const errs = validateSpec(bad, tokens);
  assert.ok(errs.some((e) => e.includes('не токен')));
  assert.ok(errs.some((e) => e.includes('не найден')));
});

test('рендер + автопроверки: хороший вариант проходит, плохие ловятся фактами', { skip: !browser && 'нет Chrome/Edge' }, async () => {
  const a = await renderer.render(variantA('initial', 'a'), { scale: 1 });
  const ra = runChecks(variantA('initial', 'a'), a.measurements, ctx);
  assert.equal(ra.filter((r) => !r.passed && r.severity === 'blocking').length, 0, JSON.stringify(ra.filter((r) => !r.passed)));
  assert.equal(a.png.subarray(1, 4).toString(), 'PNG');

  const b = await renderer.render(variantB('b'), { scale: 1 });
  const rb = runChecks(variantB('b'), b.measurements, ctx);
  assert.equal(rb.find((r) => r.id === 'promo-banner-size')!.passed, false);
  assert.equal(rb.find((r) => r.id === 'promo-banner-size')!.severity, 'blocking'); // жёсткое предпочтение владельца

  const c = await renderer.render(variantC('c'), { scale: 1 });
  const rc = runChecks(variantC('c'), c.measurements, ctx);
  const contrast = rc.find((r) => r.id === 'contrast-text')!;
  assert.ok(contrast.findings.some((f) => f.nodeId === 'cta'), 'белый текст на оранжевом не проходит AA');
  assert.ok(rc.find((r) => r.id === 'ukrainian-only')!.findings.some((f) => f.message.includes('окно')));
  assert.ok(rc.find((r) => r.id === 'single-window')!.findings.some((f) => f.nodeId === 'window-title'), 'у DRIVE&KAVA одно окно — номер окна ловится');
  assert.equal(ra.find((r) => r.id === 'no-online-payment')!.passed, true);
});

// Измерения без браузера: проверки текста зависят только от текста, роли и видимости.
function textOnly(items: Array<{ id: string; text: string; button?: boolean }>): Measurements {
  return {
    width: 393, height: 852, safeTop: 59, safeBottom: 34, heroZone: null,
    nodes: items.map((it, i) => ({
      id: it.id, kind: it.button ? 'button' : 'text', role: it.button ? 'primary-action' : null, rect: { x: 20, y: 120 + i * 60, w: 353, h: 48 },
      text: it.text, fontSize: 16, fontWeight: 600, color: [35, 35, 35, 1], bgAlpha: 0, effectiveOpacity: 1, glass: false,
      paintsAfterHero: false, isHeroOrInside: false, overflow: false, inScroll: false, contrast: null,
    })),
  };
}
const emptySpec = { ...variantA('initial', 'pay'), nodes: [] };
const failing = (items: Parameters<typeof textOnly>[0], id: string) => runChecks(emptySpec, textOnly(items), ctx).find((r) => r.id === id)!.findings.map((f) => f.nodeId);

test('автопроверка: оплаты в приложении нет — только выбор «Готівкою» / «Карткою» (PREF-008)', () => {
  assert.deepEqual(failing([
    { id: 'pay-btn', text: 'Оплатити · 85 ₴', button: true },
    { id: 'gpay', text: 'Apple Pay або Google Pay' },
    { id: 'card', text: 'Номер картки' },
    { id: 'prepay', text: 'Передоплата 50%' },
    { id: 'status', text: 'Замовлення оплачено' },
  ], 'no-online-payment'), ['pay-btn', 'gpay', 'card', 'prepay', 'status']);
  assert.deepEqual(failing([
    { id: 'order-btn', text: 'Замовити · 85 ₴', button: true },
    { id: 'method', text: 'Як оплатите у вікні: готівкою чи карткою?' },
    { id: 'sum', text: 'До сплати у вікні: 120 ₴' },
    { id: 'pay-site', text: 'Оплатити на місці', button: true },
    // Владелец: терминал подают из окна, гость прикладывает карту или телефон.
    { id: 'terminal', text: 'Термінал подамо у вікно — прикладіть картку або телефон' },
    { id: 'phone-pay', text: 'Apple Pay і Google Pay — на терміналі у вікні' },
  ], 'no-online-payment'), []);
  const owner = runChecks(emptySpec, textOnly([{ id: 'pay-btn', text: 'Оплатити', button: true }]), { ...ctx, ownerHardChecks: new Set(['no-online-payment']) });
  assert.equal(owner.find((r) => r.id === 'no-online-payment')!.source, 'owner-preference');
});

test('автопроверка: окно одно — без номеров окна (PREF-009)', () => {
  assert.deepEqual(failing([
    { id: 'n1', text: "Під'їжджайте до вікна №1" },
    { id: 'n2', text: 'Друге вікно — видача' },
    { id: 'ok1', text: 'Заберіть у вікні 8:15–8:20' },
    { id: 'ok2', text: 'Покажіть у вікні номер #48' },
    { id: 'ok3', text: 'Вікно drive&kava — праворуч у кінці фасаду' },
  ], 'single-window'), ['n1', 'n2']);
});

test('автопроверка: непрозрачная плашка поверх напитка — блок', { skip: !browser && 'нет Chrome/Edge' }, async () => {
  const spec = variantA('initial', 'occ');
  spec.nodes.push({ id: 'banner', kind: 'box', fill: 'color.paper', frame: { x: 40, y: 300, w: 320, h: 120 } });
  const res = await renderer.render(spec, { scale: 1 });
  const occ = runChecks(spec, res.measurements, ctx).find((r) => r.id === 'hero-occlusion')!;
  assert.equal(occ.passed, false);
  assert.equal(occ.findings[0].nodeId, 'banner');
});

test('память: кандидат становится правилом при повторе, новое указание заменяет старое', async () => {
  const root = await tempRepo();
  const prefs = new PreferenceRegistry(root, { now: () => Date.parse('2026-10-15T10:00:00Z') });
  const c = [{ statement: 'Без тяжёлых непрозрачных плашек внизу экрана', scope: 'visual', strength: 'soft' as const }];
  assert.equal((await prefs.addCandidates(c, 'не люблю плашки', 'i1')).promoted.length, 0);
  const second = await prefs.addCandidates([{ ...c[0], statement: 'Никаких тяжёлых непрозрачных плашек внизу' }], 'опять плашка', 'i2');
  assert.equal(second.promoted.length, 1);
  const { pref } = await prefs.supersede('PREF-002', 'Небольшой промо-блок на главной допустим, если он не выше 15% экрана', 'передумал про баннеры');
  const file = await prefs.load();
  assert.equal(file.preferences.find((p) => p.id === 'PREF-002')!.status, 'superseded');
  assert.equal(file.preferences.find((p) => p.id === 'PREF-002')!.supersededBy, pref.id);
  assert.equal((await prefs.hardCheckIds()).has('promo-banner-size'), false);
});

test('память: запись решения содержит хэш версии и границу полномочий', () => {
  const f = decisionFile({ id: 'DEC-1', initiativeId: 'i', title: 'Главная', version: 2, decision: 'approved', date: '2026-10-15', artifactHash: 'abc', summary: 'Ваш ранок' });
  assert.ok(String(f.content).includes('`abc`'));
  assert.ok(String(f.content).includes('не разрешает разработку'));
});

test('роли: у каждой роли заполнены все 13 полей профиля, ссылки на роли существуют', async () => {
  const book = await RoleBook.load(join(REPO, 'studio/org/roles'));
  assert.ok(book.all().length >= 40);
  for (const r of book.all()) {
    for (const f of REQUIRED_FIELDS) assert.ok(r[f] !== undefined, `${r.id}: нет поля ${f}`);
    for (const h of r.handoffRules) assert.ok(book.has(h.to), `${r.id}: передача несуществующей роли ${h.to}`);
  }
  assert.equal(book.all().filter((r) => r.status === 'core').length, 13); // 7 ядро + 6 ролей фото- и видеопродакшена
  const casting = JSON.parse(await readFile(join(REPO, 'studio/org/casting.json'), 'utf8'));
  for (const t of Object.values(casting.types) as Array<{ author: string; critics: string[] }>) assert.ok(!t.critics.includes(t.author), 'автор не критикует свои варианты');
});

test('база знаний: поиск находит метод по теме, тир виден', async () => {
  const kb = await KnowledgeBase.load(REPO, ['knowledge/sources', 'knowledge/methods']);
  const hits = kb.search('время ожидания заказа интервал', { k: 3 });
  assert.ok(hits.some((h) => h.id === 'M-HONEST-ETA' || h.id === 'SRC-DR-ETA'));
  assert.ok(kb.chunks.every((c) => ['A', 'B', 'C', 'D', 'M'].includes(c.tier)));
});

test('пружины: ζ = 1 − bounce, без перелёта при bounce 0', () => {
  const crisp = springFromDurationBounce(0.4, 0);
  assert.ok(Math.abs(crisp.dampingRatio - 1) < 1e-6);
  assert.ok(crisp.overshootPct < 0.5);
  const hero = springFromDurationBounce(0.45, 0.2);
  assert.ok(Math.abs(hero.dampingRatio - 0.8) < 1e-6);
  assert.ok(hero.overshootPct > 0.5);
  assert.ok(hero.cssEasing.startsWith('linear(0'));
});

test('очередь: больше бариста — меньше ожидание; длиннее очередь — дольше; интервал P50–P90', () => {
  const order = [{ baseSec: 150 }];
  const queue = Array.from({ length: 4 }, () => [{ baseSec: 120 }, { baseSec: 90 }]);
  const one = estimateEta({ baristas: 1, queue, order });
  const two = estimateEta({ baristas: 2, queue, order });
  const empty = estimateEta({ baristas: 1, queue: [], order });
  assert.ok(two.p50Min < one.p50Min);
  assert.ok(empty.p50Min < one.p50Min);
  assert.ok(one.p90Min >= one.p50Min);
  assert.match(one.display, /^\d+–\d+ хв$/);
  assert.ok(erlangC(1, 1.5, 1) > erlangC(1, 1.5, 2));
});
