// Меню v83 владельца и производство карточек: цены только названные, фото-бриф
// получает физику напитка, импорт ссылок не затирает предыдущие входящие.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.ts';
import { drinkTruth } from '../src/pipeline/studio.ts';
import { ingestLinkArchive } from '../src/knowledge/ingest.ts';
import { KnowledgeBase } from '../src/knowledge/base.ts';
import type { ModelRegistryConfig } from '../src/llm/types.ts';
import { REPO } from './helpers.ts';

const config = await loadConfig(REPO);

test('меню v83: 28 позиций, цены — только названные владельцем', () => {
  assert.equal(config.catalog.length, 28);
  const by = (n: string) => config.catalog.find((c) => c.name === n)!;
  assert.deepEqual(by('Капучино').sizes, [['250 мл', 90], ['350 мл', 110], ['450 мл', null]]);
  assert.deepEqual(by('Еспресо').sizes, [['100 мл', 50]]);
  assert.deepEqual(by('Манго-Маракеш').sizes, []); // цены лимонадов владелец не называл
  assert.ok(config.catalog.filter((c) => c.cat === 'Drive Mood').every((c) => c.sizes[0][1] === 170));
  assert.ok(config.catalog.every((c) => c.look), 'у каждого напитка описан внешний вид');
});

test('фото-бриф: физика напитка из каталога, неподтверждённое помечено, цен-заглушек нет', () => {
  const latte = drinkTruth(config.catalog, 'Айс Лате');
  assert.match(latte, /холодный, со льдом/);
  assert.match(latte, /облаками|«хмарами»/);
  assert.match(latte, /стандартный рецепт/);
  const bee = drinkTruth(config.catalog, 'Айс Джмелик');
  assert.match(bee, /не подтверждён владельцем/);
  const capu = drinkTruth(config.catalog, 'Капучино');
  assert.match(capu, /250 мл — 90 ₴, 350 мл — 110 ₴, 450 мл/);
  assert.doesNotMatch(capu, /null/);
  assert.match(drinkTruth(config.catalog, 'Матча'), /нет в меню/);
});

test('стандарт физики напитка находится поиском для фото-брифа', async () => {
  const kb = await KnowledgeBase.load(REPO, ['knowledge/methods']);
  const hits = kb.search('физика лёд конденсат пена слои', { k: 4, tags: ['physics'] });
  assert.ok(hits.some((h) => h.id === 'M-PHYS-ICE'));
  assert.ok(hits.every((h) => h.tags.includes('physics')));
});

test('модели: фото-бриф пишут модели со зрением, а создают картинки и видео только генеративные модели', async () => {
  const c = JSON.parse(await readFile(join(REPO, 'studio/policies/models.json'), 'utf8')) as ModelRegistryConfig;
  // Grok и GPT-5.6 Luna не открыты для аккаунта (проверка 16.10.2026) — первым Kimi K3.
  assert.equal(c.assignments.photo[0], 'kimi-k3');
  for (const key of c.assignments.photo) assert.ok(c.models.find((m) => m.key === key)!.input.includes('image'), `${key} должна видеть экран`);
  for (const key of [c.images.search, c.images.final]) assert.equal(c.models.find((m) => m.key === key)!.kind, 'image');
  const ray = c.models.find((m) => m.key === c.video?.generate)!;
  assert.equal(ray.kind, 'video');
  assert.equal(ray.enabled, false, 'без бакета S3 генерация видео выключена');
});

test('импорт ссылок: второй архив за день не затирает первый', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dk-ing-'));
  await mkdir(join(root, 'knowledge/sources'), { recursive: true });
  const a = join(root, 'a.md');
  await writeFile(a, '# A\n- Первый: https://example.com/1\n');
  const first = await ingestLinkArchive(root, a);
  await writeFile(a, '# B\n- Второй: https://example.com/2\n');
  const second = await ingestLinkArchive(root, a);
  assert.notEqual(first.path, second.path);
  assert.match(await readFile(first.path, 'utf8'), /example\.com\/1/);
  assert.match(await readFile(second.path, 'utf8'), /example\.com\/2/);
});
