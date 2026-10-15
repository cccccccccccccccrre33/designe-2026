// Автопроверки по отрендеренному DOM — «факты до мнений» (урок Review Gate bld-team).
// Критики получают результат как факт и не могут его переспорить.

import type { Measurements, MeasuredNode } from '../render/renderer.ts';
import { walk, type Rect, type ScreenSpec } from '../render/spec.ts';

export type Severity = 'blocking' | 'major' | 'minor';

export interface Finding {
  nodeId?: string;
  message: string;
}

export interface CheckResult {
  id: string;
  title: string;
  severity: Severity;
  passed: boolean;
  source: 'standard' | 'owner-preference';
  findings: Finding[];
}

export interface CheckContext {
  /** Латинские слова, допустимые в интерфейсе (названия из меню, бренд). */
  allowedLatin: Set<string>;
  /** ID проверок, которые исполняют активные hard-предпочтения владельца. */
  ownerHardChecks: Set<string>;
}

const RUSSIAN_LETTERS = /[ыЫэЭъЪёЁ]/;
const RUSSIAN_WORDS = new Set(['что', 'это', 'как', 'кофе', 'заказ', 'заказать', 'корзина', 'напиток', 'напитки', 'получить', 'ваш', 'ваша', 'сейчас', 'пожалуйста', 'спасибо', 'добавить', 'оформить', 'и', 'готовим', 'окно']);
const INTERACTIVE_ROLES = new Set(['primary-action', 'secondary-action', 'tab', 'nav']);

