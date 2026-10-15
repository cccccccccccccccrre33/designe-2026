// Конвейер студии: от сообщения владельца до утверждённого результата.
// Порядок этапов — раздел 1 и 7 архитектуры. Каждый этап — шаг журнала (ADR-0003).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSystem, buildUser, type ContextSection } from '../agents/prompt.ts';
import type { PractitionerBook } from '../agents/practitioners.ts';
import type { RoleBook, RoleProfile } from '../agents/roles.ts';
import {
  arbiterSchema, briefSchema, critiqueSchema, feedbackSchema, motionSpecSchema, photoBriefSchema,
  positionSchema, screenVariantSchema, triageSchema,
} from '../agents/schemas.ts';
import type { BudgetLedger } from '../budget/ledger.ts';
import type { Casting, CastingType, CatalogItem, Rubric } from '../config/load.ts';
import { BudgetExceeded, ModelChainExhausted, StopRequested } from '../core/errors.ts';
import type { Schema } from '../core/schema.ts';
import { mapLimit, newId, round, sha256, truncate, type Clock } from '../core/util.ts';
import { formatForPrompt, tokenize, type KnowledgeBase } from '../knowledge/base.ts';
import type { CompleteResult, ModelRouter } from '../llm/router.ts';
import type { ImagePart, TaskClass } from '../llm/types.ts';
import { decisionFile, lessonFile, writeRepoFiles, type PreferenceRegistry, type RepoFile, type RoleNotes } from '../memory/memory.ts';
import type { RenderResult } from '../render/renderer.ts';
import { specGuide, validateSpec, walk, type ScreenSpec, type Tokens } from '../render/spec.ts';
import { factsSummary, runChecks, type CheckResult } from '../review/checks.ts';
import { springFromDurationBounce } from '../science/spring.ts';
import type { Store } from '../store/store.ts';
import { StepJournal } from './engine.ts';
import { nearestAspect, type ImageStudio } from './images.ts';
import type { Outbox } from './outbox.ts';

// Реальное место выдачи: фото и описание владельца (product/space).
const SPACE_DOC = 'product/space/drive-window.md';
const SPACE_PHOTO = 'product/space/drive-window-2026-10.jpg';
const SPACE_TITLE = 'Реальное окно выдачи (фото и слова владельца)';
const WINDOW_TAGS = new Set(['pickup', 'drive-window', 'payment', 'checkout', 'active-order', 'order-readiness', 'waiting']);

export type InitiativeStatus = 'running' | 'awaiting_owner' | 'approved' | 'rejected' | 'paused' | 'blocked' | 'failed' | 'declined';

export interface ChangeRequest {
  id: string;
  target: string;
  request: string;
  kind?: string;
}

export interface Initiative {
  id: string;
  title: string;
  request: string;
  source: 'owner' | 'autonomous';
  status: InitiativeStatus;
  type: string;
  screen: string;
  problem: string;
  tags: string[];
  round: number;
  version: number;
  /** Номер попытки после остановки на финальном gate (новые попытки — новые шаги журнала). */
  attempt: number;
  pauseReason?: string;
  /** Почему на паузе: schedule — конец рабочих часов (продолжается сама), budget/models — после /resume. */
  pauseKind?: 'schedule' | 'budget' | 'models';
  /** false — запрос принят, но ещё не классифицирован (триаж доделает следующий запуск). */
  triaged?: boolean;
  pendingChanges?: ChangeRequest[];
  approvalId?: string;
  prNumber?: number;
  prUrl?: string;
  createdAt: number;
  updatedAt: number;
  history: Array<{ ts: number; event: string; detail?: string }>;
}

export interface Approval {
  id: string;
  initiativeId: string;
  version: number;
  artifactHash: string;
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'superseded';
  createdAt: number;
  decidedAt?: number;
  feedback?: string;
  reason?: string;
}

export interface VariantResult {
  id: string;
  name: string;
  hypothesis: string;
  rationale: string;
  spec: ScreenSpec;
  authorModel: string;
  authorFamily: string;
  png: string;
  preview: string;
  states: Array<{ id: string; label: string; path: string }>;
  checks: CheckResult[];
  facts: { blocking: number; major: number; minor: number; text: string };
  hash: string;
  addressed?: Array<{ changeId: string; status: 'done' | 'partially' | 'declined'; explanation: string }>;
  photo: 'placeholder' | 'generated';
  /** Приёмы школ, которые автор явно применил (studio/org/practitioners.json). */
  signaturesUsed?: string[];
}

interface CritiqueVariant {
  variantId: string;
  scores: Record<string, number>;
  issues: Array<{ severity: 'blocking' | 'major' | 'minor'; nodeId?: string; issue: string; evidence: string; fix: string }>;
  veto?: { active: boolean; reason?: string; evidence?: string };
  strengths?: string[];
}

interface Critique {
  critic: string;
  model: string;
  variants: CritiqueVariant[];
}

interface Selection {
  winnerId: string;
  scores: Record<string, number>;
  disagreement: Record<string, number>;
  eligible: string[];
  notes: string[];
}

interface GateResult {
  passed: boolean;
  score: number;
  reasons: string[];
}

export interface RendererLike {
  render(spec: ScreenSpec, opts?: { scale?: number; assets?: Record<string, string> }): Promise<RenderResult>;
}

export interface StudioDeps {
  repoRoot: string;
  artifactsDir: string;
  store: Store;
  clock: Clock;
  router: ModelRouter;
  ledger: BudgetLedger;
  roles: RoleBook;
  kb: KnowledgeBase;
  prefs: PreferenceRegistry;
  notes: RoleNotes;
  tokens: Tokens;
  casting: Casting;
  rubric: Rubric;
  catalog: CatalogItem[];
  principles: Array<{ id: string; title: string; rule: string }>;
  renderer: RendererLike;
  outbox: Outbox;
  images?: ImageStudio | null;
  /** Публиковать ли версии и решения в GitHub (есть токен и репозиторий). */
  publishToGitHub: boolean;
  /** Школы практиков: почерк ролей и подписи в карточке владельцу. */
  practitioners?: PractitionerBook | null;
}

export class Studio {
  d: StudioDeps;
  private productContext = '';
  private spaceText: string | null | undefined;
  /** Для тестов: имитировать падение процесса перед шагом с этим ключом. */
  crashBefore: string | null = null;
  /** Сессия в GitHub Actions: причина не начинать новых шагов (ночь, лимит времени). */
  stopCheck: (() => string | null) | null = null;

  constructor(deps: StudioDeps) {
    this.d = deps;
    deps.router.onBudgetAlert = async (alerts) => {
      for (const a of alerts) {
        const period = a.scope === 'day' ? 'день' : 'месяц';
        await this.notifyText(`budget:${a.scope}:${a.threshold}:${new Date(this.d.clock.now()).toISOString().slice(0, a.scope === 'day' ? 10 : 7)}`,
          `💰 Бюджет за ${period}: ${Math.round(a.ratio * 100)}% ($${a.spentUsd} из $${a.limitUsd}).${a.threshold >= 0.8 ? ' Необязательные шаги отключены, автономные инициативы не стартуют.' : ''}`);
      }
    };
  }

  // ───────────────────────── приём задачи ─────────────────────────

