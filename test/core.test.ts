import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate, type Schema } from '../src/core/schema.ts';
import { extractJson } from '../src/core/json.ts';
import { BudgetLedger, type BudgetPolicy } from '../src/budget/ledger.ts';
import { FileStore } from '../src/store/store.ts';
import { StepJournal } from '../src/pipeline/engine.ts';
import { Outbox } from '../src/pipeline/outbox.ts';
import { BudgetExceeded } from '../src/core/errors.ts';

const schema: Schema = { type: 'object', required: ['verdict', 'score'], properties: { verdict: { type: 'string', enum: ['approve', 'reject'] }, score: { type: 'number', minimum: 1, maximum: 5 }, tags: { type: 'array', items: { type: 'string' }, maxItems: 2 } } };

test('схема: валидный и невалидный ответ', () => {
  assert.deepEqual(validate(schema, { verdict: 'approve', score: 4 }), []);
  const errs = validate(schema, { verdict: 'APPROVE maybe', score: 7, tags: ['a', 'b', 'c'] });
  assert.equal(errs.length, 3);
});

test('extractJson: забор, <think>, текст вокруг', () => {
  assert.deepEqual(extractJson('<think>хм {нет}</think>Вот ответ:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Итог: {"a": "скобка } в строке", "b": [1,2]} спасибо'), { a: 'скобка } в строке', b: [1, 2] });
  assert.throws(() => extractJson('без JSON'));
});

const policy = (): BudgetPolicy => ({
  limits: { initiativeUsd: 1, dailyUsd: 2, monthlyUsd: 10, imagePerInitiativeUsd: 0.2, premiumMonthlyUsd: 0.5, autonomousMonthlyShare: 0.2 },
  thresholds: [0.5, 0.8, 0.95],
  process: { maxLlmCallsPerInitiative: 3, maxVariants: 3, maxCritiqueRounds: 2, maxRefineIterations: 2, maxPositions: 5, parallelism: 3 },
});

async function ledger(now = Date.parse('2026-10-15T10:00:00Z')) {
  const store = new FileStore(await mkdtemp(join(tmpdir(), 'dk-ledger-')));
  return new BudgetLedger(store, policy(), { now: () => now });
}

test('бюджет: резерв не превышает лимит инициативы, отказ — BudgetExceeded', async () => {
  const l = await ledger();
  const r = await l.reserve({ initiativeId: 'i1', category: 'llm', amountUsd: 0.6, autonomous: false });
  await assert.rejects(l.reserve({ initiativeId: 'i1', category: 'llm', amountUsd: 0.5, autonomous: false }), (e: unknown) => e instanceof BudgetExceeded && e.scope === 'initiative');
  await l.settle(r.id, 0.1); // фактически дешевле — освобождает место
  await l.reserve({ initiativeId: 'i1', category: 'llm', amountUsd: 0.5, autonomous: false });
});

test('бюджет: параллельные резервы атомарны', async () => {
  const l = await ledger();
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => l.reserve({ initiativeId: `p${i}`, category: 'llm', amountUsd: 0.3, autonomous: false })));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 6); // 6 × 0.3 = 1.8 ≤ 2 (дневной лимит), седьмой уже не помещается
});

test('бюджет: изображения, premium, автономные и число вызовов ограничены отдельно', async () => {
  const l = await ledger();
  await l.reserve({ initiativeId: 'i', category: 'image', amountUsd: 0.15, autonomous: false });
  await assert.rejects(l.reserve({ initiativeId: 'i', category: 'image', amountUsd: 0.1, autonomous: false }), (e: unknown) => (e as BudgetExceeded).scope === 'image');
  await assert.rejects(l.reserve({ initiativeId: 'x', category: 'premium', amountUsd: 0.6, autonomous: false }), (e: unknown) => (e as BudgetExceeded).scope === 'premium');
  for (let i = 0; i < 3; i++) await l.reserve({ initiativeId: 'c', category: 'llm', amountUsd: 0.01, autonomous: false });
  await assert.rejects(l.reserve({ initiativeId: 'c', category: 'llm', amountUsd: 0.01, autonomous: false }), (e: unknown) => (e as BudgetExceeded).scope === 'calls');

  const p = policy();
  Object.assign(p.limits, { dailyUsd: 100, monthlyUsd: 10, autonomousMonthlyShare: 0.1 });
  const auto = new BudgetLedger(new FileStore(await mkdtemp(join(tmpdir(), 'dk-auto-'))), p, { now: () => Date.now() });
  await auto.reserve({ initiativeId: 'a1', category: 'llm', amountUsd: 0.6, autonomous: true });
  await assert.rejects(auto.reserve({ initiativeId: 'a2', category: 'llm', amountUsd: 0.6, autonomous: true }), (e: unknown) => (e as BudgetExceeded).scope === 'autonomous');
  await auto.reserve({ initiativeId: 'o1', category: 'llm', amountUsd: 0.6, autonomous: false }); // задачи владельца не ограничены автономной квотой
});

test('бюджет: пороги 50/80/95% сообщаются по одному разу, уровень растёт', async () => {
  const l = await ledger();
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await l.reserve({ initiativeId: `t${i}`, category: 'llm', amountUsd: 0.5, autonomous: false });
    for (const a of await l.settle(r.id, 0.48)) if (a.scope === 'day') seen.push(a.threshold);
  }
  assert.deepEqual(seen, [0.5, 0.8, 0.95]);
  assert.equal(await l.level(), 'critical');
});

test('журнал шагов: выполненный шаг не исполняется повторно', async () => {
  const store = new FileStore(await mkdtemp(join(tmpdir(), 'dk-j-')));
  let calls = 0;
  const j1 = new StepJournal(store, { now: Date.now }, 'run');
  assert.equal(await j1.step('a', async () => ++calls), 1);
  const j2 = new StepJournal(store, { now: Date.now }, 'run');
  assert.equal(await j2.step('a', async () => ++calls), 1);
  assert.equal(calls, 1);
});

test('outbox: идемпотентная постановка, ретрай после сбоя, без дублей', async () => {
  const store = new FileStore(await mkdtemp(join(tmpdir(), 'dk-o-')));
  let now = 0;
  const outbox = new Outbox(store, { now: () => now });
  let attempts = 0;
  let delivered = 0;
  outbox.on('x', async () => {
    attempts++;
    if (attempts === 1) throw new Error('сеть');
    delivered++;
  });
  await outbox.enqueue('k1', 'x', {});
  await outbox.enqueue('k1', 'x', {});
  assert.equal((await outbox.flush()).delivered, 0);
  assert.equal((await outbox.flush()).delivered, 0); // пауза ещё не прошла
  now += 10_000;
  assert.equal((await outbox.flush()).delivered, 1);
  now += 10_000;
  await outbox.flush();
  assert.equal(delivered, 1);
});
