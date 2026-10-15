// Сравнительное тестирование моделей на эталонных задачах DRIVE&KAVA
// (studio/evals/tasks.json). Результат — studio/evals/results.json: маршрутизатор
// использует оценки при выборе модели. Роли при смене модели не меняются (ADR-0006).

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSystem, buildUser } from '../agents/prompt.ts';
import { PractitionerBook } from '../agents/practitioners.ts';
import { RoleBook } from '../agents/roles.ts';
import * as S from '../agents/schemas.ts';
import { BudgetLedger } from '../budget/ledger.ts';
import { env, loadConfig } from '../config/load.ts';
import { extractJson } from '../core/json.ts';
import { validate, type Schema } from '../core/schema.ts';
import { round, systemClock } from '../core/util.ts';
import { BedrockRuntime } from '../llm/bedrock.ts';
import { variantA, variantB, variantC } from '../llm/fixtures.ts';
import { ScriptedProvider } from '../llm/scripted.ts';
import type { ImagePart, LlmProvider, TaskClass } from '../llm/types.ts';
import { ScreenRenderer } from '../render/renderer.ts';
import { specGuide, validateSpec, walk, type ScreenSpec } from '../render/spec.ts';
import { FileStore } from '../store/store.ts';

interface EvalTask {
  id: string;
  title: string;
  taskClass: TaskClass;
  role: string;
  output: string;
  fixture?: string;
  prompt: string;
  checks: Array<{ type: string; patterns?: string[]; winner?: string; min?: number; max?: number }>;
}

export async function runEval(opts: { repoRoot: string; taskClass?: string; models?: string[]; scripted?: boolean }): Promise<{ table: string; scores: Record<string, Record<string, number>> }> {
  const config = await loadConfig(opts.repoRoot);
  const roles = await RoleBook.load(join(opts.repoRoot, 'studio/org/roles'));
  const practitioners = await PractitionerBook.load(join(opts.repoRoot, 'studio/org/practitioners.json'));
  const tasks = (JSON.parse(await readFile(join(opts.repoRoot, 'studio/evals/tasks.json'), 'utf8')) as { tasks: EvalTask[] }).tasks.filter((t) => !opts.taskClass || t.taskClass === opts.taskClass);
  const criteria = config.rubric.criteria.map((c) => c.id);
  const provider: LlmProvider = opts.scripted ? new ScriptedProvider(criteria) : new BedrockRuntime({ apiKey: env('AWS_BEARER_TOKEN_BEDROCK') });
  const store = new FileStore(join(opts.repoRoot, '.studio-data', 'evals'));
  const ledger = new BudgetLedger(store, config.budget, systemClock);
  const renderer = new ScreenRenderer(config.tokens, join(opts.repoRoot, 'design-system'));
  const schemas: Record<string, Schema> = {
    triage: S.triageSchema, position: S.positionSchema, brief: S.briefSchema, screenVariant: S.screenVariantSchema,
    critique: S.critiqueSchema(criteria), feedback: S.feedbackSchema, motionSpec: S.motionSpecSchema, photoBrief: S.photoBriefSchema, technicalNote: S.technicalNoteSchema,
  };
  const runs: Array<{ task: string; model: string; score: number; costUsd: number; latencyMs: number; error?: string }> = [];
  try {
    for (const task of tasks) {
      const role = roles.get(task.role);
      const schema = schemas[task.output];
      const images: ImagePart[] = [];
      const fixtureNames: string[] = [];
      for (const name of (task.fixture ?? '').split('+').filter(Boolean)) {
        const spec = name === 'variantA' ? variantA('initial', 'a') : name === 'variantB' ? variantB('b') : variantC('c');
        const res = await renderer.render(spec, { scale: 1 });
        images.push({ format: 'png', base64: res.preview.toString('base64'), label: `вариант ${spec.id}` });
        fixtureNames.push(`Вариант ${spec.id} «${spec.title}»`);
      }
      const user = buildUser([
        { label: 'TASK', title: task.title, body: task.prompt + (fixtureNames.length ? `\nВарианты на изображениях: ${fixtureNames.join(', ')}` : '') },
        ...(task.output === 'screenVariant' ? [{ label: 'STANDARD' as const, title: 'Формат', body: specGuide(config.tokens) }] : []),
        { label: 'STANDARD', title: 'Продукт', body: await readFile(join(opts.repoRoot, 'studio/context/product.md'), 'utf8') },
      ]);
      const system = buildSystem(role, task.taskClass, task.output, schema, { school: practitioners.schoolSection(role.id) });
      const candidates = opts.models ?? config.models.assignments[task.taskClass] ?? [];
      for (const key of candidates) {
        const model = config.models.models.find((m) => m.key === key);
        if (!model || !model.enabled || !model.price?.inputPer1M) continue;
        if (images.length && !model.input.includes('image')) continue;
        const started = Date.now();
        const reservation = await ledger.reserve({ initiativeId: `eval-${task.id}`, category: 'llm', amountUsd: 0.05, autonomous: false, model: key, role: task.role });
        try {
          const res = await provider.chat({ model, region: model.region ?? config.models.region, system, user, images, maxTokens: Math.min(6000, model.maxOutputTokens ?? 6000) });
          const cost = round((res.usage.inputTokens * model.price.inputPer1M + res.usage.outputTokens * (model.price.outputPer1M ?? 0)) / 1e6, 6);
          await ledger.settle(reservation.id, cost);
          let value: unknown = null;
          let schemaOk = false;
          try {
            value = extractJson(res.text);
            schemaOk = validate(schema, value).length === 0;
          } catch { /* невалидный JSON = 0 */ }
          const score = schemaOk ? scoreTask(task, value, config.tokens, criteria) : 0;
          runs.push({ task: task.id, model: key, score, costUsd: cost, latencyMs: Date.now() - started });
        } catch (err) {
          await ledger.release(reservation.id);
          runs.push({ task: task.id, model: key, score: 0, costUsd: 0, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 120) });
        }
      }
    }
  } finally {
    await renderer.close();
  }
  const byClass: Record<string, Record<string, number[]>> = {};
  for (const r of runs) {
    const cls = tasks.find((t) => t.id === r.task)!.taskClass;
    ((byClass[cls] ??= {})[r.model] ??= []).push(r.score);
  }
  const scores: Record<string, Record<string, number>> = {};
  for (const [cls, models] of Object.entries(byClass)) for (const [m, list] of Object.entries(models)) (scores[cls] ??= {})[m] = round(list.reduce((a, b) => a + b, 0) / list.length, 3);
  if (!opts.scripted) {
    await writeFile(join(opts.repoRoot, 'studio/evals/results.json'), JSON.stringify({ date: new Date().toISOString(), scores, runs }, null, 2) + '\n');
  }
  const table = runs.map((r) => `${r.task.padEnd(22)} ${r.model.padEnd(18)} score ${r.score.toFixed(2)}  $${r.costUsd}  ${r.latencyMs} мс${r.error ? `  ${r.error}` : ''}`).join('\n');
  return { table: `${table}\n\nПо классам: ${JSON.stringify(scores)}`, scores };
}