  async intake(request: string, source: 'owner' | 'autonomous' = 'owner'): Promise<{ initiative: Initiative; duplicate: boolean }> {
    const level = await this.d.ledger.level();
    if (level === 'stopped' || level === 'critical' || (source === 'autonomous' && level !== 'normal')) {
      throw new BudgetExceeded('intake', `Новые инициативы не принимаются: бюджет на уровне «${level}»`);
    }
    const open = (await this.list()).filter((i) => ['running', 'awaiting_owner', 'paused'].includes(i.status));
    if (source === 'autonomous' && open.some((i) => i.source === 'autonomous')) {
      throw new Error('Автономная инициатива уже в работе — квота 1');
    }
    const dup = open.find((i) => similarity(i.request + ' ' + i.problem, request) >= 0.6);
    if (dup) {
      await this.event(dup, 'duplicate_request', truncate(request, 120));
      return { initiative: dup, duplicate: true };
    }
    const now = this.d.clock.now();
    const id = newId('ini', now);
    const ini: Initiative = {
      id, title: truncate(request, 60), request, source, status: 'running', type: 'screen-redesign', screen: 'home', problem: request,
      tags: [], round: 0, version: 0, attempt: 0, triaged: false, createdAt: now, updatedAt: now, history: [{ ts: now, event: 'created', detail: source }],
    };
    await this.save(ini);
    try {
      await this.triage(ini);
    } catch (err) {
      // Запрос пришёл в нерабочее время: принят, классифицируется в следующую сессию.
      if (!(err instanceof StopRequested)) throw err;
      ini.status = 'paused';
      ini.pauseKind = 'schedule';
      ini.pauseReason = err.message;
      await this.event(ini, 'paused_schedule', err.message);
    }
    return { initiative: ini, duplicate: false };
  }

  private async triage(ini: Initiative): Promise<void> {
    const product = await this.product();
    const triage = await this.journal(ini).step('triage', () => this.callAgent<TriageOut>(ini, this.d.roles.get('studio-director'), 'classify', 'triage', triageSchema, [
      { label: 'TASK', title: 'Классифицируй запрос владельца', body: `Запрос: «${ini.request}»\nОпредели, задача ли это для дизайн-студии, тип инициативы, экран, проблему пользователя и теги.` },
      { label: 'STANDARD', title: 'Продукт', body: product },
    ], { maxTokens: 800 }).then((r) => r.value));
    ini.triaged = true;
    if (!triage.isDesignTask) {
      ini.status = 'declined';
      await this.event(ini, 'declined', 'не задача студии');
      await this.notifyText(`declined:${ini.id}`, `Это не похоже на задачу для студии, инициатива не создана. Если это задача — опишите экран и проблему.`);
      return;
    }
    Object.assign(ini, { type: triage.type, screen: triage.screen, problem: triage.problem, tags: triage.tags, title: triage.title });
    await this.save(ini);
  }

  // ───────────────────────── выполнение ─────────────────────────

  /** Довести инициативу до следующей точки ожидания (владелец, пауза, блок). Безопасно перезапускать. */
  async run(initiativeId: string): Promise<Initiative> {
    const owner = newId('runner', this.d.clock.now());
    const lease = `initiative-${initiativeId}`;
    if (!(await this.d.store.acquireLease(lease, owner, 30 * 60_000, this.d.clock.now()))) {
      throw new Error(`Инициатива ${initiativeId} уже выполняется другим процессом`);
    }
    const ini = await this.get(initiativeId);
    try {
      if (!['running', 'paused', 'failed', 'blocked'].includes(ini.status)) return ini;
      if (ini.status === 'blocked') ini.attempt = (ini.attempt ?? 0) + 1;
      ini.status = 'running';
      ini.pauseReason = undefined;
      ini.pauseKind = undefined;
      await this.save(ini);
      if (ini.triaged === false) {
        await this.triage(ini);
        // triage() меняет статус — сужение типа после присваивания 'running' здесь неверно.
        if ((ini.status as InitiativeStatus) === 'declined') return ini;
      }
      if (ini.round === 0) await this.initialRound(ini);
      else await this.feedbackRound(ini);
      return ini;
    } catch (err) {
      if (err instanceof StopRequested) {
        // Конец рабочих часов или сессии: без сообщения владельцу, продолжит следующая сессия.
        ini.status = 'paused';
        ini.pauseKind = 'schedule';
        ini.pauseReason = err.message;
        await this.event(ini, 'paused_schedule', err.message);
      } else if (err instanceof BudgetExceeded) {
        ini.status = 'paused';
        ini.pauseKind = 'budget';
        ini.pauseReason = err.message;
        await this.event(ini, 'paused_budget', err.message);
        await this.notifyText(`pause:${ini.id}:${ini.round}:${err.scope}`, `⏸ «${ini.title}» на паузе: ${err.message}. Черновик не отправляю. Продолжу после /resume ${ini.id} (например, после изменения лимита).`);
      } else if (err instanceof ModelChainExhausted) {
        ini.status = 'paused';
        ini.pauseKind = 'models';
        ini.pauseReason = err.message;
        await this.event(ini, 'paused_models', JSON.stringify(err.details).slice(0, 300));
        await this.notifyText(`pause:${ini.id}:${ini.round}:models`, `⏸ «${ini.title}» на паузе: ${err.message}. Модели недоступны или не включены в аккаунте. Продолжу после /resume ${ini.id}.`);
      } else {
        ini.status = 'failed';
        ini.pauseReason = (err as Error).message;
        await this.event(ini, 'failed', (err as Error).message);
        await this.notifyText(`fail:${ini.id}:${ini.round}:${sha256((err as Error).message).slice(0, 8)}`, `❌ «${ini.title}»: сбой — ${truncate((err as Error).message, 200)}. Выполненные шаги сохранены, /resume ${ini.id} продолжит с места остановки.`);
      }
      await this.save(ini);
      return ini;
    } finally {
      await this.d.store.releaseLease(lease, owner);
    }
  }