// Оплаты в приложении нет (PREF-008): гость только выбирает «Готівкою» или «Карткою».
// \b в JS не работает с кириллицей, поэтому границы слов не используются.
// Третий элемент — допустимо, если речь об оплате на месте: телефон или Apple/Google Pay
// у терминала, который подают из окна, — это оплата на месте, а не в приложении.
const ONLINE_PAYMENT: Array<[RegExp, string, boolean]> = [
  [/оплат\S*\s+(онлайн|зараз|в застосунку|у застосунку|через застосунок)/, 'оплата в приложении', false],
  [/онлайн[-\s]?оплат/, 'онлайн-оплата', false],
  [/(apple|google)\s*pay/, 'Apple/Google Pay', true],
  [/номер\s+картки|cvv|cvc|термін\s+дії\s+картки/, 'данные карты', false],
  [/(прив['’]язати|додати|зберегти)\s+картку/, 'привязка карты', false],
  [/передоплат|передплат/, 'предоплата', false],
  [/^оплачено|\sоплачено/, 'статус «оплачено»', false],
];
const PAY_VERB = /^\s*(о|с)плат(ити|іть)/;
const PAY_ON_SITE = /на місці|у вікн|в вікн|в залі|у залі|термінал/;
// Окно одно (PREF-009): без номеров и «другого окна». «У вікні 8:15–8:20» и
// «покажіть у вікні номер #48» — не номер окна.
const NUMBERED_WINDOW = /(вікн|окн)\S*(\s+(для|видачі|выдачи|авто))*\s*(№|#|n°)\s*\d|(перш|друг|трет)\S*\s+(вікн|окн)/;

function inViewport(n: MeasuredNode, m: Measurements): boolean {
  return n.rect.y < m.height && n.rect.y + n.rect.h > 0 && n.rect.x < m.width && n.rect.x + n.rect.w > 0 && n.effectiveOpacity > 0.05;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

function isInteractive(n: MeasuredNode): boolean {
  return n.kind === 'button' || n.kind === 'chip' || (n.role !== null && INTERACTIVE_ROLES.has(n.role));
}

function result(id: string, title: string, severity: Severity, findings: Finding[], ctx: CheckContext): CheckResult {
  const owner = ctx.ownerHardChecks.has(id);
  return { id, title, severity: owner ? 'blocking' : severity, passed: findings.length === 0, source: owner ? 'owner-preference' : 'standard', findings };
}

export function runChecks(spec: ScreenSpec, m: Measurements, ctx: CheckContext): CheckResult[] {
  const visible = m.nodes.filter((n) => inViewport(n, m));
  const texts = visible.filter((n) => n.text && n.text.trim());
  const out: CheckResult[] = [];

  // 1. Контраст текста по реальным пикселям фона (10-й перцентиль выборки).
  out.push(result('contrast-text', 'Контраст текста (WCAG AA по реальному фону)', 'blocking',
    texts.filter((n) => n.contrast && n.fontSize).flatMap((n) => {
      const large = n.fontSize! >= 24 || (n.fontSize! >= 18.66 && (n.fontWeight ?? 400) >= 700);
      const need = large ? 3 : 4.5;
      return n.contrast!.p10 < need ? [{ nodeId: n.id, message: `«${short(n.text!)}»: контраст ${n.contrast!.p10}:1, нужно ≥ ${need}:1` }] : [];
    }), ctx));

  // 2. Размер касания.
  out.push(result('touch-target', 'Цели касания ≥ 44×44 pt', 'blocking',
    visible.filter(isInteractive).flatMap((n) => (n.rect.w + 0.5 < 44 || n.rect.h + 0.5 < 44 ? [{ nodeId: n.id, message: `${Math.round(n.rect.w)}×${Math.round(n.rect.h)} pt` }] : [])), ctx));

  // 3. Только украинский.
  out.push(result('ukrainian-only', 'Интерфейс только на украинском', 'blocking',
    texts.flatMap((n) => {
      const t = n.text!;
      const issues: Finding[] = [];
      if (RUSSIAN_LETTERS.test(t)) issues.push({ nodeId: n.id, message: `русские буквы в «${short(t)}»` });
      const words = t.toLowerCase().split(/[^a-zа-яіїєґ'’-]+/i).filter(Boolean);
      const ru = words.filter((w) => RUSSIAN_WORDS.has(w));
      if (ru.length) issues.push({ nodeId: n.id, message: `русские слова (${ru.join(', ')}) в «${short(t)}»` });
      const latin = (t.match(/[A-Za-z][A-Za-z&'-]+/g) ?? []).filter((w) => !ctx.allowedLatin.has(w.toLowerCase()));
      if (latin.length) issues.push({ nodeId: n.id, message: `латиница вне меню и бренда: ${latin.join(', ')}` });
      return issues;
    }), ctx));

  // 4. Безопасные зоны.
  out.push(result('safe-area', 'Текст и элементы управления вне системных зон', 'blocking',
    visible.filter((n) => (n.text || isInteractive(n)) && !n.inScroll).flatMap((n) => {
      const issues: Finding[] = [];
      if (n.rect.y < m.safeTop - 0.5) issues.push({ nodeId: n.id, message: `заходит в статус-бар (y=${Math.round(n.rect.y)})` });
      if (n.rect.y + n.rect.h > m.height - m.safeBottom + 0.5) issues.push({ nodeId: n.id, message: `заходит в зону жеста «домой» (низ=${Math.round(n.rect.y + n.rect.h)})` });
      return issues;
    }), ctx));

  // 5. Зона большого пальца и 6. одно главное действие.
  const primaries = visible.filter((n) => n.role === 'primary-action');
  out.push(result('thumb-zone', 'Главное действие в зоне большого пальца', 'major',
    primaries.flatMap((n) => (n.rect.y + n.rect.h / 2 < m.height * 0.55 ? [{ nodeId: n.id, message: `центр на ${Math.round(((n.rect.y + n.rect.h / 2) / m.height) * 100)}% высоты, нужно ниже 55%` }] : [])), ctx));
  out.push(result('single-primary', 'Не больше одного главного действия', 'major',
    primaries.length > 1 ? [{ message: `главных действий: ${primaries.length} (${primaries.map((p) => p.id).join(', ')})` }] : [], ctx));

  // 7. Непрозрачные элементы поверх напитка.
  const hero = m.heroZone;
  const heroArea = hero ? hero.w * hero.h : 0;
  out.push(result('hero-occlusion', 'Непрозрачные элементы не закрывают напиток', 'major',
    hero && heroArea > 0
      ? visible.filter((n) => n.paintsAfterHero && !n.isHeroOrInside && n.bgAlpha * n.effectiveOpacity >= 0.85).flatMap((n) => {
          const share = overlap(n.rect, hero) / heroArea;
          return share > 0.06 ? [{ nodeId: n.id, message: `перекрывает ${Math.round(share * 100)}% зоны напитка` }] : [];
        })
      : [], ctx));

  // 8. Размер промо-баннеров.
  const screenArea = m.width * m.height;
  out.push(result('promo-banner-size', 'Промо-блоки не больше 25% экрана', 'major',
    visible.filter((n) => n.role === 'promo').flatMap((n) => {
      const share = overlap(n.rect, { x: 0, y: 0, w: m.width, h: m.height }) / screenArea;
      return share > 0.25 ? [{ nodeId: n.id, message: `занимает ${Math.round(share * 100)}% экрана` }] : [];
    }), ctx));

  // 9. Минимальный кегль и 10. переполнение текста.
  out.push(result('min-font-size', 'Кегль не меньше 11 pt', 'major',
    texts.flatMap((n) => (n.fontSize! < 11 ? [{ nodeId: n.id, message: `${n.fontSize} pt` }] : [])), ctx));
  out.push(result('text-overflow', 'Текст помещается в свой блок', 'major',
    texts.filter((n) => n.overflow).map((n) => ({ nodeId: n.id, message: `«${short(n.text!)}» не помещается` })), ctx));

  // 11. Разные сцены у напитков в серии (предпочтение владельца).
  const scenes: Array<{ id: string; key: string }> = [];
  walk(spec.nodes, (node) => {
    if (node.kind === 'drink' && node.drink) scenes.push({ id: node.id, key: `${node.drink.scene}|${node.drink.sceneColors.join(',')}` });
  });
  const seen = new Map<string, string>();
  const dupes: Finding[] = [];
  for (const s of scenes) {
    const prev = seen.get(s.key);
    if (prev) dupes.push({ nodeId: s.id, message: `та же сцена, что у ${prev}` });
    else seen.set(s.key, s.id);
  }
  out.push(result('background-variety', 'У напитков разные сцены и фоны', 'major', scenes.length >= 2 ? dupes : [], ctx));

  // 12. Сетка 4 pt: позиции, отступы и зазоры. Ширины вроде 393−2·20=353 не проверяются.
  const grid: Finding[] = [];
  const offGrid = (v: unknown) => typeof v === 'number' && Math.abs(v % 4) > 0.01;
  walk(spec.nodes, (node) => {
    for (const k of ['x', 'y', 'right', 'bottom'] as const) {
      const v = node.frame?.[k];
      if (offGrid(v) && grid.length < 6) grid.push({ nodeId: node.id, message: `frame.${k}=${v} не кратно 4` });
    }
    const pads = node.layout?.pad === undefined ? [] : Array.isArray(node.layout.pad) ? node.layout.pad : [node.layout.pad];
    for (const v of [node.layout?.gap, ...pads]) {
      if (offGrid(v) && grid.length < 6) grid.push({ nodeId: node.id, message: `отступ ${v} не кратен 4` });
    }
  });
  out.push(result('grid-4pt', 'Отступы и размеры по сетке 4 pt', 'minor', grid, ctx));

  // 13. Оплата только на месте: в интерфейсе нет онлайн-оплаты и кнопки «Оплатити».
  out.push(result('no-online-payment', 'Без оплаты в приложении: только выбор «Готівкою» / «Карткою»', 'blocking',
    texts.flatMap((n) => {
      const t = n.text!.toLowerCase();
      const issues: Finding[] = ONLINE_PAYMENT.filter(([re, , onSiteOk]) => re.test(t) && !(onSiteOk && PAY_ON_SITE.test(t))).map(([, what]) => ({ nodeId: n.id, message: `${what}: «${short(n.text!)}»` }));
      if (isInteractive(n) && PAY_VERB.test(t) && !PAY_ON_SITE.test(t)) issues.push({ nodeId: n.id, message: `кнопка оплаты «${short(n.text!)}» — нужно «Замовити»` });
      return issues;
    }), ctx));

  // 14. Одно окно: заказ, оплата и выдача в одном месте, окно не нумеруется.
  out.push(result('single-window', 'Окно одно: без номеров и «другого окна»', 'major',
    texts.filter((n) => NUMBERED_WINDOW.test(n.text!.toLowerCase())).map((n) => ({ nodeId: n.id, message: `«${short(n.text!)}» — у DRIVE&KAVA одно окно` })), ctx));

  return out;
}

export function factsSummary(results: CheckResult[]): { blocking: number; major: number; minor: number; text: string } {
  const failed = results.filter((r) => !r.passed);
  const count = (s: Severity) => failed.filter((r) => r.severity === s).length;
  const lines = results.map((r) => `${r.passed ? '✓' : r.severity === 'blocking' ? '✗ БЛОК' : r.severity === 'major' ? '✗ важно' : '· мелочь'} ${r.id} — ${r.title}${r.passed ? '' : ': ' + r.findings.slice(0, 3).map((f) => (f.nodeId ? `[${f.nodeId}] ` : '') + f.message).join('; ')}${r.source === 'owner-preference' ? ' (предпочтение владельца)' : ''}`);
  return { blocking: count('blocking'), major: count('major'), minor: count('minor'), text: lines.join('\n') };
}

function short(s: string): string {
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}
