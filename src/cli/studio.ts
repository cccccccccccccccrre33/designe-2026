// CLI студии. Команды:
//   demo                         полный цикл на сценарном провайдере (без ключей), в копии репозитория
//   new "<задача>" [--scripted]  создать инициативу и довести до результата
//   status | budget              состояние и расходы
//   decide <approvalId> approve|reject|changes ["текст"]
//   resume <initiativeId>
//   telegram                     бот владельца (long polling)
//   render <spec.json> [out.png] отрисовать Screen Spec и прогнать автопроверки
//   check-bedrock                минимальный живой вызов каждой включённой модели
//   eval [--class c] [--models a,b] [--scripted]  сравнительное тестирование моделей
//   knowledge-ingest <file.md>   разобрать архив ссылок в knowledge/sources/inbox-*.md
//   analyze-video <файл> "<вопрос>" --seconds N   разбор видео видеомоделью (Pegasus)
//   actions-session [--minutes N] [--force] [--no-state] [--scripted]
//                                сессия в GitHub Actions: рабочие часы, Telegram, состояние (ADR-0007)

import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { PractitionerBook, renderPractitionerDocs } from '../agents/practitioners.ts';
import { RoleBook } from '../agents/roles.ts';
import { env, loadConfig, loadDotEnv } from '../config/load.ts';
import { runEval } from '../evals/runner.ts';
import { ingestLinkArchive } from '../knowledge/ingest.ts';
import { ScreenRenderer } from '../render/renderer.ts';
import { validateSpec, type ScreenSpec } from '../render/spec.ts';
import { factsSummary, runChecks } from '../review/checks.ts';
import { pollForever } from '../telegram/bot.ts';
import { BedrockRuntime } from '../llm/bedrock.ts';
import { GitHubApi } from '../github/publisher.ts';
import { publishWorkingCopy } from '../github/bootstrap.ts';
import { systemClock } from '../core/util.ts';
import { describeHours, loadSchedule, workWindow } from '../runtime/schedule.ts';
import { StateSync, stateKey, type RestoreReport } from '../runtime/state.ts';
import { formatSessionSummary, runSession } from '../runtime/session.ts';
import { VideoStudio } from '../pipeline/video.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadDotEnv(join(ROOT, '.env'));

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
  switch (cmd) {
    case 'demo':
      return demo();
    case 'new': {
      const text = args.filter((a) => !a.startsWith('--')).join(' ');
      if (!text) throw new Error('Использование: new "<задача>"');
      const app = await createApp({ repoRoot: ROOT, mode: flag('scripted') ? 'scripted' : undefined });
      try {
        const { initiative, duplicate } = await app.studio.intake(text);
        console.log(duplicate ? `Уже в работе: ${initiative.id}` : `Инициатива ${initiative.id}: ${initiative.title}`);
        if (!duplicate && initiative.status === 'running') {
          const done = await app.studio.run(initiative.id);
          console.log(`Статус: ${done.status}${done.pauseReason ? ` — ${done.pauseReason}` : ''}`);
        }
        await app.outbox.flush();
      } finally {
        await app.close();
      }
      return;
    }
    case 'status': {
      const app = await createApp({ repoRoot: ROOT, quiet: true });
      for (const i of await app.studio.list()) console.log(`${i.id}  ${i.status.padEnd(15)} v${i.version}  ${i.title}${i.approvalId && i.status === 'awaiting_owner' ? `  → ${i.approvalId}` : ''}`);
      const ob = await app.outbox.flush();
      console.log(`outbox: доставлено ${ob.delivered}, ожидает ${ob.pending}, ошибок ${ob.failed}`);
      await app.close();
      return;
    }
    case 'budget': {
      const app = await createApp({ repoRoot: ROOT, quiet: true });
      console.log(JSON.stringify(await app.ledger.summary(), null, 2));
      await app.close();
      return;
    }
    case 'decide': {
      const [approvalId, action, ...rest] = args;
      const map: Record<string, 'approve' | 'reject' | 'changes'> = { approve: 'approve', reject: 'reject', changes: 'changes' };
      if (!approvalId || !map[action]) throw new Error('Использование: decide <approvalId> approve|reject|changes ["текст"]');
      const app = await createApp({ repoRoot: ROOT, mode: flag('scripted') ? 'scripted' : undefined });
      try {
        const text = rest.filter((a) => !a.startsWith('--')).join(' ');
        const res = await app.studio.decide(approvalId, map[action], action === 'changes' ? { feedback: text } : { reason: text || undefined });
        console.log(res.message);
        if (res.ok && action === 'changes' && res.initiative) {
          const done = await app.studio.run(res.initiative.id);
          console.log(`Статус: ${done.status}`);
        }
        await app.outbox.flush();
      } finally {
        await app.close();
      }
      return;
    }
    case 'resume': {
      const app = await createApp({ repoRoot: ROOT, mode: flag('scripted') ? 'scripted' : undefined });
      try {
        const done = await app.studio.run(args[0]);
        console.log(`Статус: ${done.status}${done.pauseReason ? ` — ${done.pauseReason}` : ''}`);
        await app.outbox.flush();
      } finally {
        await app.close();
      }
      return;
    }
    case 'telegram': {
      const app = await createApp({ repoRoot: ROOT, mode: flag('scripted') ? 'scripted' : undefined });
      if (!app.bot || !app.telegram) throw new Error('Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_OWNER_ID в .env');
      console.log('Бот владельца запущен (long polling). Ctrl+C — остановить.');
      setInterval(() => { void app.outbox.flush(); }, 15_000);
      await pollForever(app.telegram, app.bot, app.store);
      return;
    }
    case 'render': {
      const [specPath, outPath] = args;
      const config = await loadConfig(ROOT);
      const spec = JSON.parse(await readFile(specPath, 'utf8')) as ScreenSpec;
      const errors = validateSpec(spec, config.tokens);
      if (errors.length) throw new Error(`Spec некорректна:\n${errors.join('\n')}`);
      const renderer = new ScreenRenderer(config.tokens, join(ROOT, 'design-system'));
      const res = await renderer.render(spec, { scale: 3 });
      const out = outPath ?? specPath.replace(/\.json$/, '.png');
      await writeFile(out, res.png);
      await renderer.close();
      console.log(`PNG: ${out}\n${factsSummary(runChecks(spec, res.measurements, { allowedLatin: new Set(['drive', 'kava', 'lab']), ownerHardChecks: new Set() })).text}`);
      return;
    }
    case 'check-bedrock':
      return checkBedrock();
    case 'eval': {
      const res = await runEval({ repoRoot: ROOT, taskClass: opt('class'), models: opt('models')?.split(','), scripted: flag('scripted') });
      console.log(res.table);
      return;
    }
    case 'publish-repo': {
      const token = env('GITHUB_TOKEN');
      if (!token) throw new Error('Нужен GITHUB_TOKEN в .env (fine-grained, только designe-2026: Contents и Pull requests — Read and write)');
      const gh = new GitHubApi(token, env('GITHUB_REPO', 'cccccccccccccccrre33/designe-2026'));
      const res = await publishWorkingCopy(gh, ROOT, {
        branch: opt('branch') ?? 'studio-foundation',
        title: 'DRIVE&KAVA AI Studio: основа студии и школы практиков',
        body: 'Архитектура, оргструктура (44 роли и школы практиков Drinkit/Dodo/amo), конвейер, рендер и автопроверки, Telegram-бот, публикация в GitHub, тесты. Подробности — README.md и docs/ARCHITECTURE.md.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      });
      console.log(`Файлов: ${res.files}, коммит ${res.commitSha}\nPR: ${res.prUrl}`);
      return;
    }
    case 'practitioners-docs': {
      const book = await PractitionerBook.load(join(ROOT, 'studio/org/practitioners.json'));
      const roles = await RoleBook.load(join(ROOT, 'studio/org/roles'));
      const errors = book.validate(new Set(roles.all().map((r) => r.id)));
      if (errors.length) throw new Error(errors.join('\n'));
      const files = renderPractitionerDocs(book, roles.all());
      for (const f of files) {
        await mkdir(dirname(join(ROOT, f.path)), { recursive: true });
        await writeFile(join(ROOT, f.path), f.content, 'utf8');
      }
      console.log(`Сгенерировано файлов: ${files.length}`);
      return;
    }
    case 'knowledge-ingest': {
      const out = await ingestLinkArchive(ROOT, args[0]);
      console.log(`Создано: ${out.path} (${out.count} ссылок, тир D до проверки)`);
      return;
    }
    case 'actions-session':
      return actionsSession();
    case 'analyze-video':
      return analyzeVideo();
    default:
      console.log(readHelp());
  }
}

function readHelp(): string {
  return 'Команды: demo | new "<задача>" | status | budget | decide <id> approve|reject|changes "<текст>" | resume <id> | telegram | render <spec.json> | check-bedrock | eval | knowledge-ingest <file.md> | actions-session';
}

/** Сводка на странице запуска GitHub Actions (и в консоль). */
async function summary(md: string): Promise<void> {
  console.log(md);
  const file = env('GITHUB_STEP_SUMMARY');
  if (file) await appendFile(file, md, 'utf8');
}

/**
 * Сессия в GitHub Actions (ADR-0007). Ночью и без секретов — выход с кодом 0 и понятной
 * сводкой, без вызовов моделей. Иначе: состояние из ветки studio-state → работа до конца
 * сессии или рабочего дня → сохранение состояния.
 */
async function actionsSession(): Promise<void> {
  const schedule = await loadSchedule(ROOT);
  const force = flag('force') || env('STUDIO_FORCE') === 'true';
  const minutes = Number(opt('minutes') ?? env('STUDIO_MINUTES', String(schedule.session.maxMinutes)));
  if (!(minutes > 0 && minutes <= 330)) throw new Error('Длительность сессии — от 1 до 330 минут');
  const scripted = flag('scripted');
  const useState = !flag('no-state');

  const window = workWindow(systemClock.now(), schedule);
  if (!window.open && !force) {
    await summary(formatSessionSummary({
      status: 'night', local: window.local, minutesToOpen: window.minutesToOpen, hours: describeHours(schedule), stoppedBy: null, paused: false,
      updates: 0, resumed: [], task: null, initiatives: [], budget: null, saves: 0, errors: [],
    }));
    return;
  }

  const missing: string[] = [];
  if (!scripted && !env('AWS_BEARER_TOKEN_BEDROCK')) missing.push('AWS_BEARER_TOKEN_BEDROCK (ключ Bedrock)');
  if (useState && !env('STUDIO_STATE_KEY')) missing.push('STUDIO_STATE_KEY (ключ шифрования состояния)');
  if (missing.length) {
    await summary(`## Студия DRIVE&KAVA\n\n⏳ Студия не запущена: не заданы секреты репозитория — ${missing.join(', ')}. Как добавить — docs/SETUP.md, раздел «GitHub Actions».\n`);
    return;
  }
  if (!env('TELEGRAM_BOT_TOKEN') || !env('TELEGRAM_OWNER_ID')) console.log('Telegram не подключён: сессия выполнит начатую работу и задачу из ручного запуска, сообщения владельцу — в журнал.');
  if (!env('GITHUB_REPO') && env('GITHUB_REPOSITORY')) process.env.GITHUB_REPO = env('GITHUB_REPOSITORY');

  const state = useState
    ? new StateSync({ repoRoot: ROOT, dataDir: join(ROOT, '.studio-data'), key: stateKey(env('STUDIO_STATE_KEY')), clock: systemClock, retention: schedule.retention })
    : null;
  let restored: RestoreReport | null = null;
  if (state) {
    restored = await state.restore();
    console.log(restored.restored ? `Состояние восстановлено: ${restored.files} файлов, коммит ${restored.commit?.slice(0, 7)}` : 'Состояния ещё нет — первая сессия.');
  }
  const extra: string[] = [];
  if (restored?.overlaySkipped.length) extra.push('', `Файлы студии, изменённые в main за это время (оставлена версия main): ${restored.overlaySkipped.join(', ')}.`);

  const app = await createApp({ repoRoot: ROOT, mode: scripted ? 'scripted' : undefined, quiet: true });
  try {
    const report = await runSession({
      app, schedule, clock: systemClock, maxMs: minutes * 60_000, force,
      save: state ? (reason) => state.save(reason) : undefined,
      task: env('STUDIO_TASK') || undefined,
      log: (line) => console.log(line),
    });
    await summary(formatSessionSummary(report, extra));
  } catch (err) {
    // Сбой посреди сессии: сохранить то, что уже сделано и оплачено.
    if (state) await state.save('error').catch((e) => console.error(`Состояние не сохранено: ${(e as Error).message}`));
    throw err;
  } finally {
    await app.close();
  }
  // Незавершённые сетевые вызовы не должны держать задание до таймаута: состояние уже сохранено.
  process.exit(process.exitCode ?? 0);
}

/** Демо полного цикла в копии репозитория: рабочая копия не меняется. */
async function demo(): Promise<void> {
  const demoRoot = join(ROOT, '.demo');
  await rm(demoRoot, { recursive: true, force: true });
  await mkdir(demoRoot, { recursive: true });
  for (const dir of ['studio', 'design-system', 'knowledge', 'product']) await cp(join(ROOT, dir), join(demoRoot, dir), { recursive: true });
  const app = await createApp({ repoRoot: demoRoot, dataDir: join(demoRoot, '.studio-data'), mode: 'scripted', telegram: null, github: null });
  const line = (s: string) => console.log(`\n=== ${s}`);
  try {
    line('1. Владелец: «Главный экран выглядит красиво, но нужный напиток ищется слишком долго»');
    const { initiative } = await app.studio.intake('Главный экран выглядит красиво, но пользователь слишком долго ищет нужный напиток');
    line(`2. Инициатива ${initiative.id} — команда работает`);
    let ini = await app.studio.run(initiative.id);
    line(`3. Статус: ${ini.status}, версия v${ini.version}`);
    line('4. Владелец: «На доработку: уберите большую плашку снизу, сделайте кнопки прозрачнее, а сам напиток немного крупнее»');
    const res = await app.studio.decide(ini.approvalId!, 'changes', { feedback: 'Уберите большую плашку снизу, сделайте кнопки прозрачнее, а сам напиток немного крупнее. Я вообще не люблю тяжёлые плашки.' });
    console.log(res.message);
    ini = await app.studio.run(initiative.id);
    line(`5. Статус: ${ini.status}, версия v${ini.version}`);
    line('6. Владелец: «Одобрить»');
    const ok = await app.studio.decide(ini.approvalId!, 'approve');
    console.log(ok.message);
    const s = await app.ledger.summary(initiative.id);
    line('Итог');
    console.log(`Артефакты: ${join(demoRoot, '.studio-data', 'artifacts', initiative.id)}`);
    console.log(`Записи для GitHub: ${join(demoRoot, 'studio')}`);
    console.log(`Вызовов моделей: ${s.initiative!.calls}, расчётная стоимость $${s.initiative!.spentUsd} (по ценам реестра; вызовы сценарные, деньги не тратились)`);
    console.log('Важно: сценарный провайдер проверяет механику, а не качество дизайна. Качество покажут живые модели Bedrock.');
  } finally {
    await app.close();
  }
}

async function checkBedrock(): Promise<void> {
  const config = await loadConfig(ROOT);
  const key = env('AWS_BEARER_TOKEN_BEDROCK');
  if (!key) {
    await summary('## Проверка моделей\n\n⏳ Нет секрета AWS_BEARER_TOKEN_BEDROCK — проверять нечем.\n');
    return;
  }
  const bedrock = new BedrockRuntime({ apiKey: key, timeoutMs: 90_000 });
  const region = env('BEDROCK_REGION', config.models.region);
  const rows: string[] = [];
  let ok = 0;
  const textModels = config.models.models.filter((x) => x.enabled && x.kind === 'text');
  for (const m of textModels) {
    const started = Date.now();
    try {
      // 512 токенов: модели с рассуждением тратят часть ответа на «размышление».
      const res = await bedrock.chat({ model: m, region: m.region ?? region, system: 'Ответь одним словом.', user: 'Скажи «так».', maxTokens: 512 });
      ok++;
      rows.push(`| ✅ | ${m.key} | \`${m.modelId}\` | ${Date.now() - started} мс | «${res.text.trim().slice(0, 20).replace(/\|/g, '/')}» |`);
    } catch (err) {
      rows.push(`| ❌ | ${m.key} | \`${m.modelId}\` | — | ${(err as Error).message.slice(0, 160).replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
    }
  }
  const skipped = config.models.models.filter((x) => x.enabled && x.kind !== 'text').map((x) => x.key);
  await summary([
    `## Проверка моделей Bedrock (${region})`, '',
    `Отвечают ${ok} из ${textModels.length} текстовых моделей. Каждый вызов — несколько токенов, доли цента.`, '',
    '| | Модель | ID | Время | Ответ или ошибка |', '|---|---|---|---|---|', ...rows, '',
    `Не проверялись (платный вызов с картинкой или видео): ${skipped.join(', ')}.`,
    'Модель с ❌ студия просто пропускает и берёт следующую из списка.', '',
  ].join('\n'));
}

/** Разбор видео видеомоделью (Pegasus): analyze-video <файл.mp4> "<вопрос>" --seconds N */
async function analyzeVideo(): Promise<void> {
  const [file, ...rest] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--seconds');
  const prompt = rest.join(' ');
  if (!file || !prompt) throw new Error('Использование: analyze-video <файл.mp4> "<что узнать о видео>" --seconds <длительность>');
  const app = await createApp({ repoRoot: ROOT, quiet: true, telegram: null, github: null });
  try {
    const key = env('AWS_BEARER_TOKEN_BEDROCK');
    if (!key) throw new Error('Нужен AWS_BEARER_TOKEN_BEDROCK');
    const studio = new VideoStudio({ provider: new BedrockRuntime({ apiKey: key, timeoutMs: 600_000 }), config: app.config.models, ledger: app.ledger });
    const res = await studio.analyze({ initiativeId: 'video-cli', prompt, video: await readFile(file), seconds: Number(opt('seconds')) });
    console.log(`${res.text}\n\n(${res.model}, ≈$${res.costUsd})`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`Ошибка: ${(err as Error).message}`);
  process.exitCode = 1;
});
