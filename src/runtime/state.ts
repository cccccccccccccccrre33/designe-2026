// Состояние студии между запусками GitHub Actions (ADR-0007).
//
// Машина задания стирается после каждого запуска, поэтому рабочее состояние
// (.studio-data: инициативы, журнал шагов, бюджет, outbox, Telegram) и файлы, которые
// студия записала в рабочую копию studio/ (предпочтения, решения, версии), сохраняются
// в ветку studio-state. Репозиторий публичный, поэтому каждый файл шифруется
// AES-256-GCM ключом из секрета STUDIO_STATE_KEY; имена файлов скрыты хэшами.
// В ветке всегда один коммит без истории: старое состояние не копится.
//
// Безопасность записи: push идёт с --force-with-lease на коммит, с которого состояние
// было восстановлено, — второй писатель не затрёт чужое состояние. Если ветка есть,
// но прочитать её не удалось, сессия не стартует: пустое состояние поверх настоящего
// означало бы потерю бюджета и решений.

import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { Clock } from '../core/util.ts';

const MAGIC = Buffer.from('DKS1');
const LOCAL_REF = 'refs/studio/state';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface StateRetention {
  closedArtifactsDays: number;
  telegramSeenDays: number;
}

export interface StateSyncOptions {
  repoRoot: string;
  dataDir: string;
  key: Buffer;
  clock: Clock;
  retention: StateRetention;
  branch?: string;
  remote?: string;
  /** Пути рабочей копии, которые студия пишет сама и которые нужно переносить. */
  overlayPrefix?: string;
  gitBin?: string;
}

export interface RestoreReport {
  restored: boolean;
  commit: string | null;
  files: number;
  overlayApplied: string[];
  /** Файлы, которые за это время изменились в main: побеждает main. */
  overlaySkipped: string[];
}

export interface SaveReport {
  commit: string;
  files: number;
  overlay: number;
  bytes: number;
  skipped: string[];
}

interface Manifest {
  version: 1;
  savedAt: string;
  reason: string;
  /** Где лежали данные при сохранении: абсолютные пути в JSON переносятся на новое место. */
  dataDir?: string;
  repoRoot?: string;
  data: string[];
  overlay: Array<{ path: string; base: string | null }>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Студия хранит абсолютные пути к рендерам (VariantResult, outbox). Если рабочая папка
 * сменилась (переименование репозитория, другая машина), пути переписываются за один
 * проход — без двойной замены, когда новый путь содержит старый.
 */
export function relocatePaths(text: string, moves: Array<[string, string]>): string {
  const pairs = moves
    .filter(([from, to]) => from && from !== to)
    .flatMap(([from, to]) => [[from, to], [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]] as Array<[string, string]>)
    .filter(([from], i, all) => all.findIndex(([f]) => f === from) === i)
    .sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return text;
  const map = new Map(pairs);
  return text.replace(new RegExp(pairs.map(([f]) => escapeRe(f)).join('|'), 'g'), (m) => map.get(m) ?? m);
}

/** Ключ: 32 байта в base64 (рекомендуется) или строка не короче 32 символов. */
export function stateKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const b = Buffer.from(value, 'base64');
    if (b.length === 32) return b;
  }
  if (value.length >= 32) return createHash('sha256').update(value, 'utf8').digest();
  throw new Error('STUDIO_STATE_KEY: нужен ключ из 32 байт в base64 (или строка не короче 32 символов)');
}

export function encrypt(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(key: Buffer, data: Buffer, aad: string): Buffer {
  if (data.length < 32 || !data.subarray(0, 4).equals(MAGIC)) throw new Error('Состояние студии повреждено: неизвестный формат');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(data.subarray(16, 32));
  try {
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
  } catch {
    throw new Error('Не удалось расшифровать состояние студии: неверный STUDIO_STATE_KEY или повреждённые данные');
  }
}

function blobName(kind: 'data' | 'repo', path: string): string {
  return `blobs/${createHash('sha256').update(`${kind}:${path}`).digest('hex')}.enc`;
}

/** Хэш объекта git для содержимого — сравнение с файлом в main без записи в репозиторий. */
function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest('hex');
}

