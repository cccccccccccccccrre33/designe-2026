// Школы студии: профессиональные почерки практиков Drinkit, Dodo, amo и студий
// (studio/org/practitioners.json). Роль работает в манере практика, но остаётся
// ролью DRIVE&KAVA: не говорит от его имени и не приписывает ему результат.

import { readFile } from 'node:fs/promises';

export interface Signature {
  id: string;
  title: string;
  rule: string;
  apply: string;
  basis: 'source' | 'visual';
}

export interface Practitioner {
  id: string;
  name: string;
  org: string;
  role: string;
  school: string;
  sources: Array<{ title: string; url: string; tier: 'A' | 'B' | 'C' | 'D' }>;
  signatures: Signature[];
  method: string[];
  qualityBar: string[];
  avoid: string[];
  confidence?: string;
}

export interface LineageEntry {
  practitioner: string;
  weight: 'primary' | 'secondary';
  signatures?: string[];
}

interface PractitionersFile {
  boundary: string;
  practitioners: Practitioner[];
  lineage: Record<string, LineageEntry[]>;
}

const ALLOWED_KEYS = new Set(['id', 'name', 'org', 'role', 'school', 'sources', 'signatures', 'method', 'qualityBar', 'avoid', 'confidence']);

export const SCHOOL_NAMES: Record<string, string> = {
  'drinkit-product': 'Drinkit — продукт и арт-дирекшн',
  'drinkit-craft': 'Drinkit — инженерное ремесло интерфейса',
  'drinkit-content': 'Drinkit — предметный контент',
  'drinkit-brand': 'Drinkit — айдентика',
  'drinkit-space': 'Drinkit — пространство',
  'dodo-drinkit-leadership': 'Dodo/Drinkit — дизайн-лидерство',
  'dodo-product': 'Dodo — продуктовый дизайн',
  'dodo-craft': 'Dodo — инженерное ремесло интерфейса',
  'dodo-content': 'Dodo — предметная съёмка, стилинг и видеопродакшен',
  amo: 'amo / Zenly — эмоция и характер',
  studios: 'Независимые студии',
};

export class PractitionerBook {
  boundary: string;
  private byId = new Map<string, Practitioner>();
  private signatures = new Map<string, { sig: Signature; practitioner: Practitioner }>();
  lineage: Record<string, LineageEntry[]>;

  constructor(file: PractitionersFile) {
    this.boundary = file.boundary;
    this.lineage = file.lineage;
    for (const p of file.practitioners) {
      this.byId.set(p.id, p);
      for (const s of p.signatures) this.signatures.set(s.id, { sig: s, practitioner: p });
    }
  }

  static async load(path: string): Promise<PractitionerBook> {
    return new PractitionerBook(JSON.parse(await readFile(path, 'utf8')) as PractitionersFile);
  }

  all(): Practitioner[] {
    return [...this.byId.values()];
  }

  get(id: string): Practitioner | undefined {
    return this.byId.get(id);
  }

  signature(id: string): { sig: Signature; practitioner: Practitioner } | undefined {
    return this.signatures.get(id);
  }

