// Загрузка конфигурации студии из репозитория и окружения.
// Пустая переменная окружения считается незаданной (урок bld-team: GitHub Actions
// передаёт отсутствующие vars как пустые строки).

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BudgetPolicy } from '../budget/ledger.ts';
import type { ModelRegistryConfig } from '../llm/types.ts';
import type { Tokens } from '../render/spec.ts';

export interface CastingType {
  positions: string[];
  author: string;
  photo: string | null;
  photoLenses: string[];
  motion: string | null;
  critics: string[];
  director: string;
}

export interface Casting {
  types: Record<string, CastingType>;
  tagTriggers: Record<string, { addPositions?: string[]; consult?: string[] }>;
  limits: { maxPositions: number; maxCritics: number; maxConsults: number };
  /** Проверка старшими до владельца и ведущий, который показывает результат. */
  review?: {
    seniors: string[];
    maxRounds: number;
    presenter: { default: string; autonomous?: string; byType?: Record<string, string> };
    titles?: Record<string, string>;
  };
}

export interface Rubric {
  criteria: Array<{ id: string; title: string; weight: number }>;
  passScore: number;
  arbiterMargin: number;
  arbiterDisagreement: number;
}

export interface CatalogItem {
  cat: string;
  name: string;
  sub: string;
  /** [обʼєм, ціна]; ціна null — владелец ещё не назвал, обʼєм "" — не указан. */
  sizes: Array<[string, number | null]>;
  mode: 'ice' | 'milk';
  /** Как напиток выглядит физически — опора для фуд-стилиста и генерации (status: standard | hypothesis). */
  look?: { status: 'standard' | 'hypothesis'; base: string; layers: string; ice: string; garnish: string; vessel: string };
  note?: string;
}

export interface StudioConfig {
  repoRoot: string;
  models: ModelRegistryConfig;
  budget: BudgetPolicy;
  casting: Casting;
  rubric: Rubric;
  tokens: Tokens;
  catalog: CatalogItem[];
  principles: Array<{ id: string; title: string; rule: string }>;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function loadConfig(repoRoot: string): Promise<StudioConfig> {
  return {
    repoRoot,
    models: await json(join(repoRoot, 'studio/policies/models.json')),
    budget: await json(join(repoRoot, 'studio/policies/budget.json')),
    casting: await json(join(repoRoot, 'studio/org/casting.json')),
    rubric: await json(join(repoRoot, 'studio/org/rubric.json')),
    tokens: await json(join(repoRoot, 'design-system/tokens.json')),
    catalog: await json(join(repoRoot, 'product/catalog.v83.json')),
    principles: (await json<{ principles: StudioConfig['principles'] }>(join(repoRoot, 'design-system/principles.json'))).principles,
  };
}

export function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** Минимальный загрузчик .env без зависимостей. Значения из окружения важнее файла. */
export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}
