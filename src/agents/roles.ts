// Профили ролей из studio/org/roles/*.json. Профиль не содержит модели (ADR-0006).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RoleProfile {
  id: string;
  title: string;
  department: string;
  reportsTo: string;
  status: 'core' | 'planned';
  modes: Array<'agent' | 'lens' | 'check'>;
  domain: string;
  responsibilities: string[];
  decisionMethod: string;
  qualityCriteria: string[];
  researchMethods: string[];
  references: string[];
  knowledgeTags: string[];
  strengths: string[];
  risks: string[];
  disagreementTriggers: Array<{ with: string; when: string }>;
  veto?: { scope: string; requiresEvidence: boolean };
  tools: string[];
  output: { schema: string; description: string };
  handoffRules: Array<{ to: string; when: string }>;
}

export const REQUIRED_FIELDS: Array<keyof RoleProfile> = [
  'domain', 'responsibilities', 'decisionMethod', 'qualityCriteria', 'researchMethods', 'references',
  'knowledgeTags', 'strengths', 'risks', 'disagreementTriggers', 'tools', 'output', 'handoffRules',
];

export class RoleBook {
  private roles = new Map<string, RoleProfile>();

  static async load(dir: string): Promise<RoleBook> {
    const book = new RoleBook();
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
      const list = JSON.parse(await readFile(join(dir, name), 'utf8')) as RoleProfile[];
      for (const role of list) {
        if (book.roles.has(role.id)) throw new Error(`Роль ${role.id} описана дважды`);
        book.roles.set(role.id, role);
      }
    }
    return book;
  }

  get(id: string): RoleProfile {
    const role = this.roles.get(id);
    if (!role) throw new Error(`Неизвестная роль: ${id}`);
    return role;
  }

  has(id: string): boolean {
    return this.roles.has(id);
  }

  all(): RoleProfile[] {
    return [...this.roles.values()];
  }
}
