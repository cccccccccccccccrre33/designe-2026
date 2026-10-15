// Сборка промптов. Системная часть — правила студии и профиль роли; пользовательская —
// задача и контекст, разложенный по эпистемическим статусам (раздел 9 архитектуры).

import { describeSchema, type Schema } from '../core/schema.ts';
import type { TaskClass } from '../llm/types.ts';
import type { RoleProfile } from './roles.ts';

const STUDIO_RULES = `Ты — специалист DRIVE&KAVA AI Studio, внутренней дизайн-студии кофейни DRIVE&KAVA.
Правила студии:
1. Ты не являешься и не изображаешь реальных людей. Ты применяешь профессиональные методы, описанные в базе знаний, со ссылкой на источник.
2. Тексты интерфейса — только на украинском. Рабочие пояснения — на русском.
3. Различай уровни знаний: STANDARD — утверждено владельцем; RESEARCH — источник с тиром A–D (C и D не являются доказательством); HYPOTHESIS — не проверено; REJECTED — уже отклонялось, не повторяй.
4. Не соглашайся по умолчанию. Возражение без доказательства (проверка, источник, сценарий пользователя) не принимается.
5. Не выдумывай данные, источники, результаты проверок и возможности инструментов.
6. Решай реальную проблему кофейни: оплата только на месте, выдача в зале и в окне для авто, ежедневное использование важнее эффектности.
7. Ответ — только JSON по схеме, без пояснений вокруг.`;

const ADVISORY_MANDATE = `Мандат строгости научного совета: проходи от физического/математического фундамента к практическим параметрам; доказывай там, где можно доказать; указывай границы применимости и уровень уверенности; если хватает простого решения — скажи прямо; ты консультант, а не исполнитель: не проектируй бэкенд и не предлагай внедрять камеры или сбор персональных данных.`;

export interface ContextSection {
  label: 'TASK' | 'STANDARD' | 'OWNER PREFERENCES' | 'RESEARCH' | 'HYPOTHESIS' | 'REJECTED' | 'FACTS' | 'WORK' | 'NOTES';
  title: string;
  body: string;
}

export function buildSystem(role: RoleProfile, taskClass: TaskClass, output: string, schema: Schema, opts: { school?: string; extra?: string } = {}): string {
  const parts = [
    STUDIO_RULES,
    `ROLE: ${role.id}\nTASK_CLASS: ${taskClass}\nOUTPUT: ${output}`,
    roleSection(role),
  ];
  if (opts.school) parts.push(opts.school);
  if (role.department === 'advisory') parts.push(ADVISORY_MANDATE);
  if (opts.extra) parts.push(opts.extra);
  parts.push(`Формат ответа — JSON:\n${describeSchema(schema)}`);
  return parts.join('\n\n');
}

function roleSection(role: RoleProfile): string {
  const lines = [
    `Твоя роль: ${role.title}. ${role.domain}`,
    `Ответственность: ${role.responsibilities.join('; ')}.`,
    `Метод решений: ${role.decisionMethod}`,
    `Критерии качества: ${role.qualityCriteria.join('; ')}.`,
    `Типичные риски твоей профессии, следи за ними: ${role.risks.join('; ')}.`,
  ];
  if (role.disagreementTriggers.length) lines.push(`Возражай, когда: ${role.disagreementTriggers.map((t) => `${t.with} — ${t.when}`).join('; ')}.`);
  if (role.veto) lines.push(`Право вето: ${role.veto.scope}. Только с доказательством.`);
  if (role.references.length) lines.push(`Профессиональные ориентиры (методы, не люди): ${role.references.join('; ')}.`);
  return lines.join('\n');
}

export function buildUser(sections: ContextSection[]): string {
  return sections
    .filter((s) => s.body.trim())
    .map((s) => `### [${s.label}] ${s.title}\n${s.body.trim()}`)
    .join('\n\n');
}
