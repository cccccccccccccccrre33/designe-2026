import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PractitionerBook, renderPractitionerDocs } from '../src/agents/practitioners.ts';
import { RoleBook } from '../src/agents/roles.ts';
import { KnowledgeBase } from '../src/knowledge/base.ts';
import { REPO } from './helpers.ts';

const book = await PractitionerBook.load(join(REPO, 'studio/org/practitioners.json'));
const roles = await RoleBook.load(join(REPO, 'studio/org/roles'));

test('школы: целостность ссылок, источники с https, только профессиональные поля', () => {
  assert.deepEqual(book.validate(new Set(roles.all().map((r) => r.id))), []);
  assert.ok(book.all().length >= 20);
  for (const p of book.all()) assert.ok(p.sources.every((s) => s.url.startsWith('https://')));
});

test('школы: у ядра команды и у всех авторов и критиков кастинга есть школа', async () => {
  for (const r of roles.all().filter((x) => x.status === 'core')) assert.ok(book.lineage[r.id]?.length, `нет школы у ${r.id}`);
  const casting = JSON.parse(await readFile(join(REPO, 'studio/org/casting.json'), 'utf8'));
  for (const t of Object.values(casting.types) as Array<{ author: string; critics: string[]; photo: string | null; motion: string | null }>) {
    for (const id of [t.author, ...t.critics, t.photo, t.motion].filter(Boolean) as string[]) assert.ok(book.lineage[id]?.length, `нет школы у ${id}`);
  }
});

test('школы: секция промпта содержит границу и приёмы основной школы', () => {
  const s = book.schoolSection('creative-director');
  assert.match(s, /не называет себя этим человеком/);
  assert.match(s, /PEROV-PORTAL/);
  assert.match(s, /AMO-WARMTH/);
  assert.match(s, /WO-WINDOW-MARK/); // дополнительная школа — только выбранные приёмы
  assert.doesNotMatch(s, /WO-TYPE-70-30/);
  assert.equal(book.schoolSection('нет-такой-роли'), '');
});

test('школы: вкус — факты только со ссылкой, интерпретации помечены, пробелы не выдумываются', () => {
  const s = book.schoolSection('creative-director');
  assert.match(s, /Вкус школы — ценит: .*Logo Modernism/);
  assert.match(s, /Вкус школы — отвергает: .*\(наша интерпретация\)/);
  assert.match(s, /Не известно о вкусе \(не выдумывать\)/);
  const bad = new PractitionerBook({
    boundary: 'b',
    lineage: {},
    practitioners: [{ ...book.get('perov')!, taste: { likes: [{ text: 'любит синий', basis: 'fact' }], dislikes: [] } }],
  });
  assert.match(bad.validate(new Set()).join('\n'), /факт вкуса без источника/);
});

test('школы: подпись для владельца отбрасывает выдуманные приёмы', () => {
  assert.deepEqual(book.credit(['PEROV-USUAL', 'ВЫДУМКА', 'RUB-RUBBER-BAND']), ['Перов: «Как обычно?»', 'Рубанов: Слайдер-резинка']);
  assert.deepEqual(book.credit(['DODO-ORDER-TYPE', 'PR-FULL-BLEED', 'IOS-LIQUID-GLASS', 'CNT-DROP-STORY']), [
    'Продуктовый дизайн Dodo Pizza: Тип заказа на главной',
    'PORTO ROCHA: Кинематографичный полный экран',
    'iOS-команда Drinkit: Liquid Glass по всему приложению',
    'Песякова: Дроп как одна история',
  ]);
});

test('школы: сгенерированные досье совпадают с каноном (npm run studio -- practitioners-docs)', async () => {
  for (const f of renderPractitionerDocs(book, roles.all())) {
    assert.equal(await readFile(join(REPO, f.path), 'utf8'), f.content, `${f.path} устарел — перегенерируйте`);
  }
});

test('школы: досье находятся поиском по базе знаний', async () => {
  const kb = await KnowledgeBase.load(REPO, ['knowledge/sources', 'knowledge/methods', 'knowledge/practitioners']);
  const hits = kb.search('слайдер резинка вибрация жест', { k: 3 });
  assert.equal(hits[0].id, 'PR-rubanov-signatures');
  const set = kb.search('цветовой мир вкуса реквизит сет-дизайн', { k: 3 });
  assert.ok(set.some((h) => h.id === 'PR-priadko-signatures'));
});
