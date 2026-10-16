// Проект «приложение целиком»: студия работает как команда над всем приложением,
// а не над случайным экраном. Порядок — как в продуктовой команде Drinkit/Dodo:
//   1. старшие (директор студии, креативный директор, руководитель продуктового дизайна)
//      независимо дают позиции по всему приложению;
//   2. директор студии сводит их в концепцию: цель, принципы, визуальный язык, карта экранов;
//   3. ключевой экран делается первым — он задаёт визуальный язык;
//   4. остальные экраны — тем же конвейером (позиции, варианты, критика, старшие), в стиле ключевого;
//   5. ведущий показывает владельцу всё приложение одной карточкой; правки владельца
//      раскладываются по экранам, переделываются только затронутые.
// Владельцу между этапами — по одной короткой строке.

import { readFile } from 'node:fs/promises';
import type { ContextSection } from '../agents/prompt.ts';
import { APP_SCREENS, positionSchema, projectConceptSchema, projectFeedbackSchema, projectPitchSchema } from '../agents/schemas.ts';
import { BudgetExceeded, ModelChainExhausted, StopRequested } from '../core/errors.ts';
import { newId, sha256, truncate } from '../core/util.ts';
import { formatForPrompt } from '../knowledge/base.ts';
import { decisionFile, lessonFile, writeRepoFiles, type RepoFile } from '../memory/memory.ts';
import type { Store } from '../store/store.ts';
import { StepJournal } from './engine.ts';
import { explainChain, type Approval, type ChangeRequest, type Initiative, type Studio, type VariantResult } from './studio.ts';

export const PROJECT_SECTION = 'Проект:';
const SENIORS = ['studio-director', 'creative-director', 'head-of-product-design'];
const MAX_SCREENS = 8;

export interface ProjectScreen {
  screen: string;
  title: string;
  purpose: string;
  problem: string;
  tags: string[];
  initiativeId?: string;
  state: 'todo' | 'working' | 'ready' | 'blocked';
}

export interface ProjectConcept {
  title: string;
  goal: string;
  principles: string[];
  visual: { name: string; idea: string; palette: string; typography: string; motion: string; photo: string };
  flows: string[];
  anchor: string;
}

export interface AppProject {
  id: string;
  title: string;
  source: 'owner' | 'autonomous';
  status: 'running' | 'paused' | 'awaiting_owner' | 'approved' | 'rejected';
  pauseKind?: 'schedule' | 'budget' | 'models';
  pauseReason?: string;
  concept?: ProjectConcept;
  screens: ProjectScreen[];
  version: number;
  round: number;
  approvalId?: string;
  prUrl?: string;
  prNumber?: number;
  createdAt: number;
  updatedAt: number;
  history: Array<{ ts: number; event: string; detail?: string }>;
}

/** Секции промпта для экрана проекта: концепция и визуальный язык ключевого экрана. */
export async function projectContext(store: Store, ini: Initiative): Promise<ContextSection[]> {
  const p = ini.projectId ? await store.get<AppProject>('projects', ini.projectId) : null;
  if (!p?.concept) return [];
  const c = p.concept;
  const map = p.screens.map((s) => `${s.screen} — ${s.title}: ${s.purpose}`).join('\n');
  const out: ContextSection[] = [{
    label: 'STANDARD',
    title: `${PROJECT_SECTION} концепция приложения (утверждена старшими)`,
    body: [
      `Цель: ${c.goal}`,
      `Принципы: ${c.principles.join('; ')}`,
      `Визуальный язык «${c.visual.name}»: ${c.visual.idea}. Палитра: ${c.visual.palette}. Типографика: ${c.visual.typography}. Движение: ${c.visual.motion}. Напитки в кадре: ${c.visual.photo}.`,
      `Сценарии: ${c.flows.join(' → ')}`,
      `Карта экранов (этот экран — «${ini.screen}», остальные делает команда параллельно, связи между ними держи):\n${map}`,
    ].join('\n'),
  }];
  const anchor = p.screens.find((s) => s.screen === c.anchor);
  if (anchor?.initiativeId && anchor.screen !== ini.screen) {
    const a = await store.get<Initiative>('initiatives', anchor.initiativeId);
    const v = a && a.version ? await store.get<VariantResult>('delivered', `${a.id}-v${a.version}`) : null;
    if (v) {
      out.push({
        label: 'STANDARD',
        title: `${PROJECT_SECTION} визуальный язык — ключевой экран «${anchor.title}»`,
        body: `Это одно приложение: сохрани визуальный язык ключевого экрана — фон и цвета, типографику и кегли, форму кнопок, радиусы, отступы, подачу напитка. Содержание и структура — свои, под задачу этого экрана.\n${truncate(JSON.stringify(v.spec), 9000)}`,
      });
    }
  }
  return out;
}

