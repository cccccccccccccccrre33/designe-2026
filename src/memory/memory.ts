// Долговременная память: реестр предпочтений владельца (канон), журнал решений,
// уроки, заметки ролей. Файлы памяти живут в репозитории и попадают в GitHub через PR.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tokenize } from '../knowledge/base.ts';
import type { Store } from '../store/store.ts';
import type { Clock } from '../core/util.ts';

export interface RepoFile {
  path: string;
  content: string | Buffer;
}

export interface Preference {
  id: string;
  statement: string;
  scope: string;
  strength: 'hard' | 'soft';
  status: 'active' | 'superseded';
  check: string | null;
  source: { kind: string; date: string; quote?: string; initiativeId?: string };
  supersededBy?: string;
}

export interface PreferenceCandidate {
  id: string;
  statement: string;
  scope: string;
  strength: 'hard' | 'soft';
  count: number;
  quotes: string[];
  firstSeen: string;
}

interface PrefFile {
  _comment?: string;
  version: number;
  preferences: Preference[];
  candidates: PreferenceCandidate[];
}

function jaccard(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export class PreferenceRegistry {
  private path: string;
  private clock: Clock;
  relPath: string;

  constructor(repoRoot: string, clock: Clock, relPath = 'studio/context/owner-preferences.json') {
    this.path = join(repoRoot, relPath);
    this.relPath = relPath;
    this.clock = clock;
  }

  async load(): Promise<PrefFile> {
    return JSON.parse(await readFile(this.path, 'utf8')) as PrefFile;
  }

  private async save(file: PrefFile): Promise<RepoFile> {
    file.version += 1;
    const content = JSON.stringify(file, null, 2) + '\n';
    await writeFile(this.path, content, 'utf8');
    return { path: this.relPath, content };
  }

  async active(): Promise<Preference[]> {
    return (await this.load()).preferences.filter((p) => p.status === 'active');
  }

  async hardCheckIds(): Promise<Set<string>> {
    return new Set((await this.active()).filter((p) => p.strength === 'hard' && p.check).map((p) => p.check!));
  }

  /**
   * Кандидаты из замечаний. Похожий на активное предпочтение — пропускается.
   * Повторившийся (2 раза) кандидат становится активным предпочтением.
   */
  async addCandidates(cands: Array<{ statement: string; scope: string; strength: 'hard' | 'soft' }>, quote: string, initiativeId: string): Promise<{ promoted: Preference[]; file: RepoFile | null }> {
    if (!cands.length) return { promoted: [], file: null };
    const file = await this.load();
    const promoted: Preference[] = [];
    const today = new Date(this.clock.now()).toISOString().slice(0, 10);
    for (const c of cands) {
      if (file.preferences.some((p) => p.status === 'active' && jaccard(p.statement, c.statement) >= 0.5)) continue;
      const existing = file.candidates.find((x) => jaccard(x.statement, c.statement) >= 0.5);
      if (existing) {
        existing.count += 1;
        existing.quotes.push(quote.slice(0, 200));
        if (existing.count >= 2) {
          const pref: Preference = {
            id: `PREF-${String(file.preferences.length + 1).padStart(3, '0')}`,
            statement: existing.statement,
            scope: existing.scope,
            strength: existing.strength,
            status: 'active',
            check: null,
            source: { kind: 'owner-feedback-repeated', date: today, quote: existing.quotes.join(' | '), initiativeId },
          };
          file.preferences.push(pref);
          file.candidates = file.candidates.filter((x) => x !== existing);
          promoted.push(pref);
        }
      } else {
        file.candidates.push({ id: `CAND-${this.clock.now().toString(36)}-${file.candidates.length}`, statement: c.statement, scope: c.scope, strength: c.strength, count: 1, quotes: [quote.slice(0, 200)], firstSeen: today });
      }
    }
    return { promoted, file: await this.save(file) };
  }

  /** Явное указание владельца: новое правило заменяет противоречащее старое. */
  async supersede(oldId: string, statement: string, quote: string): Promise<{ pref: Preference; file: RepoFile }> {
    const file = await this.load();
    const old = file.preferences.find((p) => p.id === oldId);
    if (!old) throw new Error(`Предпочтение ${oldId} не найдено`);
    const pref: Preference = {
      id: `PREF-${String(file.preferences.length + 1).padStart(3, '0')}`,
      statement,
      scope: old.scope,
      strength: old.strength,
      status: 'active',
      check: null,
      source: { kind: 'owner-direct', date: new Date(this.clock.now()).toISOString().slice(0, 10), quote },
    };
    old.status = 'superseded';
    old.supersededBy = pref.id;
    file.preferences.push(pref);
    return { pref, file: await this.save(file) };
  }

  async confirm(candidateId: string): Promise<{ pref: Preference; file: RepoFile }> {
    const file = await this.load();
    const cand = file.candidates.find((c) => c.id === candidateId);
    if (!cand) throw new Error(`Кандидат ${candidateId} не найден`);
    const pref: Preference = {
      id: `PREF-${String(file.preferences.length + 1).padStart(3, '0')}`,
      statement: cand.statement,
      scope: cand.scope,
      strength: cand.strength,
      status: 'active',
      check: null,
      source: { kind: 'owner-confirmed', date: new Date(this.clock.now()).toISOString().slice(0, 10), quote: cand.quotes.join(' | ') },
    };
    file.preferences.push(pref);
    file.candidates = file.candidates.filter((c) => c !== cand);
    return { pref, file: await this.save(file) };
  }
}

export interface DecisionRecord {
  id: string;
  initiativeId: string;
  title: string;
  version: number;
  decision: 'approved' | 'rejected';
  date: string;
  artifactHash: string;
  reason?: string;
  summary: string;
  prUrl?: string;
}

export function decisionFile(rec: DecisionRecord): RepoFile {
  const facts = [
    `- Инициатива: ${rec.initiativeId}, версия v${rec.version}`,
    `- Решение владельца: **${rec.decision === 'approved' ? 'одобрено как дизайн-направление' : 'отклонено'}**`,
    `- Дата: ${rec.date}`,
    `- Хэш утверждённого артефакта: \`${rec.artifactHash}\``,
    rec.prUrl ? `- PR: ${rec.prUrl}` : null,
    rec.reason ? `- Причина: ${rec.reason}` : null,
  ].filter((l): l is string => l !== null);
  const note = rec.decision === 'approved'
    ? '> Одобрение дизайна не разрешает разработку и выпуск. Это отдельные этапы с отдельным разрешением владельца.'
    : '> Направление закрыто. Причина сохранена в памяти ошибок и учитывается в следующих брифах.';
  const content = [`# ${rec.id}: ${rec.title}`, facts.join('\n'), `## Что решено\n${rec.summary}`, note].join('\n\n') + '\n';
  return { path: `studio/decisions/${rec.id}.md`, content };
}

export function lessonFile(id: string, title: string, body: string, date: string): RepoFile {
  return { path: `studio/lessons/${id}.md`, content: `# ${id}: ${title}\n\nДата: ${date}\n\n${body.trim()}\n` };
}

export async function writeRepoFiles(repoRoot: string, files: RepoFile[]): Promise<void> {
  for (const f of files) {
    const full = join(repoRoot, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content);
  }
}

/** Заметки ролей: последние выводы, которые роль видит в начале следующей задачи. */
export class RoleNotes {
  private store: Store;
  private clock: Clock;
  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  async add(role: string, initiativeId: string, note: string): Promise<void> {
    await this.store.append(`notes-${role}`, { ts: this.clock.now(), initiativeId, note: note.slice(0, 500) });
  }

  async recent(role: string, limit = 5): Promise<string[]> {
    const all = await this.store.readStream<{ ts: number; initiativeId: string; note: string }>(`notes-${role}`);
    return all.slice(-limit).map((n) => `[${new Date(n.ts).toISOString().slice(0, 10)} ${n.initiativeId}] ${n.note}`);
  }
}
