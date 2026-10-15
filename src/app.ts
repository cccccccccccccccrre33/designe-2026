// Сборка студии из конфигурации и окружения. Один и тот же набор компонентов
// используется CLI, ботом, демо и сквозными тестами.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PractitionerBook } from './agents/practitioners.ts';
import { RoleBook } from './agents/roles.ts';
import { BudgetLedger } from './budget/ledger.ts';
import { env, loadConfig, type StudioConfig } from './config/load.ts';
import { systemClock, type Clock } from './core/util.ts';
import { GitHubApi, Publisher, type PublishFile } from './github/publisher.ts';
import { KnowledgeBase } from './knowledge/base.ts';
import { BedrockRuntime } from './llm/bedrock.ts';
import { ModelRouter } from './llm/router.ts';
import { ScriptedProvider } from './llm/scripted.ts';
import type { ImageProvider, LlmProvider } from './llm/types.ts';
import { PreferenceRegistry, RoleNotes } from './memory/memory.ts';
import { ImageStudio } from './pipeline/images.ts';
import { Outbox } from './pipeline/outbox.ts';
import { Studio, type RendererLike } from './pipeline/studio.ts';
import { ScreenRenderer } from './render/renderer.ts';
import { FileStore, type Store } from './store/store.ts';
import { TelegramApi } from './telegram/api.ts';
import { OwnerBot, RunQueue, cardCaption, type CardPayload } from './telegram/bot.ts';

export interface AppOptions {
  repoRoot: string;
  dataDir?: string;
  mode?: 'live' | 'scripted';
  clock?: Clock;
  provider?: LlmProvider;
  imageProvider?: ImageProvider | null;
  renderer?: RendererLike & { close?: () => Promise<void> };
  /** Подмена HTTP для Telegram и GitHub в тестах. */
  telegram?: { token: string; ownerId: number; baseUrl?: string; fetchImpl?: typeof fetch } | null;
  github?: { token: string; repo: string; baseUrl?: string; fetchImpl?: typeof fetch } | null;
  budgetOverride?: Partial<StudioConfig['budget']['limits']>;
  quiet?: boolean;
}

export interface App {
  config: StudioConfig;
  store: Store;
  studio: Studio;
  outbox: Outbox;
  ledger: BudgetLedger;
  router: ModelRouter;
  queue: RunQueue;
  bot: OwnerBot | null;
  telegram: TelegramApi | null;
  provider: LlmProvider;
  close(): Promise<void>;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const repoRoot = opts.repoRoot;
  const dataDir = opts.dataDir ?? join(repoRoot, '.studio-data');
  const clock = opts.clock ?? systemClock;
  const config = await loadConfig(repoRoot);
  if (opts.budgetOverride) Object.assign(config.budget.limits, opts.budgetOverride);
  const store = new FileStore(dataDir);
  const ledger = new BudgetLedger(store, config.budget, clock);
  const mode = opts.mode ?? (env('STUDIO_MODE') === 'scripted' ? 'scripted' : 'live');

  let provider = opts.provider;
  let images: ImageProvider | null = opts.imageProvider ?? null;
  if (!provider) {
    if (mode === 'scripted') {
      provider = new ScriptedProvider(config.rubric.criteria.map((c) => c.id));
    } else {
      const bedrock = new BedrockRuntime({ apiKey: env('AWS_BEARER_TOKEN_BEDROCK') });
      provider = bedrock;
      if (opts.imageProvider === undefined && env('STUDIO_IMAGES') === 'on') images = bedrock;
    }
  }
  if (env('BEDROCK_REGION')) config.models.region = env('BEDROCK_REGION');

