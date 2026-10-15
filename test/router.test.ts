import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/budget/ledger.ts';
import { ModelRouter } from '../src/llm/router.ts';
import { BedrockRuntime, mapError } from '../src/llm/bedrock.ts';
import { FileStore } from '../src/store/store.ts';
import { BudgetExceeded, ModelChainExhausted, ProviderError } from '../src/core/errors.ts';
import type { ChatRequest, LlmProvider, ModelRegistryConfig } from '../src/llm/types.ts';
import type { Schema } from '../src/core/schema.ts';
import { REPO } from './helpers.ts';

const schema: Schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };

async function setup(behaviour: (req: ChatRequest) => string, limits?: Partial<{ initiativeUsd: number }>) {
  const config = JSON.parse(await readFile(join(REPO, 'studio/policies/models.json'), 'utf8')) as ModelRegistryConfig;
  config.retry.retryDelayMs = 1;
  const budget = JSON.parse(await readFile(join(REPO, 'studio/policies/budget.json'), 'utf8'));
  Object.assign(budget.limits, limits ?? {});
  const store = new FileStore(await mkdtemp(join(tmpdir(), 'dk-r-')));
  const clock = { now: () => Date.now() };
  const ledger = new BudgetLedger(store, budget, clock);
  const seen: string[] = [];
  const provider: LlmProvider = {
    async chat(req) {
      seen.push(req.model.key);
      return { text: behaviour(req), usage: { inputTokens: 1000, outputTokens: 200 }, latencyMs: 1 };
    },
  };
  const router = new ModelRouter({ config, provider, ledger, store, clock });
  return { router, seen, ledger, store };
}

const base = { initiativeId: 'i', role: 'studio-director', autonomous: false, system: 's', user: 'u', schema, maxTokens: 100 };

test('маршрутизатор: начинает с самой дешёвой модели класса', async () => {
  const { router, seen } = await setup(() => '{"ok":true}');
  const r = await router.complete<{ ok: boolean }>({ ...base, taskClass: 'classify' });
  assert.equal(r.model, 'glm-4.7-flash');
  assert.deepEqual(seen, ['glm-4.7-flash']);
});

test('маршрутизатор: недоступная модель → следующий кандидат и circuit breaker', async () => {
  const { router, seen } = await setup((req) => {
    if (req.model.key === 'glm-4.7-flash') throw new ProviderError('unavailable', 404, 'model not found');
    return '{"ok":true}';
  });
  const r = await router.complete({ ...base, taskClass: 'classify' });
  assert.equal(r.model, 'nova-micro');
  await router.complete({ ...base, taskClass: 'classify' });
  assert.deepEqual(seen, ['glm-4.7-flash', 'nova-micro', 'nova-micro']); // вторая попытка уже без недоступной модели
});

test('маршрутизатор: временная ошибка — один повтор той же модели', async () => {
  let n = 0;
  const { router, seen } = await setup(() => {
    if (n++ === 0) throw new ProviderError('retryable', 429, 'throttled');
    return '{"ok":true}';
  });
  await router.complete({ ...base, taskClass: 'classify' });
  assert.deepEqual(seen, ['glm-4.7-flash', 'glm-4.7-flash']);
});

test('маршрутизатор: невалидный JSON → одна попытка ремонта, затем другая модель', async () => {
  const { router, seen } = await setup((req) => (req.model.key === 'glm-4.7-flash' ? '{"ok":"да"}' : '{"ok":true}'));
  const r = await router.complete({ ...base, taskClass: 'classify' });
  assert.equal(r.model, 'nova-micro');
  assert.deepEqual(seen, ['glm-4.7-flash', 'glm-4.7-flash', 'nova-micro']);
  assert.ok(r.attempts.some((a) => a.outcome === 'invalid_json'));
});

test('маршрутизатор: дополнительная проверка (check) работает как схема', async () => {
  let n = 0;
  const { router } = await setup(() => (n++ === 0 ? '{"ok":false}' : '{"ok":true}'));
  const r = await router.complete<{ ok: boolean }>({ ...base, taskClass: 'classify', check: (v) => ((v as { ok: boolean }).ok ? [] : ['ok должен быть true']) });
  assert.equal(r.value.ok, true);
});

test('маршрутизатор: все модели упали → ModelChainExhausted', async () => {
  const { router } = await setup(() => { throw new ProviderError('unavailable', 403, 'You don\'t have access to the model'); });
  await assert.rejects(router.complete({ ...base, taskClass: 'classify' }), ModelChainExhausted);
});