function scoreTask(task: EvalTask, value: unknown, tokens: Parameters<typeof validateSpec>[1], criteria: string[]): number {
  const text = JSON.stringify(value).toLowerCase();
  const parts: number[] = [];
  for (const c of task.checks) {
    switch (c.type) {
      case 'mentions': {
        const pats = c.patterns ?? [];
        parts.push(pats.filter((p) => new RegExp(p, 'i').test(text)).length / Math.max(1, pats.length));
        break;
      }
      case 'specValid':
        parts.push(validateSpec((value as { spec: ScreenSpec }).spec, tokens).length === 0 ? 1 : 0);
        break;
      case 'ukrainianSpec': {
        let bad = false;
        try { walk((value as { spec: ScreenSpec }).spec.nodes, (n) => { if (n.text && /[ыэъё]/i.test(n.text)) bad = true; }); } catch { bad = true; }
        parts.push(bad ? 0 : 1);
        break;
      }
      case 'preferVariant': {
        const vs = (value as { variants: Array<{ variantId: string; scores: Record<string, number> }> }).variants;
        const avg = (id: string) => { const v = vs.find((x) => x.variantId === id); return v ? criteria.reduce((a, k) => a + (v.scores[k] ?? 0), 0) / criteria.length : 0; };
        const best = vs.map((v) => v.variantId).sort((a, b) => avg(b) - avg(a))[0];
        parts.push(best === c.winner ? 1 : 0);
        break;
      }
      case 'distinctDirections': {
        const ds = (value as { directions: Array<{ hypothesis: string }> }).directions;
        const tok = (s: string) => new Set(s.toLowerCase().split(/[^a-zа-яіїєґ]+/).filter((w) => w.length > 3));
        let ok = true;
        for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
          const a = tok(ds[i].hypothesis); const b = tok(ds[j].hypothesis);
          const inter = [...a].filter((w) => b.has(w)).length;
          if (inter / Math.max(1, Math.min(a.size, b.size)) > 0.6) ok = false;
        }
        parts.push(ok ? 1 : 0);
        break;
      }
      case 'springSane': {
        const ts = (value as { transitions: Array<{ spring: { duration: number; bounce: number } }> }).transitions;
        parts.push(ts.length > 0 && ts.every((t) => t.spring.duration <= 0.8 && t.spring.bounce <= 0.35) ? 1 : 0);
        break;
      }
      case 'changesCount': {
        const n = (value as { changes: unknown[] }).changes.length;
        parts.push(n >= (c.min ?? 0) && n <= (c.max ?? 99) ? 1 : 0);
        break;
      }
    }
  }
  return round(parts.reduce((a, b) => a + b, 0) / Math.max(1, parts.length), 3);
}