export class ProjectRunner {
  studio: Studio;
  /** Очередь запусков (ставится при сборке): после правок владельца проект ставится в работу. */
  schedule: ((id: string) => void) | null = null;

  constructor(studio: Studio) {
    this.studio = studio;
  }

  private get d() {
    return this.studio.d;
  }

  async list(): Promise<AppProject[]> {
    return (await this.d.store.list<AppProject>('projects')).sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<AppProject> {
    const p = await this.d.store.get<AppProject>('projects', id);
    if (!p) throw new Error(`Проект ${id} не найден`);
    return p;
  }

  open(list: AppProject[]): AppProject | undefined {
    return list.find((p) => !['approved', 'rejected'].includes(p.status));
  }

  /**
   * Начать проект. Открытые одиночные самостоятельные задачи закрываются: их экраны
   * войдут в карту приложения, и команда сделает их в общем стиле.
   */
  async start(source: AppProject['source'] = 'owner'): Promise<{ project: AppProject; existing: boolean }> {
    const current = this.open(await this.list());
    if (current) return { project: current, existing: true };
    const now = this.d.clock.now();
    const p: AppProject = {
      id: newId('prj', now), title: 'Приложение DRIVE&KAVA целиком', source, status: 'running', screens: [], version: 0, round: 0,
      createdAt: now, updatedAt: now, history: [{ ts: now, event: 'created', detail: source }],
    };
    await this.save(p);
    for (const ini of await this.studio.list()) {
      if (ini.projectId || ini.source !== 'autonomous' || !['running', 'paused', 'blocked', 'failed'].includes(ini.status)) continue;
      ini.status = 'declined';
      ini.history.push({ ts: now, event: 'merged_into_project', detail: p.id });
      await this.d.store.put('initiatives', ini.id, ini);
    }
    return { project: p, existing: false };
  }

  /** Довести проект до следующей точки ожидания. Безопасно перезапускать: шаги в журнале. */
  async run(id: string): Promise<AppProject> {
    const owner = newId('runner', this.d.clock.now());
    const lease = `project-${id}`;
    if (!(await this.d.store.acquireLease(lease, owner, 60 * 60_000, this.d.clock.now()))) throw new Error(`Проект ${id} уже выполняется`);
    const p = await this.get(id);
    try {
      if (!['running', 'paused'].includes(p.status)) return p;
      p.status = 'running';
      p.pauseKind = undefined;
      p.pauseReason = undefined;
      await this.save(p);
      const j = this.journal(p);
      const presenter = this.presenter();
      await j.step('kickoff', async () => {
        await this.notify(`kickoff:${p.id}`, `🚀 Начали делать приложение целиком. Ведёт ${presenter.label}. Сначала старшие пишут концепцию и карту экранов, потом ключевой экран, потом остальные в его стиле. Покажу всё приложение сразу.`);
        return true;
      });
      if (!p.concept) await this.concept(p, j);
      for (const s of this.ordered(p)) {
        if (s.state === 'ready' || s.state === 'blocked') continue;
        const ini = await this.studio.createProjectScreen(p.id, p.source, s);
        s.initiativeId = ini.id;
        s.state = 'working';
        await this.save(p);
        let done = await this.studio.run(ini.id);
        // Не прошёл внутренний контроль — ещё одна попытка с дополнительной доработкой.
        if (done.status === 'blocked' && (done.attempt ?? 0) === 0) done = await this.studio.run(ini.id);
        if (done.status === 'paused' || done.status === 'failed' || done.status === 'running') {
          p.status = 'paused';
          p.pauseKind = done.pauseKind ?? (done.status === 'failed' ? 'models' : 'schedule');
          p.pauseReason = done.pauseReason;
          await this.event(p, 'paused', `${s.screen}: ${truncate(done.pauseReason ?? done.status, 160)}`);
          return p;
        }
        s.state = done.status === 'ready' ? 'ready' : 'blocked';
        await this.save(p);
        const ready = p.screens.filter((x) => x.state === 'ready').length;
        await this.notify(`progress:${p.id}:${s.screen}:r${done.round}`, s.state === 'ready'
          ? `${s.screen === p.concept?.anchor ? '🎯 Ключевой экран готов — он задаёт стиль остальным' : '✅ Готов экран'}: «${s.title}» (${ready} из ${p.screens.length}).`
          : `⚠️ «${s.title}» не прошёл внутренний контроль даже со второй попытки — покажу остальное и отмечу его.`);
      }
      await this.present(p, j);
      return p;
    } catch (err) {
      p.status = 'paused';
      if (err instanceof StopRequested || (err instanceof BudgetExceeded && err.scope === 'day')) {
        p.pauseKind = 'schedule';
        p.pauseReason = err.message;
      } else if (err instanceof BudgetExceeded) {
        p.pauseKind = 'budget';
        p.pauseReason = err.message;
        await this.notify(`pause:${p.id}:${p.round}:${err.scope}`, `⏸ Приложение на паузе: ${err.message}. Продолжу после /resume.`);
      } else if (err instanceof ModelChainExhausted) {
        p.pauseKind = 'models';
        p.pauseReason = err.message;
        await this.notify(`pause:${p.id}:${p.round}:models`, `⏸ Приложение на паузе: ${explainChain(err)} Продолжу после /resume.`);
      } else {
        p.pauseKind = 'models';
        p.pauseReason = (err as Error).message;
        await this.notify(`fail:${p.id}:${sha256((err as Error).message).slice(0, 8)}`, `❌ Приложение: сбой — ${truncate((err as Error).message, 200)}. Сделанное сохранено, /resume продолжит.`);
      }
      await this.event(p, 'paused', p.pauseReason);
      return p;
    } finally {
      await this.d.store.releaseLease(lease, owner);
    }
  }

  /** Позиции старших → концепция директора студии. */
  private async concept(p: AppProject, j: StepJournal): Promise<void> {
    const sections = await this.baseSections();
    const positions = await j.step('positions', async () => {
      const out: Array<{ role: string; stance: string; proposals: Array<{ idea: string; why: string }>; concerns: Array<{ issue: string; evidence: string }>; mustHave: string[] }> = [];
      for (const roleId of SENIORS.filter((r) => this.d.roles.has(r))) {
        const role = this.d.roles.get(roleId);
        const r = await this.studio.callAgent<{ stance: string; proposals: Array<{ idea: string; why: string }>; concerns: Array<{ issue: string; evidence: string }>; mustHave: string[] }>(p, role, 'position', 'position', positionSchema, [
          { label: 'TASK', title: 'Твоя позиция по всему приложению', body: 'Мы делаем приложение DRIVE&KAVA целиком — уровня Drinkit, Dodo и amo, по вкусу владельца. Ты старший в студии. До того как увидишь мнения коллег, скажи своим вкусом и опытом своей школы: каким должно быть это приложение, что в нём главное для гостя в машине у окна, какой характер, каких экранов не хватает, чего избегать. Опирайся на продукт, меню, реальное окно и базу знаний ниже.' },
          ...sections,
          { label: 'RESEARCH', title: 'Источники по твоей специализации', body: formatForPrompt(this.d.kb.search(`Drinkit amo Dodo приложение ${role.knowledgeTags.join(' ')}`, { k: 5, tags: role.knowledgeTags })) },
        ], { maxTokens: 1800 });
        out.push({ role: roleId, ...r.value });
      }
      return out;
    });
    const c = await j.step('concept', async () => (await this.studio.callAgent<ProjectConcept & { screens: Array<{ screen: string; title: string; purpose: string; problem: string; tags?: string[] }> }>(p, this.d.roles.get('studio-director'), 'brief', 'projectConcept', projectConceptSchema, [
      { label: 'TASK', title: 'Концепция приложения и карта экранов', body: `Сведи позиции старших в одну концепцию приложения. Споры закрой решением. Карта экранов — от ${3} до ${MAX_SCREENS} экранов, без которых приложение не работает для гостя у окна, в порядке сценария. Ключевой экран (anchor) — тот, что лучше всего задаёт визуальный язык; его сделают первым. Экраны — только из списка: ${APP_SCREENS.join(', ')}.` },
      { label: 'WORK', title: 'Позиции старших', body: positions.map((x) => `${x.role}: ${x.stance}\n  предложения: ${x.proposals.map((y) => y.idea).join('; ')}\n  опасения: ${x.concerns.map((y) => y.issue).join('; ')}\n  обязательно: ${x.mustHave.join('; ')}`).join('\n') },
      ...sections,
    ], { maxTokens: 3500 })).value);
    const seen = new Set<string>();
    const screens = c.screens.filter((s) => APP_SCREENS.includes(s.screen) && !seen.has(s.screen) && seen.add(s.screen)).slice(0, MAX_SCREENS);
    const anchor = screens.some((s) => s.screen === c.anchor) ? c.anchor : screens[0].screen;
    p.concept = { title: c.title, goal: c.goal, principles: c.principles, visual: c.visual, flows: c.flows, anchor };
    p.title = c.title || p.title;
    p.screens = screens.map((s) => ({ screen: s.screen, title: s.title, purpose: s.purpose, problem: s.problem, tags: s.tags ?? [], state: 'todo' }));
    await this.event(p, 'concept', `${p.screens.length} экранов, ключевой ${anchor}`);
    await writeRepoFiles(this.d.repoRoot, [{ path: `studio/projects/${p.id}/concept.md`, content: conceptMarkdown(p) }]);
    await this.notify(`concept:${p.id}`, `🧭 Концепция готова: «${p.concept.visual.name}». Экраны: ${p.screens.map((s) => s.title).join(', ')}. Начинаем с ключевого — «${p.screens.find((s) => s.screen === anchor)!.title}».`);
  }

  /** Ключевой экран первым, дальше — по карте. */
  private ordered(p: AppProject): ProjectScreen[] {
    const anchor = p.concept?.anchor;
    return [...p.screens].sort((a, b) => Number(b.screen === anchor) - Number(a.screen === anchor));
  }

  private presenter(): { roleId: string; label: string } {
    const roleId = [this.d.casting.review?.presenter.project, 'studio-director'].find((r): r is string => Boolean(r && this.d.roles.has(r)))!;
    return { roleId, label: this.studio.presenterLabel(roleId) };
  }

  /** Показ всего приложения: подача ведущего, альбом экранов, файлы в GitHub. */
  private async present(p: AppProject, j: StepJournal): Promise<void> {
    const version = await j.step(`present-version:${p.round}`, async () => p.version + 1);
    const screens: Array<{ s: ProjectScreen; ini: Initiative; v: VariantResult; meta: { score: number; strengths: string[]; addressed?: VariantResult['addressed']; changes?: ChangeRequest[] } | null }> = [];
    for (const s of this.ordered(p)) {
      if (s.state !== 'ready' || !s.initiativeId) continue;
      const ini = await this.studio.get(s.initiativeId);
      const v = await this.d.store.get<VariantResult>('delivered', `${ini.id}-v${ini.version}`);
      if (v) screens.push({ s, ini, v, meta: (await this.d.store.get('screen-meta', `${ini.id}-v${ini.version}`)) ?? null });
    }
    if (!screens.length) {
      p.status = 'paused';
      p.pauseKind = 'models';
      p.pauseReason = 'ни один экран не прошёл внутренний контроль';
      await this.event(p, 'paused', p.pauseReason);
      await this.notify(`empty:${p.id}:${p.round}`, '🧱 Ни один экран приложения не прошёл внутренний контроль — показывать нечего. /resume запустит ещё попытку.');
      return;
    }
    const presenter = this.presenter();
    const blocked = p.screens.filter((s) => s.state === 'blocked');
    const pitch = await j.step(`pitch:v${version}`, async () => {
      const images = [];
      for (const x of screens.slice(0, 4)) images.push({ format: 'png' as const, base64: (await readFile(x.v.preview)).toString('base64'), label: x.s.title });
      return (await this.studio.callAgent<{ headline: string; story: string; question: string; highlights?: Array<{ screen: string; note: string }> }>(p, this.d.roles.get(presenter.roleId), 'critique', 'projectPitch', projectPitchSchema, [
        { label: 'TASK', title: 'Покажи владельцу приложение', body: `Ты ведёшь проект и показываешь владельцу DRIVE&KAVA, что сделала команда (первые экраны приложены). Говори по-русски, коротко, своим профессиональным вкусом: что сделали, какие ключевые решения приняли и почему это уровень Drinkit/amo. Не льсти и не обещай того, чего нет на экранах. Закончи одним простым вопросом.${p.round ? '\nЭто версия после правок владельца — скажи, что изменили.' : ''}${blocked.length ? `\nНе вошли (не прошли контроль): ${blocked.map((b) => b.title).join(', ')} — скажи об этом честно.` : ''}` },
        { label: 'WORK', title: 'Концепция и экраны', body: `${conceptMarkdown(p)}\n\n${screens.map((x) => `${x.s.title}: ${x.v.name} — ${x.v.hypothesis}. Сильное: ${(x.meta?.strengths ?? []).join('; ') || '—'}`).join('\n')}` },
      ], { maxTokens: 1400, images })).value;
    });
    const now = this.d.clock.now();
    const approval: Approval = { id: `apr-${p.id}-v${version}`, initiativeId: p.id, version, artifactHash: sha256(screens.map((x) => x.v.hash).join('|')), status: 'pending', createdAt: now };
    if (p.approvalId && p.approvalId !== approval.id) {
      const prev = await this.d.store.get<Approval>('approvals', p.approvalId);
      if (prev?.status === 'pending') { prev.status = 'superseded'; await this.d.store.put('approvals', prev.id, prev); }
    }
    await this.d.store.put('approvals', approval.id, approval);

    const base = `studio/projects/${p.id}/v${version}`;
    const files: RepoFile[] = [{ path: `${base}/README.md`, content: projectReadme(p, version, presenter.label, pitch, screens.map((x) => ({ title: x.s.title, screen: x.s.screen, name: x.v.name, hypothesis: x.v.hypothesis, score: x.meta?.score })), blocked.map((b) => b.title)) }];
    for (const x of screens) {
      files.push({ path: `${base}/${x.s.screen}.png`, content: await readFile(x.v.preview) });
      files.push({ path: `${base}/${x.s.screen}.spec.json`, content: JSON.stringify(x.v.spec, null, 2) + '\n' });
    }
    await writeRepoFiles(this.d.repoRoot, files);
    const ghKey = `gh:publish:${p.id}:v${version}`;
    if (this.d.publishToGitHub) {
      await this.d.outbox.enqueue(ghKey, 'github.publish', {
        initiativeId: p.id, version, title: `DRIVE&KAVA — ${p.title} (v${version})`,
        body: `${pitch.headline}\n\n${pitch.story}\n\nЭкраны: ${screens.map((x) => x.s.title).join(', ')}. Ждёт решения владельца в Telegram.`,
        files: files.map((f) => (typeof f.content === 'string' ? { path: f.path, content: f.content } : { path: f.path, source: `${this.d.repoRoot}/${f.path}` })),
      });
    }
    const changed = p.round
      ? screens.filter((x) => x.meta?.changes?.length).map((x) => `${x.s.title}: ${(x.meta!.addressed ?? []).map((a) => `${a.status === 'done' ? '✓' : a.status === 'declined' ? '✗' : '±'} ${x.meta!.changes!.find((c) => c.id === a.changeId)?.request ?? a.changeId}`).join('; ')}`).join('\n') || 'правки учтены'
      : `экраны (${screens.length}): ${screens.map((x) => x.s.title).join(', ')}${blocked.length ? `. Не вошли: ${blocked.map((b) => b.title).join(', ')}` : ''}`;
    const cost = (await this.d.ledger.summary()).month.spentUsd;
    await this.d.outbox.enqueue(`tg:card:${approval.id}`, 'owner.card', {
      initiativeId: p.id, approvalId: approval.id, version,
      title: p.title,
      changed,
      why: (pitch.highlights ?? []).map((h) => `${h.screen}: ${h.note}`).join('; ') || pitch.story,
      schools: [],
      presenter: { label: presenter.label, headline: pitch.headline, story: pitch.story, question: pitch.question },
      references: [],
      autonomous: false,
      problem: p.concept?.goal ?? '',
      status: `экраны (${screens.length}): ${screens.map((x) => x.s.title).join(', ')}${blocked.length ? ` · не прошли контроль: ${blocked.map((b) => b.title).join(', ')}` : ''} · фото напитков: ${screens.some((x) => x.v.photo === 'generated') ? 'сгенерированы' : 'заглушки'}`,
      checks: `${screens.reduce((a, x) => a + x.v.checks.filter((c) => c.passed).length, 0)}/${screens.reduce((a, x) => a + x.v.checks.length, 0)}`,
      score: Math.round((screens.reduce((a, x) => a + (x.meta?.score ?? 0), 0) / screens.length) * 100) / 100,
      costUsd: cost,
      images: screens.slice(0, 10).map((x) => x.v.png),
      githubKey: this.d.publishToGitHub ? ghKey : null,
    });
    p.version = version;
    p.approvalId = approval.id;
    p.status = 'awaiting_owner';
    await this.event(p, 'presented', `v${version}`);
    await this.d.outbox.flush();
  }

  /** Решение владельца по всему приложению. */
  async decide(approvalId: string, action: 'approve' | 'changes' | 'reject', opts: { feedback?: string; reason?: string } = {}): Promise<{ ok: boolean; message: string; initiative?: Initiative }> {
    const approval = await this.d.store.get<Approval>('approvals', approvalId);
    if (!approval) return { ok: false, message: 'Версия не найдена.' };
    const p = await this.get(approval.initiativeId);
    const target = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested';
    const resuming = approval.status === target && p.status === 'awaiting_owner' && p.approvalId === approval.id;
    if (approval.status !== 'pending' && !resuming) return { ok: false, message: approval.status === 'superseded' ? 'Эта версия уже заменена новой.' : 'По этой версии уже принято решение.' };
    if (p.status !== 'awaiting_owner' || p.approvalId !== approval.id) return { ok: false, message: 'Эта версия уже не ожидает решения.' };
    const now = this.d.clock.now();
    const date = new Date(now).toISOString().slice(0, 10);
    approval.decidedAt = now;
    const handle = { id: p.id, title: p.title } as Initiative;

    if (action === 'approve' || action === 'reject') {
      approval.status = action === 'approve' ? 'approved' : 'rejected';
      approval.reason = opts.reason;
      await this.d.store.put('approvals', approval.id, approval);
      const rec = { id: `DEC-${date.replace(/-/g, '')}-${p.id}`, initiativeId: p.id, title: p.title, version: approval.version, decision: approval.status as 'approved' | 'rejected', date, artifactHash: approval.artifactHash, summary: `${p.concept?.visual.name ?? ''}: ${p.screens.filter((s) => s.state === 'ready').map((s) => s.title).join(', ')}`, prUrl: p.prUrl, ...(action === 'reject' ? { reason: opts.reason ?? 'причина не указана' } : {}) };
      const files = [decisionFile(rec)];
      if (action === 'reject') files.push(lessonFile(`LES-${date.replace(/-/g, '')}-${p.id}`, `Отклонено: ${p.title}`, `Концепция «${p.concept?.visual.name ?? '?'}» отклонена владельцем.\n\nПричина: ${opts.reason ?? 'не указана'}.`, date));
      await writeRepoFiles(this.d.repoRoot, files);
      for (const s of p.screens) {
        if (!s.initiativeId || s.state !== 'ready') continue;
        const ini = await this.studio.get(s.initiativeId);
        ini.status = approval.status as 'approved' | 'rejected';
        ini.history.push({ ts: now, event: approval.status, detail: `проект v${approval.version}` });
        await this.d.store.put('initiatives', ini.id, ini);
        await this.d.store.put('decisions', `${rec.id}-${s.screen}`, { ...rec, title: s.title, screen: s.screen });
      }
      p.status = approval.status as 'approved' | 'rejected';
      await this.event(p, approval.status, opts.reason);
      if (this.d.publishToGitHub) await this.d.outbox.enqueue(`gh:decision:${approval.id}`, 'github.decision', { initiativeId: p.id, decision: approval.status, files, version: approval.version });
      await this.notify(`${approval.status}:${approval.id}`, action === 'approve'
        ? `✅ Приложение v${approval.version} утверждено как дизайн-направление. Разработка и выпуск — отдельные этапы, без вашей команды не начинаются.`
        : '❌ Приложение отклонено. Причина сохранена — учтём в следующей концепции.');
      return { ok: true, message: action === 'approve' ? 'Одобрено' : 'Отклонено', initiative: handle };
    }

    const text = (opts.feedback ?? approval.feedback ?? '').trim();
    if (!text) return { ok: false, message: 'Нужен текст замечаний.' };
    const j = this.journal(p);
    const parsed = await j.step(`feedback:${approval.id}`, async () => (await this.studio.callAgent<{ changes: Array<{ id: string; screen: string; target: string; request: string }>; preferenceCandidates: Array<{ statement: string; scope: string; strength: 'hard' | 'soft' }> }>(p, this.d.roles.get('studio-director'), 'extract', 'projectFeedback', projectFeedbackSchema, [
      { label: 'TASK', title: 'Разложи замечания владельца по экранам', body: `Замечания владельца к приложению v${approval.version}:\n«${text}»\nРазложи на конкретные правки (id c1, c2…) и для каждой укажи экран из списка ниже; если правка про всё приложение (цвет, шрифт, общий стиль) — screen: all. Отдельно — общие правила на будущее, только если владелец сказал это как общее отношение.` },
      { label: 'WORK', title: 'Экраны приложения', body: p.screens.map((s) => `${s.screen} — ${s.title}`).join('\n') },
    ], { maxTokens: 1500 })).value);
    approval.status = 'changes_requested';
    approval.feedback = text;
    await this.d.store.put('approvals', approval.id, approval);
    await j.step(`prefs:${approval.id}`, async () => {
      const res = await this.d.prefs.addCandidates(parsed.preferenceCandidates, text, p.id);
      if (res.file) await writeRepoFiles(this.d.repoRoot, [res.file]);
      return res.promoted.length;
    });
    const known = new Set(p.screens.map((s) => s.screen));
    const touched: string[] = [];
    for (const s of p.screens) {
      if (!s.initiativeId || s.state !== 'ready') continue;
      // Правка без понятного экрана считается общей: лучше переделать лишнее, чем потерять слово владельца.
      const mine = parsed.changes.filter((c) => c.screen === s.screen || c.screen === 'all' || !known.has(c.screen));
      if (!mine.length) continue;
      const ini = await this.studio.get(s.initiativeId);
      ini.pendingChanges = mine.map((c) => ({ id: c.id, target: c.target, request: c.request }));
      ini.round += 1;
      ini.status = 'running';
      ini.history.push({ ts: now, event: 'changes_requested', detail: truncate(text, 200) });
      await this.d.store.put('initiatives', ini.id, ini);
      s.state = 'working';
      touched.push(s.title);
    }
    p.round += 1;
    p.status = 'running';
    await this.event(p, 'changes_requested', truncate(text, 200));
    await this.notify(`changes:${approval.id}`, `✏️ Принял правки:\n${parsed.changes.map((c, i) => `${i + 1}) ${c.request}`).join('\n')}\nПеределываем: ${touched.join(', ') || 'всё приложение'}. Пришлю v${approval.version + 1}.`);
    return { ok: true, message: 'Принято на доработку', initiative: handle };
  }

