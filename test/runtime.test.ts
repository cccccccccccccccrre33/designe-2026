// Работа в GitHub Actions (ADR-0007): рабочие часы, зашифрованное состояние в ветке
// studio-state и сессии. «GitHub» — локальный bare-репозиторий, «машина задания» —
// новый клон; Telegram — поддельный, модели — сценарные, рендер — настоящий Chrome.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { ScreenRenderer, findBrowser } from '../src/render/renderer.ts';
import type { Tokens } from '../src/render/spec.ts';
import { loadSchedule, validateSchedule, workWindow } from '../src/runtime/schedule.ts';
import { StateSync, decrypt, encrypt, relocatePaths, stateKey } from '../src/runtime/state.ts';
import { formatSessionSummary, runSession } from '../src/runtime/session.ts';
import { FakeTelegram, REPO, tempRepo, update } from './helpers.ts';

const OWNER = 4242;
const schedule = await loadSchedule(REPO);
const at = (iso: string) => Date.parse(iso);
const criteria = JSON.parse(await readFile(join(REPO, 'studio/org/rubric.json'), 'utf8')).criteria.map((c: { id: string }) => c.id);
const tokens = JSON.parse(await readFile(join(REPO, 'design-system/tokens.json'), 'utf8')) as Tokens;
const renderer = new ScreenRenderer(tokens, join(REPO, 'design-system'));
after(() => renderer.close());