  private async initialRound(ini: Initiative): Promise<void> {
    const j = this.journal(ini);
    const cast = this.castFor(ini);
    const research = await j.step('research', () => this.research(ini));
    const positions = await j.step('positions', async () => {
      const roles = cast.positions.slice(0, Math.min(this.d.casting.limits.maxPositions, this.d.ledger.policy.process.maxPositions));
      return mapLimit(roles, this.d.ledger.policy.process.parallelism, async (roleId) => {
        const role = this.d.roles.get(roleId);
        const r = await this.callAgent<PositionOut>(ini, role, 'position', 'position', positionSchema, [
          { label: 'TASK', title: 'Твоя независимая позиция', body: `Проблема: ${ini.problem}\nЭкран: ${ini.screen}\nЗапрос владельца: «${ini.request}»\nДай свою профессиональную позицию до того, как увидишь мнения коллег.` },
          ...research.sections,
          { label: 'RESEARCH', title: 'Источники по твоей специализации', body: formatForPrompt(this.d.kb.search(`${ini.problem} ${role.knowledgeTags.join(' ')}`, { k: 4, tags: role.knowledgeTags })) },
          { label: 'NOTES', title: 'Твои прошлые выводы', body: (await this.d.notes.recent(role.id)).join('\n') },
        ], { maxTokens: 1500 });
        await this.d.notes.add(role.id, ini.id, r.value.stance);
        return { role: roleId, ...r.value };
      });
    });
    const brief = await j.step('brief', async () => (await this.callAgent<BriefOut>(ini, this.d.roles.get(cast.director), 'brief', 'brief', briefSchema, [
      { label: 'TASK', title: 'Бриф и направления', body: `Синтезируй позиции в бриф. Направления должны отличаться гипотезой, а не цветом. Споры закрой решением с обоснованием.\nПроблема: ${ini.problem}\nЭкран: ${ini.screen}` },
      ...research.sections,
      { label: 'WORK', title: 'Позиции специалистов', body: positions.map((p) => `${p.role}: ${p.stance}\n  предложения: ${p.proposals.map((x) => x.idea).join('; ')}\n  опасения: ${p.concerns.map((x) => `${x.issue} (${x.evidence})`).join('; ')}\n  обязательно: ${p.mustHave.join('; ')}`).join('\n') },
    ], { maxTokens: 2500 })).value);

    const level = await this.d.ledger.level();
    const maxVariants = Math.min(this.d.ledger.policy.process.maxVariants, level === 'normal' ? 3 : 2);
    const directions = brief.directions.slice(0, maxVariants);
    const mustHave = positions.flatMap((p) => p.mustHave);
    const variants: VariantResult[] = [];
    for (const dir of directions) {
      variants.push(await j.step(`variant:${dir.id}`, async () => {
        const r = await this.callAgent<VariantOut>(ini, this.d.roles.get(cast.author), 'spec', 'screenVariant', screenVariantSchema, [
          { label: 'TASK', title: `Вариант «${dir.name}»`, body: `Спроектируй экран «${ini.screen}» по направлению.\nГипотеза: ${dir.hypothesis}\nХудожественная идея: ${dir.artIdea}\nСтруктура: ${dir.structure}\nКритерии успеха: ${brief.successCriteria.join('; ')}\nОграничения: ${brief.constraints.join('; ')}\nОбязательные требования коллег: ${mustHave.join('; ')}\nspec.id = "${ini.id}-${dir.id}", spec.screen = "${ini.screen}".` },
          { label: 'STANDARD', title: 'Формат и дизайн-система', body: specGuide(this.d.tokens) },
          ...research.sections,
        ], { maxTokens: 7000, check: (v) => validateSpec((v as VariantOut).spec, this.d.tokens) });
        return this.materialize(ini, `r0-${dir.id}-i0`, { id: dir.id, name: dir.name, hypothesis: dir.hypothesis, rationale: r.value.rationale, spec: r.value.spec, authorModel: r.model, authorFamily: r.family, signaturesUsed: this.knownSignatures(r.value.signaturesUsed) });
      }));
    }

    const critiques = await j.step('critique:0', () => this.critique(ini, cast, variants, brief.problem, research.sections));
    const selection = await j.step('select', () => this.select(ini, variants, critiques, brief.problem));
    let current = variants.find((v) => v.id === selection.winnerId)!;
    let lastCritiques = critiques;
    let gate = this.gate(current, lastCritiques);
    const a = ini.attempt ?? 0;
    // Повторная попытка после остановки на gate получает ещё одну итерацию доработки.
    const maxIter = this.d.ledger.policy.process.maxRefineIterations + a;
    for (let i = 1; !gate.passed && i <= maxIter; i++) {
      const refined = await j.step(`refine:a${a}:${i}`, async () => {
        const v = await this.refine(ini, cast, current, lastCritiques, [], research.sections, `r0-${current.id}-a${a}-i${i}`);
        const c = await this.critique(ini, cast, [v], brief.problem, research.sections, this.criticsWithIssues(lastCritiques, current.id, cast));
        return { v, c };
      });
      current = refined.v;
      lastCritiques = refined.c;
      gate = this.gate(current, lastCritiques);
    }

    const finished = await j.step(`finish:0:a${a}`, () => this.finishVisuals(ini, cast, current, brief.problem));
    current = finished.variant;
    gate = this.gate(current, lastCritiques);
    await this.concludeRound(ini, current, gate, lastCritiques, { name: current.name, hypothesis: current.hypothesis, motion: finished.motion, selectionNotes: selection.notes });
  }

  private async feedbackRound(ini: Initiative): Promise<void> {
    const j = this.journal(ini);
    const cast = this.castFor(ini);
    const research = await j.step('research', () => this.research(ini));
    const prev = await this.latestDelivered(ini);
    const changes = ini.pendingChanges ?? [];
    const r = ini.round;
    const a = ini.attempt ?? 0;
    let current = await j.step(`r${r}:revise`, () => this.refine(ini, cast, prev, [], changes, research.sections, `r${r}-i0`));
    let critiques = await j.step(`r${r}:critique`, () => this.critique(ini, cast, [current], ini.problem, research.sections, cast.critics.slice(0, 2)));
    let gate = this.gate(current, critiques, changes);
    for (let i = 1; !gate.passed && i <= 1 + a; i++) {
      const refined = await j.step(`r${r}:refine:a${a}:${i}`, async () => {
        const v = await this.refine(ini, cast, current, critiques, changes, research.sections, `r${r}-a${a}-i${i}`);
        const c = await this.critique(ini, cast, [v], ini.problem, research.sections, cast.critics.slice(0, 2));
        return { v, c };
      });
      current = refined.v;
      critiques = refined.c;
      gate = this.gate(current, critiques, changes);
    }
    const finished = await j.step(`finish:${r}:a${a}`, () => this.finishVisuals(ini, cast, current, ini.problem));
    current = finished.variant;
    gate = this.gate(current, critiques, changes);
    await this.concludeRound(ini, current, gate, critiques, { name: current.name, hypothesis: current.hypothesis, motion: finished.motion, changes, selectionNotes: [] });
  }

  private async concludeRound(ini: Initiative, v: VariantResult, gate: GateResult, critiques: Critique[], ctx: { name: string; hypothesis: string; motion: MotionOut | null; changes?: ChangeRequest[]; selectionNotes: string[] }): Promise<void> {
    const j = this.journal(ini);
    if (!gate.passed) {
      ini.status = 'blocked';
      ini.pauseReason = gate.reasons.join('; ');
      await this.event(ini, 'blocked_quality_gate', ini.pauseReason);
      await this.save(ini);
      await this.notifyText(`blocked:${ini.id}:${ini.round}:a${ini.attempt ?? 0}`, `🧱 «${ini.title}»: результат не прошёл внутренний контроль (${truncate(ini.pauseReason, 300)}). Черновик не отправляю. Детали — в отчёте инициативы; /resume ${ini.id} запустит ещё одну попытку.`);
      return;
    }
    await j.step(`deliver:${ini.round}`, () => this.deliver(ini, v, gate, critiques, ctx));
    const fresh = await this.get(ini.id);
    Object.assign(ini, fresh);
  }

  // ───────────────────────── этапы ─────────────────────────

  private castFor(ini: Initiative): CastingType {
    const base = this.d.casting.types[ini.type] ?? this.d.casting.types['screen-redesign'];
    const cast: CastingType = structuredClone(base);
    const triggered = new Set<string>();
    for (const tag of ini.tags) {
      const trig = this.d.casting.tagTriggers[tag];
      for (const r of trig?.addPositions ?? []) {
        triggered.add(r);
        if (!cast.positions.includes(r)) cast.positions.push(r);
      }
    }
    // Роли, вызванные тегами (окно, оплата, движение), важнее хвоста базового списка:
    // при превышении лимита сначала уходят последние невызванные позиции.
    const max = this.d.casting.limits.maxPositions;
    const known = cast.positions.filter((r) => this.d.roles.has(r));
    let extra = known.length - max;
    for (let i = known.length - 1; extra > 0 && i >= 0; i--) {
      if (!triggered.has(known[i])) { known.splice(i, 1); extra--; }
    }
    cast.positions = known.slice(0, max);
    cast.critics = cast.critics.filter((r) => this.d.roles.has(r)).slice(0, this.d.casting.limits.maxCritics);
    return cast;
  }

