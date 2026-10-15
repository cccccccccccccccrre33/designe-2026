// Рендер Screen Spec в PNG через headless Chromium (установленный Chrome/Edge) и
// измерение геометрии и стилей из DOM — сырьё для автопроверок.
// В облаке тот же код подключается к AgentCore Browser или к Chromium в контейнере.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { renderHtml } from './html.ts';
import { applyState, type Rect, type ScreenSpec, type Tokens } from './spec.ts';

export interface MeasuredNode {
  id: string;
  kind: string;
  role: string | null;
  rect: Rect;
  text: string | null;
  fontSize: number | null;
  fontWeight: number | null;
  color: [number, number, number, number] | null;
  bgAlpha: number;
  effectiveOpacity: number;
  glass: boolean;
  paintsAfterHero: boolean;
  isHeroOrInside: boolean;
  overflow: boolean;
  inScroll: boolean;
  contrast: { min: number; p10: number } | null;
}

export interface Measurements {
  width: number;
  height: number;
  safeTop: number;
  safeBottom: number;
  heroZone: Rect | null;
  nodes: MeasuredNode[];
}

export interface RenderResult {
  png: Buffer;
  preview: Buffer;
  states: Array<{ id: string; label: string; png: Buffer }>;
  measurements: Measurements;
}

const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));