  async attachPr(projectId: string, prUrl: string, prNumber: number): Promise<void> {
    const p = await this.get(projectId);
    p.prUrl = prUrl;
    p.prNumber = prNumber;
    await this.save(p);
  }

  /** Строки для /status. */
  async statusLines(): Promise<string[]> {
    const p = this.open(await this.list());
    if (!p) return [];
    const ready = p.screens.filter((s) => s.state === 'ready').length;
    const phase = !p.concept ? 'старшие пишут концепцию' : p.status === 'awaiting_owner' ? `показано v${p.version}, ждёт вашего решения` : p.status === 'paused' ? `пауза: ${truncate(p.pauseReason ?? '', 80)}` : `экраны: готово ${ready} из ${p.screens.length}`;
    return [`📱 ${p.title} — ${phase}`];
  }

  private async baseSections(): Promise<ContextSection[]> {
    const prefs = await this.d.prefs.active();
    const cats = new Map<string, string[]>();
    for (const item of this.d.catalog) cats.set(item.cat, [...(cats.get(item.cat) ?? []), item.name]);
    const space = await readFile(`${this.d.repoRoot}/product/space/drive-window.md`, 'utf8').then((t) => t.replace(/<!--[\s\S]*?-->\n?/g, '').trim()).catch(() => '');
    return [
      { label: 'STANDARD', title: 'Продукт DRIVE&KAVA', body: await readFile(`${this.d.repoRoot}/studio/context/product.md`, 'utf8') },
      { label: 'OWNER PREFERENCES', title: 'Предпочтения владельца (обязательны)', body: prefs.map((x) => `${x.id} [${x.strength}] ${x.statement}`).join('\n') },
      { label: 'STANDARD', title: 'Принципы бренда', body: this.d.principles.map((x) => `${x.id} ${x.title}: ${x.rule}`).join('\n') },
      { label: 'STANDARD', title: 'Меню (v83)', body: [...cats].map(([c, items]) => `${c}: ${items.join(', ')}`).join('\n') },
      ...(space ? [{ label: 'STANDARD' as const, title: 'Реальное окно выдачи', body: truncate(space, 3000) }] : []),
    ];
  }

