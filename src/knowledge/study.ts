// Изучение публикаций практиков (задание study): прочитать каждую ссылку школы,
// дешёвой моделью выписать, что человек ценит и отвергает в работе и какими приёмами
// пользуется, — и оставить только то, что подтверждается дословной цитатой со страницы.
// Результат — knowledge/study/<практик>.md (тир B), его находят роли через базу знаний.
// Страницы читаются как текст; изображения не скачиваются и не используются для обучения.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSystem, buildUser } from '../agents/prompt.ts';
import type { Practitioner, PractitionerBook } from '../agents/practitioners.ts';
import type { RoleBook } from '../agents/roles.ts';
import { studyNotesSchema } from '../agents/schemas.ts';
import { truncate } from '../core/util.ts';
import type { ModelRouter } from '../llm/router.ts';

export interface StudyTarget {
  practitioner: string;
  url: string;
}

interface Note { text: string; quote: string; url: string }

export interface StudyResult {
  practitioner: string;
  read: string[];
  blocked: Array<{ url: string; reason: string }>;
  likes: Note[];
  dislikes: Note[];
  methods: Note[];
  dropped: number;
  file: string | null;
}

/** Все ссылки школы: источники канона, источники вкуса и список чтения владельца. */
export async function studyTargets(book: PractitionerBook, repoRoot: string, only?: string[]): Promise<StudyTarget[]> {
  const extra = JSON.parse(await readFile(join(repoRoot, 'studio/study/reading-list.json'), 'utf8').catch(() => '{"practitioners":{}}')) as { practitioners: Record<string, string[]> };
  const out: StudyTarget[] = [];
  const seen = new Set<string>();
  const add = (practitioner: string, url: string | undefined) => {
    if (!url || !/^https:\/\//.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ practitioner, url });
  };
  for (const p of book.all()) {
    if (only?.length && !only.includes(p.id)) continue;
    for (const s of p.sources) add(p.id, s.url);
    for (const t of [...(p.taste?.likes ?? []), ...(p.taste?.dislikes ?? [])]) add(p.id, t.source);
    for (const u of extra.practitioners[p.id] ?? []) add(p.id, u);
  }
  return out;
}

/** Публичный канал Telegram читается через веб-превью t.me/s/<канал>. */
export function readableUrl(url: string): string {
  const tg = url.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{4,})\/?$/);
  return tg ? `https://t.me/s/${tg[1]}` : url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };

/** HTML → текст: описание страницы (og:description) и видимый текст без скриптов и стилей. */
export function htmlToText(html: string): string {
  const meta = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:og:description|description|og:title)["'][^>]*content=["']([^"']+)["']/gi)].map((m) => m[1]);
  const body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return [...new Set(meta), body]
    .join('\n')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (all, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? all))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

const WALL = /(sign in|log in|join now|войдите|authwall|captcha|enable javascript|checking your browser)/i;

export async function fetchPage(url: string, fetchImpl: typeof fetch, timeoutMs = 20_000): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(readableUrl(url), {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      // Честная подпись: задание не притворяется браузером и не обходит защиту сайтов.
      headers: { 'user-agent': 'DRIVE-KAVA-Studio-Study/1.0 (public pages only)', 'accept-language': 'ru,uk;q=0.9,en;q=0.8' },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (!/html|text/.test(type)) return { ok: false, reason: `не текст (${type || 'тип неизвестен'})` };
    const text = htmlToText(await res.text());
    if (text.length < 300) return { ok: false, reason: 'почти пустая страница (содержимое рисуется скриптом)' };
    // Короткая страница со словами входа — это стена логина, а не публикация.
    if (text.length < 1500 && WALL.test(text)) return { ok: false, reason: 'требует входа' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: truncate((err as Error).message, 80) };
  }
}

const squash = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”„'’`]/g, '').replace(/\s+/g, ' ').trim();

/** Цитата засчитывается, только если она есть на странице (без учёта регистра, кавычек и пробелов). */
export function quoteOnPage(quote: string, page: string): boolean {
  const q = squash(quote);
  return q.length >= 12 && squash(page).includes(q);
}

export interface StudyDeps {
  router: ModelRouter;
  book: PractitionerBook;
  roles: RoleBook;
  repoRoot: string;
  fetchImpl?: typeof fetch;
  /** Сколько символов страницы отдавать модели: дольше — дороже. */
  maxChars?: number;
  date: string;
  log?: (line: string) => void;
}