  private async research(ini: Initiative): Promise<{ sections: ContextSection[] }> {
    const prefs = await this.d.prefs.active();
    const decisions = (await this.d.store.list<{ initiativeId: string; title: string; decision: string; reason?: string; screen: string; summary: string }>('decisions'));
    const rejected = decisions.filter((d) => d.decision === 'rejected');
    const sameScreen = decisions.filter((d) => d.decision === 'approved' && d.screen === ini.screen).slice(-3);
    const knowledge = this.d.kb.search(`${ini.problem} ${ini.screen} ${ini.tags.join(' ')}`, { k: 6 });
    const space = this.windowRelated(ini) ? await this.spaceDoc() : null;
    const cats = new Map<string, string[]>();
    // Цена только та, что назвал владелец; без цены — без цифры, а не «null ₴».
    const price = (item: CatalogItem) => item.sizes.filter(([, p]) => p !== null).map(([v, p]) => `${v ? `${v} ` : ''}${p} ₴`).join(' / ');
    for (const item of this.d.catalog) cats.set(item.cat, [...(cats.get(item.cat) ?? []), `${item.name}${price(item) ? ` ${price(item)}` : ''}`]);
    return {
      sections: [
        { label: 'STANDARD', title: 'Продукт DRIVE&KAVA', body: await this.product() },
        { label: 'OWNER PREFERENCES', title: 'Предпочтения владельца (обязательны)', body: prefs.map((p) => `${p.id} [${p.strength}] ${p.statement}`).join('\n') },
        { label: 'STANDARD', title: 'Принципы бренда', body: this.d.principles.map((p) => `${p.id} ${p.title}: ${p.rule}`).join('\n') },
        { label: 'STANDARD', title: 'Меню (v83, цены — только названные владельцем)', body: [...cats].map(([c, items]) => `${c}: ${items.join(', ')}`).join('\n') },
        { label: 'STANDARD', title: 'Утверждённые решения по этому экрану', body: sameScreen.map((d) => `${d.title}: ${d.summary}`).join('\n') },
        { label: 'REJECTED', title: 'Отклонено владельцем раньше — не повторять', body: rejected.slice(-5).map((d) => `${d.title}: ${d.reason ?? 'без причины'}`).join('\n') },
        ...(space ? [{ label: 'STANDARD' as const, title: SPACE_TITLE, body: space }] : []),
        { label: 'RESEARCH', title: 'База знаний', body: formatForPrompt(knowledge) },
      ],
    };
  }

  /** Отрендерить, проверить и сохранить вариант. */
  private async materialize(ini: Initiative, tag: string, base: Omit<VariantResult, 'png' | 'preview' | 'states' | 'checks' | 'facts' | 'hash' | 'photo'> & { photo?: VariantResult['photo']; assets?: Record<string, string> }): Promise<VariantResult> {
    const spec = base.spec;
    const result = await this.d.renderer.render(spec, { scale: 3, assets: base.assets });
    const dir = join(this.d.artifactsDir, ini.id);
    await mkdir(dir, { recursive: true });
    const png = join(dir, `${tag}.png`);
    const preview = join(dir, `${tag}@1x.png`);
    await writeFile(png, result.png);
    await writeFile(preview, result.preview);
    const states: VariantResult['states'] = [];
    for (const s of result.states) {
      const p = join(dir, `${tag}-state-${s.id}.png`);
      await writeFile(p, s.png);
      states.push({ id: s.id, label: s.label, path: p });
    }
    await writeFile(join(dir, `${tag}.spec.json`), JSON.stringify(spec, null, 2));
    const checks = runChecks(spec, result.measurements, { allowedLatin: this.allowedLatin(), ownerHardChecks: await this.d.prefs.hardCheckIds() });
    const { assets: _assets, ...rest } = base;
    return {
      ...rest,
      photo: base.photo ?? 'placeholder',
      png, preview, states, checks,
      facts: factsSummary(checks),
      hash: sha256(JSON.stringify(spec) + sha256(result.png)),
    };
  }

  private async critique(ini: Initiative, cast: CastingType, variants: VariantResult[], problem: string, sections: ContextSection[], critics: string[] = cast.critics): Promise<Critique[]> {
    const criteria = this.d.rubric.criteria.map((c) => c.id);
    const images: ImagePart[] = [];
    for (const v of variants) images.push({ format: 'png', base64: (await readFile(v.preview)).toString('base64'), label: `вариант ${v.id} — ${v.name}` });
    const place = this.windowRelated(ini) ? await this.spacePhoto() : null;
    if (place) images.push(place);
    const authorFamily = variants[0]?.authorFamily;
    return mapLimit(critics, this.d.ledger.policy.process.parallelism, async (criticId) => {
      const role = this.d.roles.get(criticId);
      const r = await this.callAgent<{ variants: CritiqueVariant[] }>(ini, role, 'critique', 'critique', critiqueSchema(criteria), [
        { label: 'TASK', title: 'Слепая критика вариантов', body: `Оцени каждый вариант по рубрике (1–5) со своей профессиональной позиции. Авторы скрыты. Проблема: ${problem}\nДля каждой проблемы укажи узел (nodeId), доказательство и исправление. Вето — только с доказательством.\nКритерий school: приёмы школ (Drinkit, amo, Dodo) применены по делу и узнаваемо, но экраны и бренд-элементы источников не скопированы; сверяйся со своей школой.${place ? '\nПоследнее изображение — фото реального окна DRIVE&KAVA: сверь получение с местом (окно одно, маршрут и ориентиры, оплата у окна готівкою або карткою, читается до выезда).' : ''}\nРубрика: ${this.d.rubric.criteria.map((c) => `${c.id} — ${c.title}`).join('; ')}` },
        { label: 'FACTS', title: 'Автопроверки (факты, не обсуждаются)', body: variants.map((v) => `Вариант ${v.id} «${v.name}»:\n${v.facts.text}`).join('\n\n') },
        { label: 'WORK', title: 'Обоснования авторов', body: variants.map((v) => `Вариант ${v.id}: ${v.hypothesis}\n${v.rationale}${v.signaturesUsed?.length ? `\nЗаявленные приёмы школ: ${(this.d.practitioners?.credit(v.signaturesUsed) ?? v.signaturesUsed).join('; ')}` : ''}`).join('\n') },
        ...sections.filter((s) => s.label !== 'RESEARCH'),
      ], { maxTokens: 3000, images, avoidFamily: authorFamily });
      return { critic: criticId, model: r.model, variants: r.value.variants };
    });
  }

  private criticsWithIssues(critiques: Critique[], variantId: string, cast: CastingType): string[] {
    const flagged = critiques.filter((c) => c.variants.some((v) => v.variantId === variantId && (v.issues.some((i) => i.severity !== 'minor') || v.veto?.active))).map((c) => c.critic);
    return flagged.length ? flagged : cast.critics.slice(0, 1);
  }

  private weighted(scores: Record<string, number>): number {
    return this.d.rubric.criteria.reduce((acc, c) => acc + (scores[c.id] ?? 0) * c.weight, 0) / this.d.rubric.criteria.reduce((a, c) => a + c.weight, 0);
  }