  const router = new ModelRouter({ config: config.models, provider, ledger, store, clock, evals: await loadEvals(repoRoot) });
  const roles = await RoleBook.load(join(repoRoot, 'studio/org/roles'));
  const practitioners = await PractitionerBook.load(join(repoRoot, 'studio/org/practitioners.json'));
  const schoolErrors = practitioners.validate(new Set(roles.all().map((r) => r.id)));
  if (schoolErrors.length) throw new Error(`studio/org/practitioners.json:\n${schoolErrors.join('\n')}`);
  const kb = await KnowledgeBase.load(repoRoot, ['knowledge/sources', 'knowledge/methods', 'knowledge/practitioners', 'product/space']);
  const prefs = new PreferenceRegistry(repoRoot, clock);
  const notes = new RoleNotes(store, clock);
  const renderer = opts.renderer ?? new ScreenRenderer(config.tokens, join(repoRoot, 'design-system'));
  const outbox = new Outbox(store, clock);
  const artifactsDir = join(dataDir, 'artifacts');
  const imageStudio = images ? new ImageStudio({ provider: images, config: config.models, ledger, store, clock, artifactsDir }) : null;

  const tgCfg = opts.telegram === undefined
    ? (env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_OWNER_ID') ? { token: env('TELEGRAM_BOT_TOKEN'), ownerId: Number(env('TELEGRAM_OWNER_ID')) } : null)
    : opts.telegram;
  const ghCfg = opts.github === undefined
    ? (env('GITHUB_TOKEN') && env('GITHUB_REPO') ? { token: env('GITHUB_TOKEN'), repo: env('GITHUB_REPO') } : null)
    : opts.github;

  const studio = new Studio({
    repoRoot, artifactsDir, store, clock, router, ledger, roles, kb, prefs, notes,
    tokens: config.tokens, casting: config.casting, rubric: config.rubric, catalog: config.catalog, principles: config.principles,
    renderer, outbox, images: imageStudio, publishToGitHub: Boolean(ghCfg), practitioners,
  });
  const queue = new RunQueue(studio, outbox);

  let telegram: TelegramApi | null = null;
  let bot: OwnerBot | null = null;
  if (tgCfg) {
    telegram = new TelegramApi(tgCfg.token, { baseUrl: tgCfg.baseUrl, fetchImpl: tgCfg.fetchImpl });
    bot = new OwnerBot({ api: telegram, studio, store, clock, ownerId: tgCfg.ownerId, scheduler: queue });
    bot.register(outbox);
  } else {
    // Без Telegram сообщения владельцу пишутся в консоль и журнал — честно, без имитации отправки.
    const log = join(dataDir, 'owner-console.log');
    await mkdir(dataDir, { recursive: true });
    const write = async (text: string) => {
      await appendFile(log, `[${new Date(clock.now()).toISOString()}]\n${text}\n\n`, 'utf8');
      if (!opts.quiet) console.log(`\n── сообщение владельцу (Telegram не подключён) ──\n${text}`);
      return { console: true };
    };
    outbox.on('owner.text', async (item) => write(String(item.payload.text)));
    outbox.on('owner.card', async (item) => {
      const p = item.payload as unknown as CardPayload;
      return write(`${cardCaption(p, '')}\nИзображения: ${p.images.join(', ')}\nРешение: npm run studio -- decide ${p.approvalId} approve|reject|changes "текст"`);
    });
  }

  if (ghCfg) {
    const publisher = new Publisher(new GitHubApi(ghCfg.token, ghCfg.repo, { baseUrl: ghCfg.baseUrl, fetchImpl: ghCfg.fetchImpl }), JSON.parse(await readFile(join(repoRoot, 'studio/policies/approvals.json'), 'utf8')));
    outbox.on('github.publish', async (item) => {
      const p = item.payload as { initiativeId: string; version: number; title: string; body: string; files: PublishFile[] };
      const res = await publisher.publishVersion(p);
      await studio.attachPr(p.initiativeId, res.prUrl, res.prNumber);
      return res;
    });
    outbox.on('github.decision', async (item) => {
      const p = item.payload as { initiativeId: string; decision: 'approved' | 'rejected'; files: PublishFile[]; version: number };
      return publisher.recordDecision(p);
    });
  }

  return {
    config, store, studio, outbox, ledger, router, queue, bot, telegram, provider,
    async close() {
      await renderer.close?.();
    },
  };
}

async function loadEvals(repoRoot: string): Promise<Record<string, Record<string, number>>> {
  try {
    const data = JSON.parse(await readFile(join(repoRoot, 'studio/evals/results.json'), 'utf8')) as { scores?: Record<string, Record<string, number>> };
    return data.scores ?? {};
  } catch {
    return {};
  }
}