/** Токены не попадают в журналы, даже если git вернул их в тексте ошибки. */
function sanitize(text: string): string {
  return text.replace(/(x-access-token|oauth2):[^@\s]+@/gi, '$1:***@').replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '***').trim().slice(0, 400);
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export class StateSync {
  private o: Required<Omit<StateSyncOptions, 'gitBin'>> & { gitBin: string };
  /** Коммит ветки состояния, с которого восстановились (null — ветки ещё нет). */
  baseCommit: string | null = null;
  private restoredOnce = false;

  constructor(opts: StateSyncOptions) {
    this.o = { branch: 'studio-state', remote: 'origin', overlayPrefix: 'studio/', gitBin: process.env.GIT_BIN || 'git', ...opts };
  }

  private git(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string; allowFail?: boolean } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.o.gitBin, args, { cwd: opts.cwd ?? this.o.repoRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }, windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', (e) => reject(new Error(`git недоступен (${this.o.gitBin}): ${e.message}`)));
      child.on('close', (code) => {
        const res = { code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') };
        if (res.code !== 0 && !opts.allowFail) reject(new Error(`git ${args[0]}: ${sanitize(res.stderr)}`));
        else resolve(res);
      });
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    });
  }

  private async headBlob(path: string): Promise<string | null> {
    const res = await this.git(['rev-parse', '--verify', '--quiet', `HEAD:${path}`], { allowFail: true });
    return res.code === 0 ? res.stdout.toString('utf8').trim() : null;
  }

  /** Читает все объекты дерева одним процессом git cat-file --batch. */
  private async readTree(ref: string): Promise<Map<string, Buffer>> {
    const names = (await this.git(['ls-tree', '-r', '-z', '--name-only', ref])).stdout.toString('utf8').split('\0').filter(Boolean);
    const files = new Map<string, Buffer>();
    if (!names.length) return files;
    const raw = (await this.git(['cat-file', '--batch'], { input: names.map((n) => `${ref}:${n}`).join('\n') + '\n' })).stdout;
    let pos = 0;
    for (const name of names) {
      const nl = raw.indexOf(10, pos);
      const header = raw.subarray(pos, nl).toString('utf8').split(' ');
      if (header[1] !== 'blob') throw new Error(`Состояние студии повреждено: ${name}`);
      const size = Number(header[2]);
      files.set(name, raw.subarray(nl + 1, nl + 1 + size));
      pos = nl + 1 + size + 1;
    }
    return files;
  }

  async restore(): Promise<RestoreReport> {
    const fetched = await this.git(['fetch', '--quiet', '--no-tags', '--depth=1', this.o.remote, `+refs/heads/${this.o.branch}:${LOCAL_REF}`], { allowFail: true });
    this.restoredOnce = true;
    if (fetched.code !== 0) {
      if (/couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)) {
        this.baseCommit = null;
        return { restored: false, commit: null, files: 0, overlayApplied: [], overlaySkipped: [] };
      }
      this.restoredOnce = false;
      throw new Error(`Не удалось получить состояние студии из ветки ${this.o.branch}: ${sanitize(fetched.stderr)}`);
    }
    this.baseCommit = (await this.git(['rev-parse', LOCAL_REF])).stdout.toString('utf8').trim();
    const tree = await this.readTree(LOCAL_REF);
    const manifestBlob = tree.get('manifest.enc');
    if (!manifestBlob) throw new Error('Состояние студии повреждено: нет manifest.enc');
    const manifest = JSON.parse(decrypt(this.o.key, manifestBlob, 'manifest').toString('utf8')) as Manifest;

    const moves: Array<[string, string]> = [[manifest.dataDir ?? '', this.o.dataDir], [manifest.repoRoot ?? '', this.o.repoRoot]];
    for (const path of manifest.data) {
      const blob = tree.get(blobName('data', path));
      if (!blob) throw new Error(`Состояние студии повреждено: нет ${path}`);
      const full = join(this.o.dataDir, ...path.split('/'));
      await mkdir(dirname(full), { recursive: true });
      let content = decrypt(this.o.key, blob, `data:${path}`);
      if (/\.jsonl?$/.test(path)) content = Buffer.from(relocatePaths(content.toString('utf8'), moves), 'utf8');
      await writeFile(full, content);
    }

    const overlayApplied: string[] = [];
    const overlaySkipped: string[] = [];
    for (const entry of manifest.overlay) {
      const blob = tree.get(blobName('repo', entry.path));
      if (!blob) continue;
      const content = decrypt(this.o.key, blob, `repo:${entry.path}`);
      const current = await this.headBlob(entry.path);
      if (current === entry.base) {
        const full = join(this.o.repoRoot, ...entry.path.split('/'));
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
        overlayApplied.push(entry.path);
      } else if (current !== gitBlobSha(content)) {
        overlaySkipped.push(entry.path);
      }
    }
    return { restored: true, commit: this.baseCommit, files: manifest.data.length, overlayApplied, overlaySkipped };
  }

  /** Удаляет то, что больше не нужно переносить: рендеры закрытых задач, старые отметки Telegram. */
  async prune(): Promise<{ removed: number }> {
    const now = this.o.clock.now();
    let removed = 0;
    const closedBefore = now - this.o.retention.closedArtifactsDays * 86_400_000;
    for (const file of await walk(join(this.o.dataDir, 'initiatives'))) {
      try {
        const ini = JSON.parse(await readFile(file, 'utf8')) as { id: string; status: string; updatedAt: number };
        if (['approved', 'rejected', 'declined'].includes(ini.status) && ini.updatedAt < closedBefore) {
          const dir = join(this.o.dataDir, 'artifacts', ini.id);
          const n = (await walk(dir)).length;
          if (n) {
            await rm(dir, { recursive: true, force: true });
            removed += n;
          }
        }
      } catch {
        // Нечитаемый документ не удаляем — пусть его увидит человек.
      }
    }
    const seenBefore = now - this.o.retention.telegramSeenDays * 86_400_000;
    for (const file of await walk(join(this.o.dataDir, 'tg-seen'))) {
      try {
        const rec = JSON.parse(await readFile(file, 'utf8')) as { ts?: number };
        if ((rec.ts ?? 0) < seenBefore) {
          await unlink(file);
          removed++;
        }
      } catch {
        // пропускаем
      }
    }
    return { removed };
  }

  async save(reason: string): Promise<SaveReport> {
    if (!this.restoredOnce) throw new Error('Сначала restore(): без него можно затереть настоящее состояние пустым');
    await this.prune();
    const out = await mkdtemp(join(tmpdir(), 'dk-state-'));
    const index = join(tmpdir(), `dk-state-index-${process.pid}-${Date.now()}`);
    try {
      const manifest: Manifest = { version: 1, savedAt: new Date(this.o.clock.now()).toISOString(), reason, dataDir: this.o.dataDir, repoRoot: this.o.repoRoot, data: [], overlay: [] };
      const skipped: string[] = [];
      let bytes = 0;
      const put = async (name: string, content: Buffer) => {
        const full = join(out, ...name.split('/'));
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
        bytes += content.length;
      };

      for (const full of await walk(this.o.dataDir)) {
        const path = relative(this.o.dataDir, full).split(sep).join('/');
        // Блокировки живут только внутри одной сессии; временные файлы — недописанные.
        if (path.startsWith('leases/') || path.endsWith('.tmp')) continue;
        if ((await stat(full)).size > MAX_FILE_BYTES) {
          skipped.push(path);
          continue;
        }
        await put(blobName('data', path), encrypt(this.o.key, await readFile(full), `data:${path}`));
        manifest.data.push(path);
      }

      const status = (await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', this.o.overlayPrefix])).stdout.toString('utf8').split('\0').filter(Boolean);
      for (let i = 0; i < status.length; i++) {
        const entry = status[i];
        const xy = entry.slice(0, 2);
        const path = entry.slice(3);
        if (xy[0] === 'R' || xy[0] === 'C') i++; // следующий элемент — старое имя
        if (xy.includes('D')) continue;
        let content: Buffer;
        try {
          content = await readFile(join(this.o.repoRoot, ...path.split('/')));
        } catch {
          continue;
        }
        await put(blobName('repo', path), encrypt(this.o.key, content, `repo:${path}`));
        manifest.overlay.push({ path, base: await this.headBlob(path) });
      }

      await put('manifest.enc', encrypt(this.o.key, Buffer.from(JSON.stringify(manifest), 'utf8'), 'manifest'));
      await put('README.md', Buffer.from('Зашифрованное состояние DRIVE&KAVA Studio (ADR-0007). Ключ — секрет STUDIO_STATE_KEY. Не редактировать вручную.\n', 'utf8'));

      const gitDir = (await this.git(['rev-parse', '--absolute-git-dir'])).stdout.toString('utf8').trim();
      const env = {
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: 'DRIVE&KAVA Studio', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'DRIVE&KAVA Studio', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      };
      const inTree = ['--git-dir', gitDir, '--work-tree', out];
      await this.git([...inTree, 'add', '--all', '--force', '.'], { cwd: out, env });
      const tree = (await this.git([...inTree, 'write-tree'], { cwd: out, env })).stdout.toString('utf8').trim();
      const commit = (await this.git(['commit-tree', tree, '-m', `studio state: ${reason} (${manifest.savedAt})`], { env })).stdout.toString('utf8').trim();
      const lease = `--force-with-lease=refs/heads/${this.o.branch}:${this.baseCommit ?? ''}`;
      await this.git(['push', '--quiet', lease, this.o.remote, `${commit}:refs/heads/${this.o.branch}`]);
      this.baseCommit = commit;
      return { commit, files: manifest.data.length, overlay: manifest.overlay.length, bytes, skipped };
    } finally {
      await rm(out, { recursive: true, force: true });
      await rm(index, { force: true });
    }
  }
}
