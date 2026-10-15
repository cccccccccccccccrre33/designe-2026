// Маленький валидатор подмножества JSON Schema. Нужен, чтобы ответы моделей
// проверялись кодом, а не поиском подстрок (урок bld-team: "РЕШЕНИЕ: APPROVE").

export type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; description?: string }
  | { type: 'array'; items: Schema; minItems?: number; maxItems?: number; description?: string }
  | { type: 'string'; enum?: string[]; minLength?: number; maxLength?: number; description?: string }
  | { type: 'number'; minimum?: number; maximum?: number; integer?: boolean; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'any'; description?: string };

export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  switch (schema.type) {
    case 'any':
      return errors;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return [`${path}: ожидался объект`];
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined || obj[key] === null) errors.push(`${path}.${key}: обязательное поле отсутствует`);
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (obj[key] !== undefined && obj[key] !== null) errors.push(...validate(sub, obj[key], `${path}.${key}`));
      }
      return errors;
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: ожидался массив`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: минимум ${schema.minItems} элементов`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: максимум ${schema.maxItems} элементов`);
      value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
      return errors;
    }
    case 'string': {
      if (typeof value !== 'string') return [`${path}: ожидалась строка`];
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: значение «${value}» не из списка ${schema.enum.join('|')}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: слишком короткая строка`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: длиннее ${schema.maxLength} символов`);
      return errors;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return [`${path}: ожидалось число`];
      if (schema.integer && !Number.isInteger(value)) errors.push(`${path}: ожидалось целое`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: меньше ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: больше ${schema.maximum}`);
      return errors;
    }
    case 'boolean':
      return typeof value === 'boolean' ? errors : [`${path}: ожидалось true/false`];
  }
}

/** Компактное текстовое описание схемы для промпта: модель видит точную форму ответа. */
export function describeSchema(schema: Schema, indent = 0): string {
  const pad = '  '.repeat(indent);
  const note = schema.description ? `  // ${schema.description}` : '';
  switch (schema.type) {
    case 'object': {
      const req = new Set(schema.required ?? []);
      const lines = Object.entries(schema.properties).map(([k, v]) => {
        const opt = req.has(k) ? '' : '?';
        return `${pad}  "${k}"${opt}: ${describeSchema(v, indent + 1).trimStart()}`;
      });
      return `{${note}\n${lines.join(',\n')}\n${pad}}`;
    }
    case 'array': {
      const bounds = [schema.minItems !== undefined ? `min ${schema.minItems}` : '', schema.maxItems !== undefined ? `max ${schema.maxItems}` : ''].filter(Boolean).join(', ');
      return `[${describeSchema(schema.items, indent).trimStart()}]${bounds ? ` /* ${bounds} */` : ''}${note}`;
    }
    case 'string':
      return (schema.enum ? schema.enum.map((e) => `"${e}"`).join(' | ') : 'string') + note;
    case 'number':
      return `number${schema.minimum !== undefined || schema.maximum !== undefined ? ` (${schema.minimum ?? '-∞'}..${schema.maximum ?? '∞'})` : ''}${note}`;
    case 'boolean':
      return `boolean${note}`;
    case 'any':
      return `any${note}`;
  }
}