  private async select(ini: Initiative, variants: VariantResult[], critiques: Critique[], problem: string): Promise<Selection> {
    const scores: Record<string, number> = {};
    const disagreement: Record<string, number> = {};
    const eligible: string[] = [];
    const notes: string[] = [];
    for (const v of variants) {
      const per = critiques.map((c) => c.variants.find((x) => x.variantId === v.id)).filter((x): x is CritiqueVariant => Boolean(x)).map((x) => this.weighted(x.scores));
      scores[v.id] = round(per.reduce((a, b) => a + b, 0) / Math.max(1, per.length), 3);
      disagreement[v.id] = per.length ? round(Math.max(...per) - Math.min(...per), 3) : 0;
      const vetoed = critiques.some((c) => c.variants.some((x) => x.variantId === v.id && x.veto?.active && x.veto.evidence));
      if (v.facts.blocking === 0 && !vetoed) eligible.push(v.id);
      else notes.push(`вариант ${v.id} исключён: ${v.facts.blocking ? `${v.facts.blocking} блокирующих проверок` : 'вето критика с доказательством'}`);
    }
    const pool = eligible.length ? eligible : variants.map((v) => v.id);
    if (!eligible.length) notes.push('все варианты имеют блокирующие замечания — берём лучший и исправляем на доработке');
    const ranked = [...pool].sort((a, b) => scores[b] - scores[a]);
    let winnerId = ranked[0];
    const close = ranked.length > 1 && scores[ranked[0]] - scores[ranked[1]] < this.d.rubric.arbiterMargin;
    const split = close && Math.max(disagreement[ranked[0]], disagreement[ranked[1]]) > this.d.rubric.arbiterDisagreement;
    if (split) {
      if ((await this.d.ledger.level()) !== 'normal') {
        notes.push('арбитраж не проводился: бюджет на уровне ограничения');
      } else {
        const reason = `лидеры ${ranked[0]} и ${ranked[1]} разошлись менее чем на ${this.d.rubric.arbiterMargin}, критики расходятся сильнее ${this.d.rubric.arbiterDisagreement}`;
        const top = variants.filter((v) => v.id === ranked[0] || v.id === ranked[1]);
        const images: ImagePart[] = [];
        for (const v of top) images.push({ format: 'png', base64: (await readFile(v.preview)).toString('base64'), label: `вариант ${v.id}` });
        const r = await this.callAgent<{ winner: string; reasoning: string }>(ini, this.d.roles.get('studio-director'), 'arbiter', 'arbiter', arbiterSchema, [
          { label: 'TASK', title: 'Независимый арбитраж', body: `Проблема: ${problem}. Выбери один вариант из ${ranked[0]} и ${ranked[1]}.` },
          { label: 'WORK', title: 'Оценки критиков', body: critiques.map((c) => `${c.critic}: ${c.variants.filter((v) => v.variantId === ranked[0] || v.variantId === ranked[1]).map((v) => `${v.variantId}=${round(this.weighted(v.scores), 2)} (${v.issues.map((i) => i.issue).join('; ')})`).join(' | ')}`).join('\n') },
          { label: 'FACTS', title: 'Автопроверки', body: top.map((v) => `${v.id}:\n${v.facts.text}`).join('\n') },
        ], { maxTokens: 1200, images, reason });
        if (pool.includes(r.value.winner)) winnerId = r.value.winner;
        notes.push(`арбитр: ${truncate(r.value.reasoning, 200)}`);
      }
    }
    return { winnerId, scores, disagreement, eligible, notes };
  }

  private gate(v: VariantResult, critiques: Critique[], changes: ChangeRequest[] = []): GateResult {
    const per = critiques.map((c) => c.variants.find((x) => x.variantId === v.id)).filter((x): x is CritiqueVariant => Boolean(x));
    const score = per.length ? round(per.map((x) => this.weighted(x.scores)).reduce((a, b) => a + b, 0) / per.length, 3) : 0;
    const reasons: string[] = [];
    if (v.facts.blocking > 0) reasons.push(`блокирующих автопроверок: ${v.facts.blocking}`);
    if (score < this.d.rubric.passScore) reasons.push(`оценка ${score} ниже порога ${this.d.rubric.passScore}`);
    if (per.some((x) => x.veto?.active && x.veto.evidence)) reasons.push('открытое вето критика');
    for (const c of changes) {
      const a = v.addressed?.find((x) => x.changeId === c.id);
      if (!a) reasons.push(`правка ${c.id} не отработана`);
      else if (a.status === 'partially') reasons.push(`правка ${c.id} выполнена частично`);
      else if (a.status === 'declined' && !a.explanation.trim()) reasons.push(`правка ${c.id} отклонена без объяснения`);
    }
    return { passed: reasons.length === 0, score, reasons };
  }

  private async refine(ini: Initiative, cast: CastingType, current: VariantResult, critiques: Critique[], changes: ChangeRequest[], sections: ContextSection[], tag: string): Promise<VariantResult> {
    const issues = critiques.flatMap((c) => (c.variants.find((v) => v.variantId === current.id)?.issues ?? []).map((i) => `[${c.critic}] (${i.severity}) ${i.nodeId ? `[${i.nodeId}] ` : ''}${i.issue} → ${i.fix}`));
    const failed = current.checks.filter((c) => !c.passed).map((c) => `${c.id} (${c.severity}): ${c.findings.slice(0, 4).map((f) => (f.nodeId ? `[${f.nodeId}] ` : '') + f.message).join('; ')}`);
    const r = await this.callAgent<VariantOut>(ini, this.d.roles.get(cast.author), 'spec', 'screenVariant', screenVariantSchema, [
      {
        label: 'TASK',
        title: changes.length ? 'Доработка по замечаниям владельца' : 'Доработка выбранного варианта',
        body: [
          `Доработай экран, сохранив идею направления «${current.name}». Верни спецификацию целиком.`,
          changes.length ? `Правки владельца (каждую отметь в addressed: done / partially / declined с объяснением; declined — только если правка ломает блокирующую проверку):\n${changes.map((c) => `${c.id}: [${c.target}] ${c.request}`).join('\n')}` : '',
          issues.length ? `Замечания критиков:\n${issues.join('\n')}` : '',
          failed.length ? `Проваленные автопроверки:\n${failed.join('\n')}` : '',
        ].filter(Boolean).join('\n\n'),
      },
      { label: 'WORK', title: 'Текущая спецификация', body: JSON.stringify(current.spec) },
      { label: 'STANDARD', title: 'Формат и дизайн-система', body: specGuide(this.d.tokens) },
      ...sections.filter((s) => s.label === 'OWNER PREFERENCES' || s.label === 'REJECTED' || s.title === SPACE_TITLE),
    ], { maxTokens: 7000, check: (v) => validateSpec((v as VariantOut).spec, this.d.tokens) });
    const used = this.knownSignatures(r.value.signaturesUsed);
    return this.materialize(ini, tag, { id: current.id, name: current.name, hypothesis: current.hypothesis, rationale: r.value.rationale, spec: r.value.spec, authorModel: r.model, authorFamily: r.family, addressed: r.value.addressed, signaturesUsed: used.length ? used : current.signaturesUsed });
  }

  /** Только существующие ID приёмов: выдуманные ссылки на школы отбрасываются. */
  private knownSignatures(ids: string[] | undefined): string[] {
    if (!ids || !this.d.practitioners) return [];
    return [...new Set(ids)].filter((id) => this.d.practitioners!.signature(id));
  }

