// Ошибки, на которые конвейер реагирует по-разному: пауза, переход к другой модели, отказ.

export class StudioError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.details = details;
  }
}

/** Резерв бюджета не выдан — инициатива встаёт на паузу, а не деградирует молча. */
export class BudgetExceeded extends StudioError {
  scope: string;
  constructor(scope: string, message: string, details: Record<string, unknown> = {}) {
    super('budget_exceeded', message, details);
    this.name = 'BudgetExceeded';
    this.scope = scope;
  }
}

/** Все кандидаты для класса задачи исчерпаны. */
export class ModelChainExhausted extends StudioError {
  constructor(taskClass: string, attempts: Array<{ model: string; error: string; outcome?: string }>) {
    super('model_chain_exhausted', `Нет доступной модели для «${taskClass}»`, { attempts });
    this.name = 'ModelChainExhausted';
  }
}

/** Ошибка провайдера модели. kind определяет, что делать дальше. */
export class ProviderError extends StudioError {
  kind: 'retryable' | 'unavailable' | 'bad_request' | 'auth';
  status: number;
  constructor(kind: 'retryable' | 'unavailable' | 'bad_request' | 'auth', status: number, message: string) {
    super(`provider_${kind}`, message, { status });
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Сессия заканчивается (рабочие часы, лимит времени задания): новый шаг не начинается,
 * инициатива встаёт на паузу и продолжается в следующей сессии с того же шага.
 */
export class StopRequested extends StudioError {
  constructor(message: string) {
    super('stop_requested', message);
    this.name = 'StopRequested';
  }
}

/** Действие запрещено политикой (например, merge PR с изменениями кода). */
export class PolicyViolation extends StudioError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('policy_violation', message, details);
    this.name = 'PolicyViolation';
  }
}