  /** Проверка целостности: ссылки, источники, отсутствие полей вне профессиональной области. */
  validate(roleIds: Set<string>): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const p of this.all()) {
      for (const key of Object.keys(p)) if (!ALLOWED_KEYS.has(key)) errors.push(`${p.id}: поле «${key}» вне профессионального профиля`);
      if (!p.sources.length) errors.push(`${p.id}: нет источников`);
      for (const s of p.sources) if (!/^https:\/\//.test(s.url)) errors.push(`${p.id}: источник без https-ссылки (${s.title})`);
      if (!p.signatures.length) errors.push(`${p.id}: нет приёмов`);
      if (!SCHOOL_NAMES[p.school]) errors.push(`${p.id}: неизвестная школа ${p.school}`);
      for (const s of p.signatures) {
        if (seen.has(s.id)) errors.push(`повтор приёма ${s.id}`);
        seen.add(s.id);
        if (!s.rule || !s.apply) errors.push(`${s.id}: нужны rule и apply`);
      }
    }
    for (const [roleId, entries] of Object.entries(this.lineage)) {
      if (!roleIds.has(roleId)) errors.push(`школа для несуществующей роли ${roleId}`);
      for (const e of entries) {
        const p = this.byId.get(e.practitioner);
        if (!p) {
          errors.push(`${roleId}: неизвестный практик ${e.practitioner}`);
          continue;
        }
        if (e.weight === 'secondary' && !e.signatures?.length) errors.push(`${roleId}: дополнительная школа ${e.practitioner} без списка приёмов`);
        for (const sid of e.signatures ?? []) if (!p.signatures.some((s) => s.id === sid)) errors.push(`${roleId}: у ${e.practitioner} нет приёма ${sid}`);
      }
    }
    return errors;
  }

  /** Приёмы роли: у основной школы — все (или выбранные), у дополнительной — выбранные. */
  signaturesFor(roleId: string): Array<{ sig: Signature; practitioner: Practitioner; weight: LineageEntry['weight'] }> {
    const out: Array<{ sig: Signature; practitioner: Practitioner; weight: LineageEntry['weight'] }> = [];
    for (const e of this.lineage[roleId] ?? []) {
      const p = this.byId.get(e.practitioner);
      if (!p) continue;
      const sigs = e.signatures?.length ? p.signatures.filter((s) => e.signatures!.includes(s.id)) : p.signatures;
      for (const sig of sigs) out.push({ sig, practitioner: p, weight: e.weight });
    }
    return out;
  }

  /** Секция системного промпта «Школа» для роли. Пустая строка, если школы нет. */
  schoolSection(roleId: string): string {
    const entries = this.lineage[roleId];
    if (!entries?.length) return '';
    const lines: string[] = ['Школа (твой профессиональный почерк):', this.boundary];
    for (const e of entries) {
      const p = this.byId.get(e.practitioner);
      if (!p) continue;
      const sigs = e.signatures?.length ? p.signatures.filter((s) => e.signatures!.includes(s.id)) : p.signatures;
      lines.push(`${e.weight === 'primary' ? 'Основная' : 'Дополнительная'} школа — ${p.name} (${p.org}; ${p.role}). Приёмы:`);
      for (const s of sigs) lines.push(`- [${s.id}] ${s.title}: ${s.rule} → в DRIVE&KAVA: ${s.apply}`);
      if (e.weight === 'primary') {
        if (p.method.length) lines.push(`  Метод: ${p.method.join(' ')}`);
        if (p.qualityBar.length) lines.push(`  Планка: ${p.qualityBar.join(' ')}`);
        if (p.avoid.length) lines.push(`  Избегать: ${p.avoid.join(' ')}`);
      }
    }
    lines.push('Применяй приёмы осознанно, ссылаясь на их ID (signaturesUsed), и не копируй экраны и бренд-элементы источников.');
    return lines.join('\n');
  }

  /** Подпись для карточки владельцу: «Перов: Как обычно?». */
  credit(signatureIds: string[]): string[] {
    return signatureIds
      .map((id) => this.signatures.get(id))
      .filter((x): x is { sig: Signature; practitioner: Practitioner } => Boolean(x))
      .map(({ sig, practitioner }) => `${shortName(practitioner)}: ${sig.title}`);
  }

  /** Досье практика в формате базы знаний (фрагменты «## » с метаданными). */
  toMarkdown(p: Practitioner, rolesUsing: string[]): string {
    const tier = p.sources.some((s) => s.tier === 'A') ? 'A' : 'B';
    const meta = (suffix: string, extraTags = '') => `<!-- meta: id=PR-${p.id}${suffix}; tier=${tier}; tags=practitioner,${p.school},${p.id}${extraTags}; kind=practitioner; rights=public-reference-only; url=${p.sources[0].url} -->`;
    const out = [
      `# ${p.name}`,
      '',
      `${p.org} · ${p.role} · школа «${SCHOOL_NAMES[p.school]}»`,
      '',
      '> Сгенерировано из studio/org/practitioners.json. Профессиональный почерк по публичным работам; не биография и не имитация личности.',
      '',
      `## ${p.name} — приёмы`,
      meta('-signatures'),
      ...p.signatures.map((s) => `- **${s.title}** [${s.id}]${s.basis === 'visual' ? ' (по анализу опубликованных изображений)' : ''}: ${s.rule} В DRIVE&KAVA: ${s.apply}`),
      '',
    ];
    if (p.method.length || p.qualityBar.length || p.avoid.length) {
      out.push(`## ${p.name} — метод и планка`, meta('-method'));
      if (p.method.length) out.push(`Метод: ${p.method.join(' ')}`);
      if (p.qualityBar.length) out.push(`Планка: ${p.qualityBar.join(' ')}`);
      if (p.avoid.length) out.push(`Избегать: ${p.avoid.join(' ')}`);
      out.push('');
    }
    out.push('## Источники', ...p.sources.map((s) => `- ${s.title} (тир ${s.tier}): ${s.url}`), '');
    if (p.confidence) out.push(`Уверенность: ${p.confidence}`, '');
    out.push(`Роли студии, работающие в этой школе: ${rolesUsing.length ? rolesUsing.join(', ') : '—'}`, '');
    return out.join('\n');
  }

  rolesUsing(practitionerId: string): string[] {
    return Object.entries(this.lineage).filter(([, es]) => es.some((e) => e.practitioner === practitionerId)).map(([r]) => r);
  }
}