test('маршрутизатор: критик из другого семейства, чем автор', async () => {
  const { router } = await setup(() => '{"ok":true}');
  const c = router.candidates({ taskClass: 'critique', system: 's', user: 'u', images: [{ format: 'png', base64: 'x' }], avoidFamily: 'moonshot' });
  assert.notEqual(c.usable[0].family, 'moonshot');
  assert.ok(c.skipped.some((s) => s.reason.includes('семейство')));
});

test('маршрутизатор: модели без цены и без поддержки изображений пропускаются', async () => {
  const { router } = await setup(() => '{"ok":true}');
  const c = router.candidates({ taskClass: 'critique', system: 's', user: 'u', images: [{ format: 'png', base64: 'x' }] });
  assert.ok(c.skipped.some((s) => s.key === 'claude-haiku-5.5' && s.reason.includes('цена')));
  assert.ok(c.usable.every((m) => m.input.includes('image')));
});

test('маршрутизатор: бюджет исчерпан — отказ до вызова модели', async () => {
  const { router, seen } = await setup(() => '{"ok":true}', { initiativeUsd: 0.00001 });
  await assert.rejects(router.complete({ ...base, taskClass: 'position', maxTokens: 4000 }), BudgetExceeded);
  assert.equal(seen.length, 0);
});

test('маршрутизатор: premium-арбитр только с причиной', async () => {
  const { router } = await setup(() => '{"ok":true}');
  await assert.rejects(router.complete({ ...base, taskClass: 'arbiter' }), /причину/);
  const r = await router.complete({ ...base, taskClass: 'arbiter', reason: 'спор лидеров' });
  assert.equal(r.model, 'claude-sonnet-4.6');
});

test('Bedrock: формат запроса Converse и разбор ответа', async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fake: typeof fetch = async (url, init) => {
    captured = { url: String(url), init: init! };
    return new Response(JSON.stringify({ output: { message: { content: [{ reasoningContent: {} }, { text: '{"ok":true}' }] } }, usage: { inputTokens: 12, outputTokens: 3 }, stopReason: 'end_turn', metrics: { latencyMs: 50 } }), { status: 200 });
  };
  const b = new BedrockRuntime({ apiKey: 'test-key', fetchImpl: fake });
  const res = await b.chat({ model: { key: 'k', modelId: 'us.amazon.nova-2-lite-v1:0', kind: 'text', family: 'amazon', input: ['text', 'image'], price: null, enabled: true }, region: 'us-west-2', system: 'sys', user: 'hi', images: [{ format: 'png', base64: 'AAA', label: 'вариант a' }], maxTokens: 50 });
  assert.equal(res.text, '{"ok":true}');
  assert.equal(res.usage.inputTokens, 12);
  assert.equal(captured!.url, 'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.amazon.nova-2-lite-v1%3A0/converse');
  assert.equal((captured!.init.headers as Record<string, string>).authorization, 'Bearer test-key');
  const body = JSON.parse(String(captured!.init.body));
  assert.equal(body.system[0].text, 'sys');
  assert.equal(body.messages[0].content[2].image.source.bytes, 'AAA');
  assert.equal(body.inferenceConfig.maxTokens, 50);
});

test('Bedrock: коды ошибок → поведение маршрутизатора', () => {
  assert.equal(mapError(429, 'ThrottlingException', '').kind, 'retryable');
  assert.equal(mapError(503, '', '').kind, 'retryable');
  assert.equal(mapError(404, 'ResourceNotFoundException', '').kind, 'unavailable');
  assert.equal(mapError(403, 'AccessDeniedException', "You don't have access to the model with the specified model ID.").kind, 'unavailable');
  assert.equal(mapError(403, 'AccessDeniedException', 'Invalid token').kind, 'auth');
  assert.equal(mapError(400, 'ValidationException', '').kind, 'bad_request');
});

test('Bedrock: генерация изображения Stability и фильтр', async () => {
  let body: Record<string, unknown> = {};
  const fake: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init!.body));
    return new Response(JSON.stringify(body.prompt === 'bad' ? { images: [], finish_reasons: ['Filter reason: prompt'] } : { images: ['QUJD'], seeds: [42], finish_reasons: [null] }), { status: 200 });
  };
  const b = new BedrockRuntime({ apiKey: 'k', fetchImpl: fake });
  const model = { key: 'core', modelId: 'stability.stable-image-core-v1:1', kind: 'image' as const, family: 'stability', input: ['text' as const], price: null, enabled: true };
  const img = await b.generate({ model, region: 'us-west-2', prompt: 'flat white', aspectRatio: '4:5', negativePrompt: 'text' });
  assert.equal(img.seed, 42);
  assert.equal(body.aspect_ratio, '4:5');
  assert.equal(body.negative_prompt, 'text');
  await assert.rejects(b.generate({ model, region: 'us-west-2', prompt: 'bad', aspectRatio: '1:1' }), /отфильтровано/);
});
