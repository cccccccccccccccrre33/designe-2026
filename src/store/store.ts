// Хранилище операционного состояния. Локально — файлы в .studio-data/, в облаке —
// DynamoDB с теми же операциями (условная запись вместо файловых блокировок).

import { mkdir, readFile, writeFile, rename, readdir, appendFile, unlink, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export interface Store {
  get<T>(collection: string, id: string): Promise<T | undefined>;
  put<T>(collection: string, id: string, value: T): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  list<T>(collection: string): Promise<T[]>;
  append(stream: string, record: unknown): Promise<void>;
  readStream<T>(stream: string): Promise<T[]>;
  /** Лиз-блокировка: true — блокировка получена. Просроченная блокировка перехватывается. */
  acquireLease(name: string, owner: string, ttlMs: number, now: number): Promise<boolean>;
  releaseLease(name: string, owner: string): Promise<void>;
}

const SAFE_ID = /[^a-zA-Z0-9._-]/g;

function safe(id: string): string {
  return id.replace(SAFE_ID, '_');
}

export class FileStore implements Store {
  root: string;
  constructor(root: string) {
    this.root = root;
  }

  private docPath(collection: string, id: string): string {
    return join(this.root, safe(collection), `${safe(id)}.json`);
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.docPath(collection, id), 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    const path = this.docPath(collection, id);
    await mkdir(dirname(path), { recursive: true });
    // Атомарная запись: сначала временный файл, потом rename — частично записанный
    // документ после сбоя невозможен.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, path);
  }

  async delete(collection: string, id: string): Promise<void> {
    try {
      await unlink(this.docPath(collection, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async list<T>(collection: string): Promise<T[]> {
    const dir = join(this.root, safe(collection));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const docs: T[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      docs.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as T);
    }
    return docs;
  }

  async append(stream: string, record: unknown): Promise<void> {
    const path = join(this.root, 'streams', `${safe(stream)}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
  }

  async readStream<T>(stream: string): Promise<T[]> {
    const path = join(this.root, 'streams', `${safe(stream)}.jsonl`);
    try {
      const text = await readFile(path, 'utf8');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async acquireLease(name: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
    const path = join(this.root, 'leases', `${safe(name)}.lock`);
    await mkdir(dirname(path), { recursive: true });
    const body = JSON.stringify({ owner, expiresAt: now + ttlMs });
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(body, 'utf8');
      await handle.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as { owner: string; expiresAt: number };
      if (current.owner === owner || current.expiresAt <= now) {
        await writeFile(path, body, 'utf8');
        return true;
      }
      return false;
    } catch {
      // Повреждённый файл блокировки считаем просроченным.
      await writeFile(path, body, 'utf8');
      return true;
    }
  }

  async releaseLease(name: string, owner: string): Promise<void> {
    const path = join(this.root, 'leases', `${safe(name)}.lock`);
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as { owner: string };
      if (current.owner === owner) await unlink(path);
    } catch {
      // Нет блокировки — нечего освобождать.
    }
  }
}