  /** Фото (если подключена генерация) и спецификация движения для выбранного варианта. */
  private async finishVisuals(ini: Initiative, cast: CastingType, v: VariantResult, problem: string): Promise<{ variant: VariantResult; motion: MotionOut | null }> {
    let variant = v;
    if (cast.photo && this.d.images) {
      const hero = findHero(v.spec);
      if (hero?.frame?.w && hero.frame.h) {
        const lenses = cast.photoLenses.filter((r) => this.d.roles.has(r)).map((r) => this.d.roles.get(r));
        const drinkName = hero.drink?.name ?? hero.label ?? 'напиток';
        const brief = await this.callAgent<PhotoOut>(ini, this.d.roles.get(cast.photo), 'photo', 'photoBrief', photoBriefSchema, [
          { label: 'TASK', title: 'Фото-бриф под экран', body: `Напиток-герой: ${drinkName}. Рамка героя ${hero.frame.w}×${hero.frame.h} pt. UI-зоны — всё вне зоны героя на экране (изображение экрана приложено).\nПроблема экрана: ${problem}\nСекции брифа учитывают линзы: ${lenses.map((l) => `${l.title}: ${l.decisionMethod}`).join(' | ')}\nПромпт генерации обязан описать физику напитка по стандарту ниже: лёд, конденсат, пену, слои, свет — иначе генерация выглядит ненастоящей.` },
          { label: 'STANDARD', title: 'Как выглядит этот напиток (каталог меню)', body: drinkTruth(this.d.catalog, drinkName) },
          { label: 'STANDARD', title: 'Физика напитка в кадре', body: formatForPrompt(this.d.kb.search(`физика ${drinkName} лёд конденсат пена слои стакан свет`, { k: 4, tags: ['physics'] })) },
          { label: 'WORK', title: 'Спецификация экрана', body: JSON.stringify(v.spec) },
        ], { maxTokens: 1500, images: [{ format: 'png', base64: (await readFile(v.preview)).toString('base64'), label: 'экран, под который пишется фото' }] });
        const asset = await this.d.images.generate({ initiativeId: ini.id, autonomous: ini.source === 'autonomous', prompt: brief.value.prompt, negativePrompt: brief.value.negativePrompt, aspectRatio: nearestAspect(hero.frame.w, hero.frame.h), final: true });
        const spec = structuredClone(v.spec);
        walk(spec.nodes, (n) => { if (n.id === hero.id) { n.kind = 'image'; n.asset = asset.assetId; n.fit = 'cover'; delete n.drink; } });
        variant = await this.materialize(ini, `r${ini.round}-a${ini.attempt ?? 0}-final`, { ...v, spec, photo: 'generated', assets: { [asset.assetId]: asset.dataUrl } });
      }
    }
    let motion: MotionOut | null = null;
    if (cast.motion) {
      const r = await this.callAgent<MotionOut>(ini, this.d.roles.get(cast.motion), 'spec', 'motionSpec', motionSpecSchema, [
        { label: 'TASK', title: 'Спецификация движения', body: `Опиши переходы и микровзаимодействия для экрана; пружины — duration и bounce.\nПроблема: ${problem}` },
        { label: 'WORK', title: 'Спецификация экрана', body: JSON.stringify(variant.spec) },
        { label: 'RESEARCH', title: 'Методы', body: formatForPrompt(this.d.kb.search('пружины переход непрерывность движение', { k: 3, tags: ['motion'] })) },
      ], { maxTokens: 2000 });
      motion = r.value;
      for (const t of motion.transitions) (t as MotionOut['transitions'][number] & { physics?: unknown }).physics = springFromDurationBounce(t.spring.duration, t.spring.bounce);
    }
    return { variant, motion };
  }

  // ───────────────────────── доставка и решения ─────────────────────────

  private async deliver(ini: Initiative, v: VariantResult, gate: GateResult, critiques: Critique[], ctx: { name: string; hypothesis: string; motion: MotionOut | null; changes?: ChangeRequest[]; selectionNotes: string[] }): Promise<{ approvalId: string }> {
    // Номер версии фиксируется в журнале до побочных эффектов, а ID утверждения и
    // ключи outbox детерминированы — повтор после сбоя не создаёт дублей.
    const version = await this.journal(ini).step(`deliver-version:${ini.round}`, async () => ini.version + 1);
    const now = this.d.clock.now();
    const approval: Approval = { id: `apr-${ini.id}-v${version}`, initiativeId: ini.id, version, artifactHash: v.hash, status: 'pending', createdAt: now };
    // Предыдущая версия, если ещё ждала решения, заменяется.
    if (ini.approvalId && ini.approvalId !== approval.id) {
      const prev = await this.d.store.get<Approval>('approvals', ini.approvalId);
      if (prev && prev.status === 'pending') { prev.status = 'superseded'; await this.d.store.put('approvals', prev.id, prev); }
    }
    await this.d.store.put('approvals', approval.id, approval);
    await this.d.store.put('delivered', `${ini.id}-v${version}`, v);

    const strengths = critiques.flatMap((c) => c.variants.find((x) => x.variantId === v.id)?.strengths ?? []).slice(0, 2);
    const passedChecks = v.checks.filter((c) => c.passed).length;
    const cost = (await this.d.ledger.summary(ini.id)).initiative!.spentUsd;
    const changed = ctx.changes?.length
      ? (v.addressed ?? []).map((a) => `${a.status === 'done' ? '✓' : a.status === 'declined' ? '✗' : '±'} ${ctx.changes!.find((c) => c.id === a.changeId)?.request ?? a.changeId}${a.status !== 'done' ? ` — ${a.explanation}` : ''}`).join('\n')
      : `${ctx.name}: ${truncate(ctx.hypothesis, 160)}`;
    const files = await this.versionFiles(ini, v, version, gate, critiques, ctx);
    await writeRepoFiles(this.d.repoRoot, files);
    if (this.d.publishToGitHub) {
      await this.d.outbox.enqueue(`gh:publish:${ini.id}:v${version}`, 'github.publish', {
        initiativeId: ini.id, version, title: `DRIVE&KAVA — ${ini.title} (v${version})`,
        body: `${changed}\n\nПроверки: ${passedChecks}/${v.checks.length}, оценка ${gate.score}/5. Ждёт решения владельца в Telegram.`,
        // Бинарные файлы передаются путём в рабочей копии, а не содержимым в JSON.
        files: files.map((f) => (typeof f.content === 'string' ? { path: f.path, content: f.content } : { path: f.path, source: join(this.d.repoRoot, f.path) })),
      });
    }
    await this.d.outbox.enqueue(`tg:card:${approval.id}`, 'owner.card', {
      initiativeId: ini.id, approvalId: approval.id, version,
      title: ini.title,
      changed,
      why: strengths.length ? strengths.join('; ') : `оценка критиков ${gate.score}/5`,
      schools: this.d.practitioners?.credit(v.signaturesUsed ?? []) ?? [],
      problem: ini.problem,
      status: `рендер экрана${v.states.length ? ` + ${v.states.length} состояния` : ''} · фото: ${v.photo === 'generated' ? 'сгенерированы' : 'заглушки (генерация не подключена)'} · движение: ${ctx.motion ? 'спецификация' : 'нет'}`,
      checks: `${passedChecks}/${v.checks.length}`,
      score: gate.score,
      costUsd: cost,
      images: [v.png, ...v.states.map((s) => s.path)],
      githubKey: this.d.publishToGitHub ? `gh:publish:${ini.id}:v${version}` : null,
    });
    ini.version = version;
    ini.approvalId = approval.id;
    ini.status = 'awaiting_owner';
    ini.pendingChanges = undefined;
    await this.event(ini, 'delivered', `v${version}`);
    await this.save(ini);
    await this.d.outbox.flush();
    return { approvalId: approval.id };
  }

  private async versionFiles(ini: Initiative, v: VariantResult, version: number, gate: GateResult, critiques: Critique[], ctx: { motion: MotionOut | null; selectionNotes: string[] }): Promise<RepoFile[]> {
    const base = `studio/initiatives/${ini.id}/v${version}`;
    const review = {
      initiative: ini.id, version, artifactHash: v.hash, gate,
      checks: v.checks, critiques: critiques.map((c) => ({ critic: c.critic, model: c.model, variants: c.variants.filter((x) => x.variantId === v.id) })),
      selectionNotes: ctx.selectionNotes, authorModel: v.authorModel, photo: v.photo, signaturesUsed: v.signaturesUsed ?? [],
    };
    const schools = this.d.practitioners?.credit(v.signaturesUsed ?? []) ?? [];
    const summary = [
      `# ${ini.title} — v${version}`, '',
      `Проблема: ${ini.problem}`, '',
      `Направление: ${v.name}. ${v.hypothesis}`, '',
      schools.length ? `Приёмы школ: ${schools.join('; ')}` : 'Приёмы школ: не заявлены.', '',
      `Обоснование: ${v.rationale}`, '',
      `Оценка: ${gate.score}/5. Автопроверки:`, '', '```', v.facts.text, '```', '',
      ctx.motion ? `Движение:\n\n\`\`\`json\n${JSON.stringify(ctx.motion, null, 2)}\n\`\`\`` : 'Движение: не проектировалось в этой версии.', '',
      `Статус: ждёт решения владельца. Полноразмерный рендер — во вложении Telegram и в хранилище артефактов.`, '',
    ].join('\n');
    return [
      { path: `${base}/spec.json`, content: JSON.stringify(v.spec, null, 2) + '\n' },
      { path: `${base}/review.json`, content: JSON.stringify(review, null, 2) + '\n' },
      { path: `${base}/summary.md`, content: summary },
      { path: `${base}/screen@1x.png`, content: await readFile(v.preview) },
      // Реестр предпочтений едет в том же PR: память в GitHub совпадает с рабочей.
      { path: this.d.prefs.relPath, content: await readFile(join(this.d.repoRoot, this.d.prefs.relPath), 'utf8') },
    ];
  }

