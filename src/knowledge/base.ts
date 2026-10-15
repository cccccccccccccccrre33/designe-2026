// База знаний: markdown-источники и карточки методов, разбитые на фрагменты по
// заголовкам «## », с метаданными в комментарии <!-- meta: tier=A; tags=...; ... -->.
// Поиск — BM25 в памяти; на этапе 3 те же фрагменты и метаданные уходят в
// Knowledge Base (S3 Vectors), интерфейс search() не меняется.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface Chunk {
  id: string;
  title: string;
  text: string;
  file: string;
  tier: 'A' | 'B' | 'C' | 'D' | 'M';
  tags: string[];
  kind: string;
  status: 'standard' | 'research' | 'hypothesis' | 'rejected';
  url: string | null;
}

export interface SearchOptions {
  k?: number;
  tags?: string[];
  tiers?: Chunk['tier'][];
  statuses?: Chunk['status'][];
}

const META = /<!--\s*meta:\s*([\s\S]*?)-->/;

export function parseChunks(markdown: string, file: string): Chunk[] {
  const chunks: Chunk[] = [];
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const title = part.slice(0, newline).trim();
    let body = part.slice(newline + 1);
    const meta: Record<string, string> = {};
    const m = body.match(META);
    if (m) {
      for (const pair of m[1].split(';')) {
        const [k, ...v] = pair.split('=');
        if (k && v.length) meta[k.trim()] = v.join('=').trim();
      }
      body = body.replace(META, '');
    }
    const tier = (meta.tier ?? 'D') as Chunk['tier'];
    chunks.push({
      id: meta.id ?? `${file}#${title.slice(0, 40)}`,
      title,
      text: body.trim(),
      file,
      tier,
      tags: (meta.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      kind: meta.kind ?? 'note',
      status: (meta.status ?? (tier === 'M' ? 'standard' : 'research')) as Chunk['status'],
      url: meta.url && meta.url !== 'needs-url' ? meta.url : null,
    });
  }
  return chunks;
}

// Токенизация для кириллицы и латиницы с грубым стеммингом: обрезка до 6 символов
// хорошо работает для флективных славянских форм на маленьком корпусе.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-яіїєґ0-9]+/i)
    .filter((t) => t.length > 2)
    .map((t) => (t.length > 6 ? t.slice(0, 6) : t));
}

export class KnowledgeBase {
  chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private tf: Array<Map<string, number>> = [];
  private lengths: number[] = [];
  private avgLen = 0;

  static async load(root: string, dirs: string[]): Promise<KnowledgeBase> {
    const kb = new KnowledgeBase();
    for (const dir of dirs) {
      const full = join(root, dir);
      let names: string[] = [];
      try {
        names = (await readdir(full)).filter((n) => n.endsWith('.md') && n !== 'README.md');
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        const path = join(full, name);
        kb.add(parseChunks(await readFile(path, 'utf8'), relative(root, path).replace(/\\/g, '/')));
      }
    }
    return kb;
  }

  add(chunks: Chunk[]): void {
    for (const c of chunks) {
      const terms = tokenize(`${c.title} ${c.title} ${c.tags.join(' ')} ${c.text}`);
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.chunks.push(c);
      this.tf.push(tf);
      this.lengths.push(terms.length);
    }
    this.avgLen = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  search(query: string, opts: SearchOptions = {}): Array<Chunk & { score: number }> {
    const k1 = 1.4;
    const b = 0.75;
    const n = this.chunks.length;
    const terms = [...new Set(tokenize(query))];
    const scored: Array<Chunk & { score: number }> = [];
    this.chunks.forEach((chunk, i) => {
      if (opts.tiers && !opts.tiers.includes(chunk.tier)) return;
      if (opts.statuses && !opts.statuses.includes(chunk.status)) return;
      let score = 0;
      for (const t of terms) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * this.lengths[i]) / this.avgLen));
      }
      if (opts.tags?.length && chunk.tags.some((t) => opts.tags!.includes(t))) score += 1.5;
      if (score > 0) scored.push({ ...chunk, score });
    });
    return scored.sort((x, y) => y.score - x.score).slice(0, opts.k ?? 6);
  }
}

/** Фрагменты для промпта: с тиром и источником, коротко. */
export function formatForPrompt(chunks: Array<Chunk & { score?: number }>, maxChars = 700): string {
  return chunks
    .map((c) => `- (${c.tier === 'M' ? 'метод студии' : `тир ${c.tier}`}) ${c.title} [${c.id}]: ${c.text.replace(/\s+/g, ' ').slice(0, maxChars)}`)
    .join('\n');
}
