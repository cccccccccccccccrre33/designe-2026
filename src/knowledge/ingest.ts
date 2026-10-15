// Разбор markdown-архива ссылок из исследования: ссылки группируются по ближайшему
// заголовку и попадают во «входящие» с тиром D. Повысить тир может только человек
// после проверки авторства — это защищает от смешения фанатских концептов с
// работами команд (раздел VII исследования).

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function ingestLinkArchive(repoRoot: string, file: string): Promise<{ path: string; count: number }> {
  if (!file) throw new Error('Укажите файл: knowledge-ingest <archive.md>');
  const text = await readFile(file, 'utf8');
  let heading = 'Без раздела';
  const groups = new Map<string, Array<{ title: string; url: string }>>();
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^#{1,4}\s+(.+)/);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    // Два формата: markdown-ссылки [название](url) и строки «- название: url».
    const found = [...line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ title: m[1].trim(), url: m[2] }));
    const plain = line.match(/^\s*[-*]\s*(.+?):\s*(https?:\/\/\S+)\s*$/);
    if (!found.length && plain) found.push({ title: plain[1].trim(), url: plain[2] });
    for (const link of found) {
      const list = groups.get(heading) ?? [];
      if (!list.some((l) => l.url === link.url)) list.push(link);
      groups.set(heading, list);
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const out = [`# Входящие ссылки ${date}`, '', 'Тир D до ручной проверки авторства. После проверки перенесите фрагмент в профильный файл и поменяйте тир.', ''];
  let count = 0;
  for (const [title, links] of groups) {
    out.push(`## ${title}`);
    out.push(`<!-- meta: id=INBOX-${date}-${count}; tier=D; tags=inbox; kind=links; rights=public-reference-only; status=hypothesis -->`);
    for (const l of links) {
      out.push(`- ${l.title}: ${l.url}`);
      count++;
    }
    out.push('');
  }
  // Второй архив за тот же день не затирает первый: inbox-<дата>-2.md, -3.md…
  let path = join(repoRoot, 'knowledge/sources', `inbox-${date}.md`);
  for (let n = 2; existsSync(path); n++) path = join(repoRoot, 'knowledge/sources', `inbox-${date}-${n}.md`);
  await writeFile(path, out.join('\n'), { encoding: 'utf8', flag: 'wx' });
  return { path, count };
}
