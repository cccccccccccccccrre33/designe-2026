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

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    default:
      console.log(readHelp());
  }
}

function readHelp(): string {
  return 'Команды: demo | new "<задача>" | status | budget | decide <id> approve|reject|changes "<текст>" | resume <id> | telegram | render <spec.json> | check-bedrock | eval | knowledge-ingest <file.md>';
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
  if (!key) throw new Error('Нужен AWS_BEARER_TOKEN_BEDROCK в .env');
  const bedrock = new BedrockRuntime({ apiKey: key, timeoutMs: 60_000 });
  const region = env('BEDROCK_REGION', config.models.region);
  console.log(`Регион: ${region}`);
  for (const m of config.models.models.filter((x) => x.enabled && x.kind === 'text')) {
    const started = Date.now();
    try {
      const res = await bedrock.chat({ model: m, region: m.region ?? region, system: 'Ответь одним словом.', user: 'Скажи «так».', maxTokens: 20 });
      console.log(`OK    ${m.key.padEnd(20)} ${m.modelId}  ${Date.now() - started} мс  «${res.text.trim().slice(0, 20)}»`);
    } catch (err) {
      console.log(`FAIL  ${m.key.padEnd(20)} ${m.modelId}  ${(err as Error).message.slice(0, 160)}`);
    }
  }
}

main().catch((err) => {
  console.error(`Ошибка: ${(err as Error).message}`);
  process.exitCode = 1;
});
