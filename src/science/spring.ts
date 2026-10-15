// Пружины для Motion Spec. Дизайнер задаёт duration и bounce (как в SwiftUI),
// разработчик получает stiffness/damping/mass и easing для CSS linear().
// Модель: затухающий осциллятор x'' = -k(x-1) - c·x', масса 1.
// Связь: k = (2π/d)², c = 4π(1-b)/d при b ≥ 0, откуда коэффициент затухания ζ = 1 - b.

export interface SpringPhysics {
  duration: number;
  bounce: number;
  mass: number;
  stiffness: number;
  damping: number;
  dampingRatio: number;
  settleMs: number;
  overshootPct: number;
  cssEasing: string;
}

export function springFromDurationBounce(duration: number, bounce: number, initialVelocity = 0): SpringPhysics {
  if (duration <= 0) throw new Error('duration > 0');
  const b = Math.max(-0.9, Math.min(0.95, bounce));
  const stiffness = (2 * Math.PI / duration) ** 2;
  const damping = b >= 0 ? (4 * Math.PI * (1 - b)) / duration : (4 * Math.PI) / (duration * (1 + b));
  const dampingRatio = damping / (2 * Math.sqrt(stiffness));
  const sim = simulate(stiffness, damping, initialVelocity);
  return {
    duration,
    bounce: b,
    mass: 1,
    stiffness: round(stiffness, 2),
    damping: round(damping, 2),
    dampingRatio: round(dampingRatio, 3),
    settleMs: Math.round(sim.settle * 1000),
    overshootPct: round(Math.max(0, sim.peak - 1) * 100, 2),
    cssEasing: `linear(${sim.samples.map((v) => round(v, 3)).join(', ')})`,
  };
}

/** Полунеявный Эйлер с шагом 1 мс: устойчив для наших диапазонов. */
export function simulate(k: number, c: number, v0 = 0, samples = 24): { settle: number; peak: number; samples: number[] } {
  const dt = 0.001;
  let x = 0;
  let v = v0;
  let t = 0;
  let peak = 0;
  let settle = 0;
  const trace: number[] = [];
  while (t < 10) {
    const a = -k * (x - 1) - c * v;
    v += a * dt;
    x += v * dt;
    t += dt;
    trace.push(x);
    peak = Math.max(peak, x);
    if (Math.abs(x - 1) > 0.001 || Math.abs(v) > 0.01) settle = t;
    else if (t - settle > 0.2) break;
  }
  const total = Math.max(settle, dt);
  const out: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const idx = Math.min(trace.length - 1, Math.round(((i / samples) * total) / dt));
    out.push(i === samples ? 1 : trace[idx]);
  }
  return { settle: total, peak, samples: out };
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