export async function runStudy(deps: StudyDeps, targets: StudyTarget[]): Promise<StudyResult[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const role = deps.roles.get('design-researcher');
  const byPractitioner = new Map<string, StudyTarget[]>();
  for (const t of targets) byPractitioner.set(t.practitioner, [...(byPractitioner.get(t.practitioner) ?? []), t]);
  const results: StudyResult[] = [];
  for (const [id, list] of byPractitioner) {
    const p = deps.book.get(id);
    if (!p) continue;
    const r: StudyResult = { practitioner: id, read: [], blocked: [], likes: [], dislikes: [], methods: [], dropped: 0, file: null };
    for (const t of list) {
      const page = await fetchPage(t.url, fetchImpl);
      if (!page.ok) {
        r.blocked.push({ url: t.url, reason: page.reason });
        continue;
      }
      const text = page.text.slice(0, deps.maxChars ?? 12_000);
      try {
        const res = await deps.router.complete<{ relevant: boolean; likes: Array<{ text: string; quote: string }>; dislikes: Array<{ text: string; quote: string }>; methods: Array<{ text: string; quote: string }> }>({
          taskClass: 'extract', initiativeId: `study-${id}`, role: role.id, autonomous: false,
          system: buildSystem(role, 'extract', 'studyNotes', studyNotesSchema, {}),
          user: buildUser([
            { label: 'TASK', title: 'Изучи публикацию практика', body: `Практик: ${p.name} (${p.org}; ${p.role}). Страница: ${t.url}\nВыпиши, что этот человек ЦЕНИТ и что ОТВЕРГАЕТ в работе, и какими приёмами пользуется — только профессиональное (дизайн, фото, процесс), без личной жизни. К каждому пункту — дословная цитата со страницы; без цитаты пункт не нужен. Если страница не о его работе — relevant: false.` },
            { label: 'WORK', title: 'Текст страницы', body: text },
          ]),
          schema: studyNotesSchema, maxTokens: 1200,
        });
        r.read.push(t.url);
        if (!res.value.relevant) continue;
        for (const kind of ['likes', 'dislikes', 'methods'] as const) {
          for (const n of res.value[kind] ?? []) {
            if (quoteOnPage(n.quote, text)) r[kind].push({ text: n.text, quote: n.quote, url: t.url });
            else r.dropped++;
          }
        }
      } catch (err) {
        r.blocked.push({ url: t.url, reason: `модель: ${truncate((err as Error).message, 80)}` });
      }
    }
    if (r.read.length || r.blocked.length) r.file = await writeStudyFile(deps.repoRoot, p, r, deps.date);
    deps.log?.(`${id}: прочитано ${r.read.length}, недоступно ${r.blocked.length}, выводов ${r.likes.length + r.dislikes.length + r.methods.length}, без цитаты отброшено ${r.dropped}`);
    results.push(r);
  }
  return results;
}

async function writeStudyFile(repoRoot: string, p: Practitioner, r: StudyResult, date: string): Promise<string> {
  const path = `knowledge/study/${p.id}.md`;
  const item = (n: Note) => `- ${n.text} — «${truncate(n.quote, 220)}» (${n.url})`;
  const out = [
    `# ${p.name} — изучено по публикациям`, '',
    `> Сгенерировано заданием study ${date}. Только выводы с дословной цитатой со страницы; без цитаты — отброшены (${r.dropped}). Профессиональный вкус и методы, не биография и не имитация личности.`, '',
  ];
  if (r.likes.length || r.dislikes.length || r.methods.length) {
    out.push(`## ${p.name} — изучено: вкус и методы`, `<!-- meta: id=ST-${p.id}; tier=B; tags=practitioner,study,taste,${p.school},${p.id}; kind=study; rights=public-reference-only; url=${(r.likes[0] ?? r.dislikes[0] ?? r.methods[0]).url} -->`);
    if (r.likes.length) out.push('Ценит:', ...r.likes.map(item));
    if (r.dislikes.length) out.push('Отвергает:', ...r.dislikes.map(item));
    if (r.methods.length) out.push('Приёмы и методы:', ...r.methods.map(item));
    out.push('');
  }
  if (r.blocked.length) {
    out.push(`## ${p.name} — не прочитано автоматически`, `<!-- meta: id=ST-${p.id}-gaps; tier=D; tags=study,${p.id}; kind=study-gaps -->`, ...r.blocked.map((b) => `- ${b.url} — ${b.reason}`), '');
  }
  await mkdir(join(repoRoot, 'knowledge/study'), { recursive: true });
  await writeFile(join(repoRoot, path), out.join('\n'), 'utf8');
  return path;
}

/** Сводка для страницы запуска. */
export function formatStudySummary(results: StudyResult[], costUsd: number): string {
  const total = (k: 'likes' | 'dislikes' | 'methods') => results.reduce((a, r) => a + r[k].length, 0);
  const lines = [
    '## Изучение публикаций практиков', '',
    `Прочитано страниц: ${results.reduce((a, r) => a + r.read.length, 0)}, недоступно: ${results.reduce((a, r) => a + r.blocked.length, 0)}. Выводов с цитатой: ценит ${total('likes')}, отвергает ${total('dislikes')}, методов ${total('methods')}; без цитаты отброшено ${results.reduce((a, r) => a + r.dropped, 0)}. Расход ≈ $${costUsd}.`, '',
    '| Практик | Прочитано | Недоступно | Выводов |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.practitioner} | ${r.read.length} | ${r.blocked.length} | ${r.likes.length + r.dislikes.length + r.methods.length} |`), '',
    'Недоступные страницы (LinkedIn, Instagram, Pinterest и т. п. требуют входа) остаются в списке «не прочитано» — их содержание уже учтено вручную в досье вкуса, где это было возможно.',
  ];
  return lines.join('\n') + '\n';
}