  /** Решение владельца из Telegram. Проверяет, что решается актуальная версия. */
  async decide(approvalId: string, action: 'approve' | 'changes' | 'reject', opts: { feedback?: string; reason?: string } = {}): Promise<{ ok: boolean; message: string; initiative?: Initiative }> {
    const approval = await this.d.store.get<Approval>('approvals', approvalId);
    if (!approval) return { ok: false, message: 'Версия не найдена.' };
    const ini = await this.get(approval.initiativeId);
    const target = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested';
    // Повторный вход после сбоя посреди обработки того же решения разрешён.
    const resuming = approval.status === target && ini.status === 'awaiting_owner' && ini.approvalId === approval.id;
    if (approval.status !== 'pending' && !resuming) {
      return { ok: false, message: approval.status === 'superseded' ? 'Эта версия уже заменена новой.' : 'По этой версии уже принято решение.' };
    }
    if (ini.status !== 'awaiting_owner' || ini.approvalId !== approval.id) return { ok: false, message: 'Эта версия уже не ожидает решения.' };
    const now = this.d.clock.now();
    approval.decidedAt = now;
    const delivered = await this.d.store.get<VariantResult>('delivered', `${ini.id}-v${approval.version}`);
    const date = new Date(now).toISOString().slice(0, 10);

    if (action === 'approve') {
      approval.status = 'approved';
      await this.d.store.put('approvals', approval.id, approval);
      const rec = { id: `DEC-${date.replace(/-/g, '')}-${ini.id}`, initiativeId: ini.id, title: ini.title, version: approval.version, decision: 'approved' as const, date, artifactHash: approval.artifactHash, summary: `${delivered?.name ?? ''}: ${delivered?.hypothesis ?? ''}`.trim(), prUrl: ini.prUrl };
      const files = [decisionFile(rec)];
      await writeRepoFiles(this.d.repoRoot, files);
      await this.d.store.put('decisions', rec.id, { ...rec, screen: ini.screen });
      ini.status = 'approved';
      await this.event(ini, 'approved', `v${approval.version}`);
      await this.save(ini);
      if (this.d.publishToGitHub) await this.d.outbox.enqueue(`gh:decision:${approval.id}`, 'github.decision', { initiativeId: ini.id, decision: 'approved', files, version: approval.version });
      await this.notifyText(`approved:${approval.id}`, `✅ «${ini.title}» v${approval.version} утверждено как дизайн-направление. Решение ${rec.id} записано${this.d.publishToGitHub ? ' в GitHub' : ''}. Разработка и выпуск — отдельные этапы, без вашей команды не начинаются.`);
      return { ok: true, message: 'Одобрено', initiative: ini };
    }

    if (action === 'reject') {
      approval.status = 'rejected';
      approval.reason = opts.reason;
      await this.d.store.put('approvals', approval.id, approval);
      const rec = { id: `DEC-${date.replace(/-/g, '')}-${ini.id}`, initiativeId: ini.id, title: ini.title, version: approval.version, decision: 'rejected' as const, date, artifactHash: approval.artifactHash, reason: opts.reason ?? 'причина не указана', summary: `${delivered?.name ?? ''}: ${delivered?.hypothesis ?? ''}`.trim(), prUrl: ini.prUrl };
      const lessonId = `LES-${date.replace(/-/g, '')}-${ini.id}`;
      const files = [decisionFile(rec), lessonFile(lessonId, `Отклонено: ${ini.title}`, `Направление «${delivered?.name ?? '?'}» отклонено владельцем.\n\nПричина: ${opts.reason ?? 'не указана'}.\n\nГипотеза, которая не подошла: ${delivered?.hypothesis ?? '?'}`, date)];
      await writeRepoFiles(this.d.repoRoot, files);
      await this.d.store.put('decisions', rec.id, { ...rec, screen: ini.screen });
      ini.status = 'rejected';
      await this.event(ini, 'rejected', opts.reason);
      await this.save(ini);
      if (this.d.publishToGitHub) await this.d.outbox.enqueue(`gh:decision:${approval.id}`, 'github.decision', { initiativeId: ini.id, decision: 'rejected', files, version: approval.version });
      await this.notifyText(`rejected:${approval.id}`, `❌ «${ini.title}» отклонено. Причина сохранена и будет учтена в следующих задачах.`);
      return { ok: true, message: 'Отклонено', initiative: ini };
    }

    // На доработку: разобрать замечания, сохранить кандидатов в предпочтения, начать новый раунд.
    const text = (opts.feedback ?? approval.feedback ?? '').trim();
    if (!text) return { ok: false, message: 'Нужен текст замечаний.' };
    const j = this.journal(ini);
    // Разбор замечаний — до смены статусов: если модель недоступна, версия остаётся
    // в ожидании и владелец может повторить.
    const parsed = await j.step(`feedback:${approval.id}`, async () => (await this.callAgent<FeedbackOut>(ini, this.d.roles.get('studio-director'), 'extract', 'feedback', feedbackSchema, [
      { label: 'TASK', title: 'Разбери замечания владельца', body: `Замечания к версии v${approval.version} экрана «${ini.screen}»:\n«${text}»\nРазложи на конкретные правки (id c1, c2…). Отдельно — общие правила на будущее, только если владелец сформулировал их как общее отношение, а не правку этого экрана.` },
      { label: 'WORK', title: 'Узлы текущего экрана', body: delivered ? listNodes(delivered.spec) : '' },
    ], { maxTokens: 1200 })).value);
    approval.status = 'changes_requested';
    approval.feedback = text;
    await this.d.store.put('approvals', approval.id, approval);
    const promoted = await j.step(`prefs:${approval.id}`, async () => {
      const res = await this.d.prefs.addCandidates(parsed.preferenceCandidates, text, ini.id);
      if (res.file) await writeRepoFiles(this.d.repoRoot, [res.file]);
      return res.promoted;
    });
    ini.pendingChanges = parsed.changes;
    ini.round += 1;
    ini.status = 'running';
    await this.event(ini, 'changes_requested', truncate(text, 200));
    await this.save(ini);
    const promotedNote = promoted.length ? `\nЗапомнил как правило: ${promoted.map((p) => p.statement).join('; ')}` : '';
    await this.notifyText(`changes:${approval.id}`, `✏️ Принял правки к v${approval.version}:\n${parsed.changes.map((c, i) => `${i + 1}) ${c.request}`).join('\n')}${promotedNote}\nДелаю v${approval.version + 1}.`);
    return { ok: true, message: 'Принято на доработку', initiative: ini };
  }

  // ───────────────────────── служебное ─────────────────────────

  private async callAgent<T>(ini: Initiative, role: RoleProfile, taskClass: TaskClass, output: string, schema: Schema, sections: ContextSection[], opts: { maxTokens: number; images?: ImagePart[]; avoidFamily?: string; check?: (v: unknown) => string[]; reason?: string }): Promise<CompleteResult<T>> {
    return this.d.router.complete<T>({
      taskClass, initiativeId: ini.id, role: role.id, autonomous: ini.source === 'autonomous',
      system: buildSystem(role, taskClass, output, schema, { school: this.d.practitioners?.schoolSection(role.id) }), user: buildUser(sections),
      schema, maxTokens: opts.maxTokens, images: opts.images, avoidFamily: opts.avoidFamily, check: opts.check, reason: opts.reason,
    });
  }

  private journal(ini: Initiative): StepJournal {
    const j = new StepJournal(this.d.store, this.d.clock, ini.id);
    j.stopCheck = this.stopCheck;
    if (this.crashBefore) {
      j.crashBefore = this.crashBefore;
      this.crashBefore = null;
    }
    return j;
  }

  private async product(): Promise<string> {
    if (!this.productContext) this.productContext = await readFile(join(this.d.repoRoot, 'studio/context/product.md'), 'utf8');
    return this.productContext;
  }

  /** Касается ли инициатива получения, окна или оплаты — тогда команда видит реальное место. */
  private windowRelated(ini: Initiative): boolean {
    return ini.tags.some((t) => WINDOW_TAGS.has(t)) || /вікн|окн|авто|драйв|drive|видач|выдач|получ|оплат|checkout|pickup|order/i.test(`${ini.request} ${ini.problem} ${ini.screen}`);
  }

  /** Описание окна (product/space/drive-window.md) без служебных meta-комментариев. */
  private async spaceDoc(): Promise<string | null> {
    if (this.spaceText === undefined) {
      const raw = await readFile(join(this.d.repoRoot, SPACE_DOC), 'utf8').catch(() => null);
      this.spaceText = raw ? raw.replace(/<!--[\s\S]*?-->\n?/g, '').trim() : null;
    }
    return this.spaceText;
  }

  /** Фото окна владельца — критики сверяют подсказку с реальным местом. */
  private async spacePhoto(): Promise<ImagePart | null> {
    const b = await readFile(join(this.d.repoRoot, SPACE_PHOTO)).catch(() => null);
    return b ? { format: 'jpeg', base64: b.toString('base64'), label: 'реальное окно DRIVE&KAVA (фото владельца; красные линии — маршрут машины к окну)' } : null;
  }

  private allowedLatin(): Set<string> {
    const words = new Set(['drive', 'kava', 'drive&kava', 'lab', 'mood']);
    for (const item of this.d.catalog) for (const w of `${item.cat} ${item.name}`.split(/[^A-Za-z&]+/)) if (w) words.add(w.toLowerCase());
    return words;
  }

  private async latestDelivered(ini: Initiative): Promise<VariantResult> {
    const v = await this.d.store.get<VariantResult>('delivered', `${ini.id}-v${ini.version}`);
    if (!v) throw new Error(`Нет доставленной версии v${ini.version} для ${ini.id}`);
    return v;
  }

  private async notifyText(key: string, text: string): Promise<void> {
    await this.d.outbox.enqueue(`tg:text:${key}`, 'owner.text', { text });
    await this.d.outbox.flush();
  }

  async get(id: string): Promise<Initiative> {
    const ini = await this.d.store.get<Initiative>('initiatives', id);
    if (!ini) throw new Error(`Инициатива ${id} не найдена`);
    return ini;
  }

  async list(): Promise<Initiative[]> {
    return (await this.d.store.list<Initiative>('initiatives')).sort((a, b) => a.createdAt - b.createdAt);
  }

  async attachPr(initiativeId: string, prUrl: string, prNumber: number): Promise<void> {
    const ini = await this.get(initiativeId);
    ini.prUrl = prUrl;
    ini.prNumber = prNumber;
    await this.save(ini);
  }

  async approvals(): Promise<Approval[]> {
    return (await this.d.store.list<Approval>('approvals')).sort((a, b) => a.createdAt - b.createdAt);
  }

  private async save(ini: Initiative): Promise<void> {
    ini.updatedAt = this.d.clock.now();
    await this.d.store.put('initiatives', ini.id, ini);
  }

  private async event(ini: Initiative, event: string, detail?: string): Promise<void> {
    ini.history.push({ ts: this.d.clock.now(), event, detail });
    await this.save(ini);
  }
}