export function findBrowser(): string | null {
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export class ScreenRenderer {
  private tokens: Tokens;
  private fontPath: string;
  private browser: Browser | null = null;
  private fontDataUrl: string | null = null;

  constructor(tokens: Tokens, designSystemDir: string) {
    this.tokens = tokens;
    this.fontPath = join(designSystemDir, tokens.font.file);
  }

  async start(): Promise<void> {
    if (this.browser) return;
    const executablePath = findBrowser();
    if (!executablePath) throw new Error('Не найден Chrome/Edge для рендера. Укажите BROWSER_PATH.');
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.launch({ executablePath, headless: true });
    if (existsSync(this.fontPath)) {
      this.fontDataUrl = `data:font/ttf;base64,${(await readFile(this.fontPath)).toString('base64')}`;
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  async render(spec: ScreenSpec, opts: { scale?: number; assets?: Record<string, string> } = {}): Promise<RenderResult> {
    await this.start();
    const scale = opts.scale ?? 3;
    const main = await this.shoot(spec, scale, opts.assets, true);
    const preview = await this.shoot(spec, 1, opts.assets, false);
    const states: RenderResult['states'] = [];
    for (const state of spec.states ?? []) {
      const shot = await this.shoot(applyState(spec, state.id), 2, opts.assets, false);
      states.push({ id: state.id, label: state.label, png: shot.png });
    }
    return { png: main.png, preview: preview.png, states, measurements: main.measurements! };
  }

  private async shoot(spec: ScreenSpec, scale: number, assets: Record<string, string> | undefined, measure: boolean): Promise<{ png: Buffer; measurements?: Measurements }> {
    const d = this.tokens.device;
    const context = await this.browser!.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: scale });
    try {
      const page = await context.newPage();
      await page.setContent(renderHtml(spec, this.tokens, { fontDataUrl: this.fontDataUrl ?? undefined, assets }), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const png = await page.screenshot({ type: 'png' });
      if (!measure) return { png };
      const measurements = await this.measure(page, spec);
      return { png, measurements };
    } finally {
      await context.close();
    }
  }

  private async measure(page: import('playwright-core').Page, spec: ScreenSpec): Promise<Measurements> {
    const d = this.tokens.device;
    const nodes = (await page.evaluate(MEASURE_SCRIPT)) as MeasuredNode[];
    // Контраст по реальным пикселям: снимок без текста, затем выборка под каждым текстом.
    await page.addStyleTag({ content: '[data-text]{color:transparent!important;text-shadow:none!important}' });
    const bare = await page.screenshot({ type: 'png' });
    // Строковый скрипт превращаем в функцию, чтобы Playwright передал ей аргумент.
    const contrastFn = new Function(`return ${CONTRAST_SCRIPT}`)() as (arg: { b64: string; nodes: MeasuredNode[] }) => Promise<Record<string, { min: number; p10: number }>>;
    const contrasts = await page.evaluate(contrastFn, { b64: bare.toString('base64'), nodes });
    for (const n of nodes) n.contrast = contrasts[n.id] ?? null;
    const hero = nodes.find((n) => n.role === 'hero');
    return {
      width: d.width,
      height: d.height,
      safeTop: d.safeTop,
      safeBottom: d.safeBottom,
      heroZone: spec.heroZone ?? hero?.rect ?? null,
      nodes,
    };
  }
}

// Выполняется в странице. Собирает геометрию, цвета, прозрачность и порядок отрисовки.
const MEASURE_SCRIPT = `(() => {
  const parseRgba = (s) => { const m = s && s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const gradientAlpha = (s) => { if (!s || s === 'none') return 0; const all = [...s.matchAll(/rgba?\\(([^)]+)\\)/g)].map((m) => { const p = m[1].split(','); return p.length > 3 ? parseFloat(p[3]) : 1; }); return all.length ? Math.max(...all) : 1; };
  const els = [...document.querySelectorAll('[data-node]')];
  const hero = document.querySelector('[data-role=hero]');
  return els.map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    let op = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity || '1');
    const bg = parseRgba(cs.backgroundColor);
    const bgAlpha = Math.max(bg ? bg[3] : 0, gradientAlpha(cs.backgroundImage));
    const textEl = el.querySelector(':scope > [data-text], :scope > span > [data-text]');
    const kind = el.dataset.kind;
    const isTextKind = kind === 'text' || kind === 'button' || kind === 'chip';
    const after = hero && hero !== el && !hero.contains(el) && !el.contains(hero) && Boolean(hero.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const inside = hero ? (hero === el || hero.contains(el)) : false;
    // Переполнение: по ширине — scrollWidth; по высоте — низ текстового span ниже блока
    // больше чем на полстроки (scrollHeight врёт при плотном межстрочном интервале).
    let overflow = false;
    if (isTextKind) {
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const span = el.querySelector('[data-text]');
      const sr = span ? span.getBoundingClientRect() : null;
      overflow = el.scrollWidth > el.clientWidth + 1 || Boolean(sr && sr.bottom - r.bottom > lh * 0.5) || Boolean(el.dataset.maxlines && el.scrollHeight > el.clientHeight + lh * 0.5);
    }
    return {
      id: el.dataset.node, kind, role: el.dataset.role || null,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      text: isTextKind && textEl ? textEl.textContent : null,
      fontSize: isTextKind ? parseFloat(cs.fontSize) : null,
      fontWeight: isTextKind ? parseFloat(cs.fontWeight) : null,
      color: isTextKind ? parseRgba(cs.color) : null,
      bgAlpha, effectiveOpacity: op,
      glass: (cs.backdropFilter && cs.backdropFilter !== 'none') || kind === 'glass',
      paintsAfterHero: Boolean(after), isHeroOrInside: inside, overflow,
      inScroll: Boolean(el.parentElement && el.parentElement.closest('[data-scroll]')), contrast: null,
    };
  });
})()`;

const CONTRAST_SCRIPT = `async ({ b64, nodes }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const sx = img.width / window.innerWidth;
  const canvas = new OffscreenCanvas(img.width, img.height); const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const out = {};
  for (const n of nodes) {
    if (!n.text || !n.color || n.rect.w < 2 || n.rect.h < 2) continue;
    const el = document.querySelector('[data-node="' + CSS.escape(n.id) + '"] [data-text]');
    const box = el ? el.getBoundingClientRect() : n.rect;
    const ratios = [];
    for (let i = 0; i < 9; i++) for (let j = 0; j < 3; j++) {
      const x = Math.min(img.width - 1, Math.max(0, Math.round((box.x + (box.width * (i + 0.5)) / 9) * sx)));
      const y = Math.min(img.height - 1, Math.max(0, Math.round((box.y + (box.height * (j + 0.5)) / 3) * sx)));
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      const a = n.color[3] * n.effectiveOpacity;
      const tr = n.color[0] * a + r * (1 - a), tg = n.color[1] * a + g * (1 - a), tb = n.color[2] * a + b * (1 - a);
      const l1 = lum(tr, tg, tb), l2 = lum(r, g, b);
      ratios.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
    }
    ratios.sort((p, q) => p - q);
    out[n.id] = { min: Math.round(ratios[0] * 100) / 100, p10: Math.round(ratios[Math.floor(ratios.length * 0.1)] * 100) / 100 };
  }
  return out;
}`;