const GIT = process.env.GIT_BIN || 'git';
const hasGit = spawnSync(GIT, ['--version']).status === 0;
const noGit = !hasGit && 'нет git';
const noChrome = !findBrowser() && 'нет Chrome/Edge';
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(GIT, ['-c', 'core.autocrlf=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** «GitHub»: bare-репозиторий с main; clone() — свежая машина задания. */
async function fakeOrigin(withStudio: boolean) {
  const base = await mkdtemp(join(tmpdir(), 'dk-git-'));
  const remote = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = withStudio ? await tempRepo() : join(base, 'seed');
  if (!withStudio) {
    await mkdir(join(seed, 'studio/context'), { recursive: true });
    await writeFile(join(seed, 'studio/context/owner-preferences.json'), '{"v":1}\n');
  }
  await writeFile(join(seed, '.gitignore'), '.studio-data/\n');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  let n = 0;
  return {
    seed,
    clone(): string {
      const dir = join(base, `job${++n}`);
      git(base, 'clone', '-q', remote, dir);
      git(dir, 'config', 'core.autocrlf', 'false');
      return dir;
    },
  };
}

const retention = { closedArtifactsDays: 3, telegramSeenDays: 7 };

// ───────────────────────── рабочие часы ─────────────────────────

test('часы работы: 08:00–23:00 по Киеву и летом, и зимой', () => {
  assert.equal(workWindow(at('2026-07-15T04:59:00Z'), schedule).open, false); // лето, 07:59
  assert.equal(workWindow(at('2026-07-15T05:00:00Z'), schedule).open, true); // 08:00
  assert.equal(workWindow(at('2026-07-15T19:59:00Z'), schedule).open, true); // 22:59
  assert.equal(workWindow(at('2026-07-15T20:00:00Z'), schedule).open, false); // 23:00
  assert.equal(workWindow(at('2026-12-15T05:59:00Z'), schedule).open, false); // зима, 07:59
  assert.equal(workWindow(at('2026-12-15T06:00:00Z'), schedule).open, true);
  assert.equal(workWindow(at('2026-12-15T20:59:00Z'), schedule).open, true);
  assert.equal(workWindow(at('2026-12-15T21:00:00Z'), schedule).open, false);
  const evening = workWindow(at('2026-07-15T19:00:00Z'), schedule);
  assert.equal(evening.minutesToClose, 60);
  assert.equal(evening.local, '22:00 ср');
  const midnight = workWindow(at('2026-07-15T21:00:00Z'), schedule);
  assert.equal(midnight.open, false);
  assert.equal(midnight.minutesToOpen, 8 * 60);
});

test('часы работы: выходные и окно через полночь; ошибки в файле видны сразу', () => {
  const weekdays = { ...schedule, days: ['mon', 'tue', 'wed', 'thu', 'fri'] };
  const saturday = workWindow(at('2026-07-18T09:00:00Z'), weekdays); // сб 12:00
  assert.equal(saturday.open, false);
  assert.equal(saturday.minutesToOpen, 44 * 60); // до пн 08:00
  const night = { ...schedule, workHours: { start: '20:00', end: '02:00' } };
  const w = workWindow(at('2026-07-15T22:00:00Z'), night); // чт 01:00
  assert.equal(w.open, true);
  assert.equal(w.minutesToClose, 60);
  assert.deepEqual(validateSchedule(schedule), []);
  const bad = validateSchedule({ ...schedule, timezone: 'Mars/Base', workHours: { start: '8:00', end: '23:00' } });
  assert.ok(bad.some((e) => e.includes('часовой пояс')) && bad.some((e) => e.includes('ЧЧ:ММ')));
});

// ───────────────────────── шифрование ─────────────────────────

test('шифрование состояния: AES-256-GCM, чужой ключ и подмена файла не проходят', () => {
  const key = stateKey(randomBytes(32).toString('base64'));
  const blob = encrypt(key, Buffer.from('бюджет и решения владельца'), 'data:budget/ledger.json');
  assert.ok(!blob.includes(Buffer.from('владельца')));
  assert.equal(decrypt(key, blob, 'data:budget/ledger.json').toString(), 'бюджет и решения владельца');
  assert.throws(() => decrypt(stateKey(randomBytes(32).toString('base64')), blob, 'data:budget/ledger.json'), /неверный STUDIO_STATE_KEY/);
  assert.throws(() => decrypt(key, blob, 'data:другой-файл.json'), /неверный STUDIO_STATE_KEY/);
  assert.throws(() => stateKey('короткий'), /32 байт/);
});

test('перенос путей: старая папка заменяется новой за один проход', () => {
  const text = JSON.stringify({ png: '/a/repo/.studio-data/artifacts/x.png', src: '/a/repo/studio/v1.png', win: 'C:\\w\\repo\\.studio-data\\a.png' });
  const out = JSON.parse(relocatePaths(text, [['/a/repo/.studio-data', '/a/repo2/.studio-data'], ['/a/repo', '/a/repo2'], ['C:\\w\\repo', 'D:\\job']]));
  assert.equal(out.png, '/a/repo2/.studio-data/artifacts/x.png');
  assert.equal(out.src, '/a/repo2/studio/v1.png');
  assert.equal(out.win, 'D:\\job\\.studio-data\\a.png');
});

// ───────────────────────── ветка состояния ─────────────────────────

test('состояние: сохраняется зашифрованным, восстанавливается на новой машине, блокировки и старьё не переносятся', { skip: noGit }, async () => {
  const origin = await fakeOrigin(false);
  const key = stateKey(randomBytes(32).toString('base64'));
  const now = at('2026-07-15T10:00:00Z');
  const clock = { now: () => now };
  const w1 = origin.clone();
  const d1 = join(w1, '.studio-data');
  const put = async (path: string, content: string | Buffer) => {
    await mkdir(join(d1, path, '..'), { recursive: true });
    await writeFile(join(d1, path), content);
  };
  await put('initiatives/ini-1.json', JSON.stringify({ id: 'ini-1', status: 'awaiting_owner', updatedAt: now, title: 'секрет владельца', png: join(d1, 'artifacts/ini-1/screen.png') }));
  await put('artifacts/ini-1/screen.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  await put('initiatives/ini-old.json', JSON.stringify({ id: 'ini-old', status: 'approved', updatedAt: now - 10 * 86_400_000 }));
  await put('artifacts/ini-old/a.png', Buffer.from([1]));
  await put('leases/initiative-ini-1.lock', '{}');
  await put('tg-seen/1.json', JSON.stringify({ ts: now - 30 * 86_400_000 }));
  await put('tg-seen/2.json', JSON.stringify({ ts: now }));
  await writeFile(join(w1, 'studio/context/owner-preferences.json'), '{"v":2,"note":"кандидат владельца"}\n');
  await mkdir(join(w1, 'studio/decisions'), { recursive: true });
  await writeFile(join(w1, 'studio/decisions/DEC-1.md'), '# решение\n');

  const s1 = new StateSync({ repoRoot: w1, dataDir: d1, key, clock, retention });
  await assert.rejects(s1.save('рано'), /Сначала restore/);
  assert.equal((await s1.restore()).restored, false); // ветки ещё нет — первая сессия
  const saved = await s1.save('test');
  assert.equal(saved.files, 4); // ini-1, ini-old, screen.png, tg-seen/2
  assert.equal(saved.overlay, 2);

  // В публичном репозитории — только шифротекст.
  const w2 = origin.clone();
  git(w2, 'fetch', '-q', 'origin', 'studio-state');
  for (const name of git(w2, 'ls-tree', '-r', '--name-only', 'FETCH_HEAD').split('\n')) {
    const blob = spawnSync(GIT, ['show', `FETCH_HEAD:${name}`], { cwd: w2 }).stdout as Buffer;
    for (const secret of ['секрет владельца', 'кандидат владельца', 'ini-1', 'решение']) assert.ok(!blob.includes(Buffer.from(secret)), `${secret} в ${name}`);
  }
  assert.equal(git(w2, 'rev-list', '--count', 'FETCH_HEAD'), '1'); // без истории

  // Новая машина в другой папке: данные, пути и файлы студии на месте.
  const w3 = origin.clone();
  const d3 = join(w3, '.studio-data');
  const r = await new StateSync({ repoRoot: w3, dataDir: d3, key, clock, retention }).restore();
  assert.equal(r.restored, true);
  assert.equal(r.files, 4);
  assert.deepEqual(r.overlayApplied.sort(), ['studio/context/owner-preferences.json', 'studio/decisions/DEC-1.md']);
  const ini = JSON.parse(await readFile(join(d3, 'initiatives/ini-1.json'), 'utf8'));
  assert.equal(ini.title, 'секрет владельца');
  assert.equal(ini.png, join(d3, 'artifacts/ini-1/screen.png'));
  assert.deepEqual(await readFile(join(d3, 'artifacts/ini-1/screen.png')), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  assert.ok(!existsSync(join(d3, 'leases')));
  assert.ok(!existsSync(join(d3, 'tg-seen/1.json')));
  assert.ok(!existsSync(join(d3, 'artifacts/ini-old')));
  assert.match(await readFile(join(w3, 'studio/context/owner-preferences.json'), 'utf8'), /кандидат владельца/);

  // Чужой ключ: сессия не стартует с пустым состоянием поверх настоящего.
  await assert.rejects(new StateSync({ repoRoot: origin.clone(), dataDir: join(tmpdir(), 'x'), key: stateKey(randomBytes(32).toString('base64')), clock, retention }).restore(), /неверный STUDIO_STATE_KEY/);

  // Две машины с одного состояния: вторая запись не затирает первую.
  const a = new StateSync({ repoRoot: w3, dataDir: d3, key, clock, retention });
  const b = new StateSync({ repoRoot: w3, dataDir: d3, key, clock, retention });
  await a.restore();
  await b.restore();
  await a.save('a');
  await assert.rejects(b.save('b'), /git push/);

  // Владелец изменил файл в main: побеждает main, остальное переносится.
  git(origin.seed, 'pull', '-q', 'origin', 'main');
  await writeFile(join(origin.seed, 'studio/context/owner-preferences.json'), '{"v":3,"main":true}\n');
  git(origin.seed, 'commit', '-q', '-am', 'prefs in main');
  git(origin.seed, 'push', '-q', 'origin', 'main');
  const w5 = origin.clone();
  const r5 = await new StateSync({ repoRoot: w5, dataDir: join(w5, '.studio-data'), key, clock, retention }).restore();
  assert.deepEqual(r5.overlaySkipped, ['studio/context/owner-preferences.json']);
  assert.deepEqual(r5.overlayApplied, ['studio/decisions/DEC-1.md']);
  assert.match(await readFile(join(w5, 'studio/context/owner-preferences.json'), 'utf8'), /"main":true/);
});

// ───────────────────────── сессии ─────────────────────────

test('ночью сессия выходит сразу и не вызывает модели; /pause переживает перезапуск', { skip: noChrome }, async () => {
  const repo = await tempRepo();
  const provider = new ScriptedProvider(criteria);
  const night = { now: () => at('2026-07-15T21:30:00Z') }; // 00:30 по Киеву
  const app = await createApp({ repoRoot: repo, dataDir: join(repo, '.studio-data'), mode: 'scripted', provider, clock: night, renderer, imageProvider: null, telegram: null, github: null, quiet: true });
  const r = await runSession({ app, schedule, clock: night, maxMs: 50 * 60_000 });
  assert.equal(r.status, 'night');
  assert.equal(provider.calls.length, 0);
  assert.match(formatSessionSummary(r), /Нерабочее время.*Модели не вызывались/);

  const day = { now: () => at('2026-07-15T09:00:00Z') };
  await app.store.put('control', 'studio', { paused: true, ts: day.now() });
  await app.store.put('initiatives', 'ini-x', { id: 'ini-x', title: 'x', status: 'paused', pauseKind: 'schedule', history: [] });
  const d = await runSession({ app, schedule, clock: day, maxMs: 50 * 60_000, exitWhenIdle: true });
  assert.equal(d.paused, true);
  assert.deepEqual(d.resumed, []);
  assert.equal(provider.calls.length, 0);
  assert.match(formatSessionSummary(d), /на паузе/);
});

test('сессии в Actions: вечером работа встаёт на паузу на границе шага, утром новая машина продолжает без повторной оплаты', { skip: noGit || noChrome }, async () => {
  const origin = await fakeOrigin(true);
  const key = stateKey(randomBytes(32).toString('base64'));
  const tg = new FakeTelegram();
  tg.inbox.push(update(1, OWNER, '/new Главный экран выглядит красиво, но пользователь слишком долго ищет нужный напиток'));
  // 22:50 по Киеву: до закрытия 10 минут, новые шаги начинаются ещё 5. Каждый вызов модели — минута.
  const clock = { t: at('2026-07-15T19:50:00Z'), now() { return this.t; } };
  const provider = new ScriptedProvider(criteria, { before: () => { clock.t += 60_000; } });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)));
  const job = async (dir: string) => {
    const state = new StateSync({ repoRoot: dir, dataDir: join(dir, '.studio-data'), key, clock, retention });
    const restored = await state.restore();
    const app = await createApp({
      repoRoot: dir, dataDir: join(dir, '.studio-data'), mode: 'scripted', provider, clock, renderer, imageProvider: null,
      telegram: { token: 'T', ownerId: OWNER, fetchImpl: tg.fetch }, github: null, quiet: true,
    });
    const report = await runSession({ app, schedule, clock, maxMs: 50 * 60_000, save: (r) => state.save(r), exitWhenIdle: true, sleep });
    return { restored, report, app };
  };
  const count = (output: string) => provider.calls.filter((c) => c.output === output).length;

  const eveningDir = origin.clone();
  const evening = await job(eveningDir);
  assert.equal(evening.report.stoppedBy, 'close');
  const [ini] = await evening.app.studio.list();
  assert.equal(ini.status, 'paused');
  assert.equal(ini.pauseKind, 'schedule');
  assert.equal(tg.cards().length, 0, 'черновик ночью не отправляется');
  assert.ok(tg.texts().some((t) => t.startsWith('Принял:')));
  assert.ok(!tg.texts().some((t) => /сбой|❌|⏸/.test(t)), 'ночная пауза — без тревожных сообщений');
  const positions = count('position');
  assert.ok(positions > 0);
  assert.equal(count('brief'), 0);
  assert.ok(evening.report.saves >= 1);
  await rm(eveningDir, { recursive: true, force: true }); // машина вечерней сессии стёрта

  // Утро следующего дня, новая машина в другой папке.
  clock.t = at('2026-07-16T05:30:00Z');
  const morningDir = origin.clone();
  const morning = await job(morningDir);
  assert.equal(morning.restored.restored, true);
  assert.deepEqual(morning.report.resumed, [ini.id]);
  assert.equal(morning.report.updates, 0, 'сообщение из Telegram не обработано второй раз');
  const done = await morning.app.studio.get(ini.id);
  assert.equal(done.status, 'awaiting_owner');
  assert.equal(tg.cards().length, 1, 'готовый результат пришёл утром');
  assert.equal(count('triage'), 1);
  assert.equal(count('position'), positions, 'сделанные шаги не оплачиваются второй раз');
  assert.match(formatSessionSummary(morning.report), /ждёт вашего решения/);

  // Файлы версии, записанные студией в studio/, переезжают на следующую машину.
  const nextDir = origin.clone();
  const next = await new StateSync({ repoRoot: nextDir, dataDir: join(nextDir, '.studio-data'), key, clock, retention }).restore();
  assert.ok(next.overlayApplied.some((p) => p.startsWith(`studio/initiatives/${ini.id}/v1/`)));
});