/** Все сгенерированные файлы: досье в базу знаний и индекс docs/PRACTITIONERS.md. */
export function renderPractitionerDocs(book: PractitionerBook, roles: Array<{ id: string; title: string; status: string }>): Array<{ path: string; content: string }> {
  const files = book.all().map((p) => ({ path: `knowledge/practitioners/${p.id}.md`, content: book.toMarkdown(p, book.rolesUsing(p.id)) }));
  const title = new Map(roles.map((r) => [r.id, r]));
  const rows = Object.entries(book.lineage).map(([roleId, entries]) => {
    const r = title.get(roleId);
    const primary = entries.filter((e) => e.weight === 'primary').map((e) => book.get(e.practitioner)?.name ?? e.practitioner);
    const secondary = entries.filter((e) => e.weight === 'secondary').map((e) => `${book.get(e.practitioner)?.name ?? e.practitioner} (${(e.signatures ?? []).length})`);
    return `| ${r?.title ?? roleId}${r?.status === 'core' ? ' ★' : ''} | ${primary.join(', ') || '—'} | ${secondary.join(', ') || '—'} |`;
  });
  const people = book.all().map((p) => `| ${p.name} | ${p.org} | ${SCHOOL_NAMES[p.school]} | ${p.signatures.length} | ${p.sources.length} | [досье](../knowledge/practitioners/${p.id}.md) |`);
  const index = [
    '# Школы студии: практики и роли',
    '',
    '> Сгенерировано командой `npm run studio -- practitioners-docs` из `studio/org/practitioners.json`. Не редактировать вручную.',
    '',
    `**Граница.** ${book.boundary}`,
    '',
    'Каждая роль студии работает в почерке одной или двух основных школ и берёт отдельные приёмы у дополнительных. Почерк собран из публичных работ: кейсов Behance, постов LinkedIn и Telegram, статей Habr, эссе и кейсов студий. Личная информация не собиралась.',
    '',
    '## Роли и школы (★ — ядро первого этапа)',
    '',
    '| Роль | Основная школа | Дополнительно (число приёмов) |',
    '|---|---|---|',
    ...rows,
    '',
    '## Практики и студии',
    '',
    '| Кто | Где | Школа | Приёмов | Источников | Досье |',
    '|---|---|---|---|---|---|',
    ...people,
    '',
    '## Как это работает в конвейере',
    '',
    '1. В системный промпт роли добавляется секция «Школа»: приёмы основной школы целиком (с методом, планкой и «избегать»), у дополнительных — только выбранные.',
    '2. Автор экрана перечисляет применённые приёмы в `signaturesUsed`; несуществующие ID отбрасываются кодом.',
    '3. Критики оценивают критерий `school`: приёмы применены по делу и без копирования экранов и бренд-элементов источников.',
    '4. В карточке владельцу — строка «Школы: Перов: Как обычно?; Калинина: …».',
    '5. Досье лежат в базе знаний (`knowledge/practitioners`) и находятся поиском вместе с источниками.',
    '',
  ].join('\n');
  return [...files, { path: 'docs/PRACTITIONERS.md', content: index }];
}

/** Короткая подпись: фамилия для человека («Перов»), полное название для команды или студии. */
function shortName(p: Practitioner): string {
  const base = p.name.replace(/\s*\([^)]*\)/g, '').split('—')[0].trim();
  const words = base.split(/\s+/);
  const isPerson = p.school !== 'studios' && words.length === 2 && !words[0].includes('-') && /^[А-ЯA-Z]/.test(words[1]);
  return isPerson ? words[1] : base;
}
