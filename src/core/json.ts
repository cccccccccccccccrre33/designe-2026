// Извлечение JSON из ответа модели: модели оборачивают его в ```json, добавляют
// пояснения или блоки рассуждений <think>…</think>.

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], cleaned].filter((c): c is string => typeof c === 'string');
  for (const candidate of candidates) {
    const direct = tryParse(candidate.trim());
    if (direct.ok) return direct.value;
    const sliced = sliceBalanced(candidate);
    if (sliced) {
      const parsed = tryParse(sliced);
      if (parsed.ok) return parsed.value;
    }
  }
  throw new SyntaxError('В ответе модели не найден корректный JSON');
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** Первый сбалансированный объект или массив с учётом строк и экранирования. */
function sliceBalanced(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