// ───────────────────────── типы ответов и помощники ─────────────────────────

interface TriageOut { isDesignTask: boolean; type: string; screen: string; title: string; problem: string; tags: string[]; priority: string }
interface PositionOut { stance: string; proposals: Array<{ idea: string; why: string }>; concerns: Array<{ issue: string; evidence: string }>; mustHave: string[]; references?: string[] }
interface BriefOut { problem: string; successCriteria: string[]; constraints: string[]; directions: Array<{ id: string; name: string; hypothesis: string; artIdea: string; structure: string; risks?: string[] }>; decisions?: string[] }
interface VariantOut { rationale: string; spec: ScreenSpec; addressed?: VariantResult['addressed']; signaturesUsed?: string[] }
interface PhotoOut { prompt: string; negativePrompt?: string; aspectRatio: string }
export interface MotionOut { transitions: Array<{ from: string; to: string; trigger: string; sharedElements?: string[]; spring: { duration: number; bounce: number }; choreography?: string }>; microinteractions?: Array<{ element: string; trigger: string; feedback: string }>; reducedMotion: string }
interface FeedbackOut { intent: string; changes: ChangeRequest[]; preferenceCandidates: Array<{ statement: string; scope: string; strength: 'hard' | 'soft' }> }

function similarity(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / Math.min(x.size, y.size);
}

/** Описание напитка для фото-брифа: из каталога меню; неподтверждённое помечается. */
export function drinkTruth(catalog: CatalogItem[], name: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-zа-яіїєґ0-9]/gi, '');
  const item = catalog.find((c) => norm(c.name) === norm(name)) ?? catalog.find((c) => norm(name).includes(norm(c.name)) || norm(c.name).includes(norm(name)));
  if (!item) return `«${name}» нет в меню v83 — описать по стандартному рецепту и пометить как непроверенное.`;
  const sizes = item.sizes.map(([v, p]) => `${v || 'обʼєм не вказаний'}${p !== null ? ` — ${p} ₴` : ''}`).join(', ') || 'обʼєм і ціна не вказані';
  const l = item.look;
  if (!l) return `${item.name} (${item.cat}): ${sizes}. Внешний вид не описан.`;
  return [
    `${item.name} (${item.cat}, ${item.mode === 'ice' ? 'холодный, со льдом' : 'горячий'}): ${sizes}.`,
    `Основа: ${l.base}. Слои и цвет: ${l.layers}. Лёд: ${l.ice}. Украшение: ${l.garnish}. Посуда: ${l.vessel}.`,
    l.status === 'hypothesis' ? 'ВНИМАНИЕ: внешний вид не подтверждён владельцем — карточка остаётся черновиком до подтверждения, «уточнить» не додумывать как факт.' : 'Внешний вид — стандартный рецепт.',
  ].join('\n');
}

function findHero(spec: ScreenSpec) {
  let hero: ScreenSpec['nodes'][number] | undefined;
  walk(spec.nodes, (n) => { if (!hero && n.role === 'hero') hero = n; });
  return hero;
}

function listNodes(spec: ScreenSpec): string {
  const out: string[] = [];
  walk(spec.nodes, (n, _p, depth) => out.push(`${'  '.repeat(depth)}${n.id} (${n.kind}${n.role ? `, ${n.role}` : ''})${n.text ? ` «${n.text}»` : ''}`));
  return out.join('\n');
}