  private journal(p: AppProject): StepJournal {
    const j = new StepJournal(this.d.store, this.d.clock, p.id);
    j.stopCheck = this.studio.stopCheck;
    return j;
  }

  private async notify(key: string, text: string): Promise<void> {
    await this.d.outbox.enqueue(`tg:text:${key}`, 'owner.text', { text });
    await this.d.outbox.flush();
  }

  private async save(p: AppProject): Promise<void> {
    p.updatedAt = this.d.clock.now();
    await this.d.store.put('projects', p.id, p);
  }

  private async event(p: AppProject, event: string, detail?: string): Promise<void> {
    p.history.push({ ts: this.d.clock.now(), event, detail });
    await this.save(p);
  }
}

function conceptMarkdown(p: AppProject): string {
  const c = p.concept;
  if (!c) return '';
  return [
    `# ${c.title}`, '',
    `**Цель.** ${c.goal}`, '',
    '**Принципы.**', ...c.principles.map((x) => `- ${x}`), '',
    `**Визуальный язык «${c.visual.name}».** ${c.visual.idea}`, '',
    `- Палитра: ${c.visual.palette}`, `- Типографика: ${c.visual.typography}`, `- Движение: ${c.visual.motion}`, `- Напитки в кадре: ${c.visual.photo}`, '',
    `**Сценарии.** ${c.flows.join(' → ')}`, '',
    '**Карта экранов.**', ...p.screens.map((s) => `- ${s.screen === c.anchor ? '🎯 ' : ''}${s.title} (\`${s.screen}\`): ${s.purpose}`), '',
  ].join('\n');
}

function projectReadme(p: AppProject, version: number, presenter: string, pitch: { headline: string; story: string; question: string }, screens: Array<{ title: string; screen: string; name: string; hypothesis: string; score?: number }>, blocked: string[]): string {
  return [
    `> **${pitch.headline}** — ${presenter}`, `> ${pitch.story}`, `> Вопрос владельцу: ${pitch.question}`, '',
    conceptMarkdown(p),
    `## Экраны v${version}`, '',
    ...screens.map((s) => `### ${s.title}\n\n![${s.title}](${s.screen}.png)\n\n${s.name}: ${s.hypothesis}${s.score ? ` Оценка ${s.score}/5.` : ''}\n`),
    blocked.length ? `Не вошли (не прошли внутренний контроль): ${blocked.join(', ')}.` : '',
    '', 'Статус: ждёт решения владельца в Telegram.', '',
  ].join('\n');
}
