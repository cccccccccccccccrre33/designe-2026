// Модель очереди для исследования «честного времени готовности» (научный совет).
// Не сервис производства: инструмент, чтобы дизайнеры и консультанты видели, какой
// интервал реалистично показывать гостю при разной загрузке бариста.
//
// Модель: c бариста, заказы обслуживаются по очереди (FIFO), позиция заказа
// готовится одним бариста; время позиции — логнормальное вокруг базового времени
// рецепта с разбросом sigma. Метод: Монте-Карло.

export interface OrderItem {
  /** Базовое время приготовления позиции, секунды (эспрессо ≈ 60, раф ≈ 180, лимонад ≈ 120). */
  baseSec: number;
}

export interface QueueScenario {
  baristas: number;
  /** Заказы перед новым, в порядке очереди. */
  queue: OrderItem[][];
  /** Новый заказ гостя. */
  order: OrderItem[];
  /** Логнормальный разброс времени позиции (0.25 ≈ ±25%). */
  sigma?: number;
  /** Время на выдачу заказа, секунды. */
  handoffSec?: number;
}

export interface EtaEstimate {
  p50Min: number;
  p90Min: number;
  meanMin: number;
  display: string;
}

/** Детерминированный генератор (mulberry32) — одинаковые сценарии дают одинаковый ответ. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lognormal(rand: () => number, mean: number, sigma: number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // Параметр mu подобран так, чтобы матожидание было равно mean.
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  return Math.exp(mu + sigma * z);
}

export function estimateEta(s: QueueScenario, runs = 4000, seed = 42): EtaEstimate {
  const rand = rng(seed);
  const sigma = s.sigma ?? 0.25;
  const handoff = s.handoffSec ?? 20;
  const results: number[] = [];
  for (let r = 0; r < runs; r++) {
    const free = new Array(Math.max(1, s.baristas)).fill(0);
    let finish = 0;
    for (const order of [...s.queue, s.order]) {
      finish = 0;
      for (const item of order) {
        free.sort((x, y) => x - y);
        free[0] += lognormal(rand, item.baseSec, sigma);
        finish = Math.max(finish, free[0]);
      }
    }
    results.push((finish + handoff) / 60);
  }
  results.sort((x, y) => x - y);
  const q = (p: number) => results[Math.min(results.length - 1, Math.floor(p * results.length))];
  const p50 = q(0.5);
  const p90 = q(0.9);
  const lo = Math.max(1, Math.floor(p50));
  const hi = Math.max(lo + 1, Math.ceil(p90));
  return {
    p50Min: Math.round(p50 * 10) / 10,
    p90Min: Math.round(p90 * 10) / 10,
    meanMin: Math.round((results.reduce((a, b) => a + b, 0) / results.length) * 10) / 10,
    display: `${lo}–${hi} хв`,
  };
}

/** Erlang C: вероятность ожидания в M/M/c (λ, μ — в заказах в минуту). */
export function erlangC(lambda: number, mu: number, c: number): number {
  const a = lambda / mu;
  const rho = a / c;
  if (rho >= 1) return 1;
  let sum = 0;
  let term = 1;
  for (let k = 0; k < c; k++) {
    if (k > 0) term *= a / k;
    sum += term;
  }
  const last = term * (a / c) / (1 - rho);
  return last / (sum + last);
}
