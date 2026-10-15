// Векторная графика рендерера: набор иконок и процедурная иллюстрация напитка.
// Иллюстрация — честная заглушка до генерации/съёмки фото: в карточке результата
// это явно помечается как «ассеты-заглушки».

import { createHash } from 'node:crypto';
import type { DrinkVisual } from './spec.ts';

const ICONS: Record<string, string> = {
  home: '<path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  bag: '<path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-4 4.2-6 7.5-6s6.3 2 7.5 6"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10C19.5 15.4 12 20 12 20z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  car: '<path d="M4 15.5 5.6 10a2 2 0 0 1 1.9-1.4h9a2 2 0 0 1 1.9 1.4l1.6 5.5V19h-3v-1.5H7V19H4z"/><circle cx="7.5" cy="15" r="1"/><circle cx="16.5" cy="15" r="1"/>',
  cup: '<path d="M5 8h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 4.5v1.5M11 3.5v2.5M14 4.5v1.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  'arrow-right': '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  star: '<path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z"/>',
  sparkle: '<path d="M12 3.5 13.8 10 20.5 12l-6.7 2-1.8 6.5-1.8-6.5L3.5 12l6.7-2z"/>',
};

export function iconSvg(name: string, size: number, color: string): string {
  const body = ICONS[name] ?? ICONS.sparkle;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function hasIcon(name: string): boolean {
  return name in ICONS;
}

function seeded(scene: string): () => number {
  let state = parseInt(createHash('sha1').update(scene).digest('hex').slice(0, 8), 16) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const VESSELS: Record<DrinkVisual['vessel'], { outline: string; inner: string; top: number; bottom: number; left: number; right: number }> = {
  'tall-glass': { outline: 'M72 58 L168 58 L158 292 Q157 300 149 300 L91 300 Q83 300 82 292 Z', inner: 'M78 64 L162 64 L153 288 Q152 294 146 294 L94 294 Q88 294 87 288 Z', top: 64, bottom: 294, left: 78, right: 162 },
  tumbler: { outline: 'M58 118 L182 118 L174 292 Q173 300 164 300 L76 300 Q67 300 66 292 Z', inner: 'M64 124 L176 124 L169 288 Q168 294 161 294 L79 294 Q72 294 71 288 Z', top: 124, bottom: 294, left: 64, right: 176 },
  cup: { outline: 'M62 150 L178 150 L170 268 Q166 298 134 298 L106 298 Q74 298 70 268 Z', inner: 'M66 156 L174 156 L167 266 Q163 292 133 292 L107 292 Q77 292 73 266 Z', top: 156, bottom: 292, left: 66, right: 174 },
  espresso: { outline: 'M80 200 L160 200 L154 272 Q150 296 128 296 L112 296 Q90 296 86 272 Z', inner: 'M84 206 L156 206 L151 270 Q147 290 127 290 L113 290 Q93 290 89 270 Z', top: 206, bottom: 290, left: 84, right: 156 },
};

/** Иллюстрация напитка: сцена (уникальна по scene), сосуд, жидкость, лёд, пена, блики. */
export function drinkSvg(d: DrinkVisual, uid: string): string {
  const rnd = seeded(d.scene);
  const v = VESSELS[d.vessel] ?? VESSELS['tall-glass'];
  const [c1, c2] = d.sceneColors;
  const [l1, l2] = d.liquid;
  const opaqueVessel = d.vessel === 'cup' || d.vessel === 'espresso';
  const level = v.top + (v.bottom - v.top) * (opaqueVessel ? 0.06 : 0.16);
  const blobs = [0, 1, 2].map((i) => {
    const cx = 40 + rnd() * 160;
    const cy = 40 + rnd() * 200;
    const r = 70 + rnd() * 70;
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${i % 2 ? c2 : c1}" opacity="${(0.55 + rnd() * 0.35).toFixed(2)}"/>`;
  }).join('');
  const ice = d.ice
    ? [0, 1, 2].map((i) => {
        const x = v.left + 14 + i * ((v.right - v.left - 50) / 2) + rnd() * 8;
        const y = level + 6 + rnd() * 30;
        const rot = (rnd() * 40 - 20).toFixed(1);
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="30" height="28" rx="7" transform="rotate(${rot} ${x + 15} ${y + 14})" fill="white" fill-opacity="0.32" stroke="white" stroke-opacity="0.7" stroke-width="1.5"/>`;
      }).join('')
    : '';
  const foam = d.foam ? `<ellipse cx="${(v.left + v.right) / 2}" cy="${level + 6}" rx="${(v.right - v.left) / 2}" ry="12" fill="#f3e3cf"/><ellipse cx="${(v.left + v.right) / 2 - 10}" cy="${level + 4}" rx="18" ry="5" fill="#fff6ea" opacity="0.8"/>` : '';
  const garnish = d.garnish
    ? `<g transform="translate(${v.right - 18} ${v.top - 12})"><circle r="22" fill="${d.garnish}"/><circle r="17" fill="none" stroke="white" stroke-opacity="0.7" stroke-width="2"/><path d="M0 -17V17M-17 0H17M-12 -12 12 12M12 -12 -12 12" stroke="white" stroke-opacity="0.55" stroke-width="1.5"/></g>`
    : '';
  const straw = !opaqueVessel && d.ice ? `<rect x="${v.left + 40}" y="${v.top - 70}" width="9" height="${v.bottom - v.top + 20}" rx="4.5" transform="rotate(12 ${v.left + 44} ${v.top})" fill="${c1}" opacity="0.95"/>` : '';
  const vesselFill = opaqueVessel ? `<path d="${v.outline}" fill="url(#cer-${uid})"/>` : `<path d="${v.outline}" fill="white" fill-opacity="0.14" stroke="white" stroke-opacity="0.75" stroke-width="2.5"/>`;
  const handle = d.vessel === 'cup' ? `<path d="M176 180 Q214 186 205 222 Q198 248 166 246" fill="none" stroke="#e9dfd2" stroke-width="13" stroke-linecap="round"/>` : '';
  const cx = (v.left + v.right) / 2;
  const rx = (v.right - v.left) / 2;
  const liquidLayer = opaqueVessel
    ? `<ellipse cx="${cx}" cy="${v.top}" rx="${rx + 4}" ry="13" fill="#f4ece2"/><ellipse cx="${cx}" cy="${v.top + 1}" rx="${rx - 4}" ry="10" fill="#2b1a12"/><ellipse cx="${cx}" cy="${v.top + 3}" rx="${rx - 9}" ry="7.5" fill="url(#liq-${uid})"/>`
      + (d.foam ? `<path d="M${cx} ${v.top + 8} c-9 -6 -12 -11 -6 -13 c3 -1 5 1 6 3 c1 -2 3 -4 6 -3 c6 2 3 7 -6 13z" fill="#fbf1e4" opacity="0.92"/>` : '')
    : `<g clip-path="url(#clip-${uid})"><rect x="0" y="${level}" width="240" height="${v.bottom - level + 10}" fill="url(#liq-${uid})"/>${foam}${ice}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320" preserveAspectRatio="xMidYMid meet" width="100%" height="100%" role="img" aria-label="${escapeAttr(d.name)}">
<defs>
<linearGradient id="liq-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${l1}"/><stop offset="1" stop-color="${l2}"/></linearGradient>
<linearGradient id="cer-${uid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fffaf3"/><stop offset="0.55" stop-color="#f1e7da"/><stop offset="1" stop-color="#cdbda8"/></linearGradient>
<filter id="blur-${uid}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
<radialGradient id="fade-${uid}" cx="50%" cy="56%" r="50%"><stop offset="0.3" stop-color="white"/><stop offset="0.97" stop-color="black"/></radialGradient>
<mask id="mask-${uid}"><rect width="240" height="320" fill="url(#fade-${uid})"/></mask>
<clipPath id="clip-${uid}"><path d="${v.inner}"/></clipPath>
</defs>
<g mask="url(#mask-${uid})"><g filter="url(#blur-${uid})">${blobs}</g></g>
<ellipse cx="120" cy="304" rx="78" ry="10" fill="black" opacity="0.18"/>
${straw}${vesselFill}${handle}${liquidLayer}
<path d="M${v.left + 10} ${v.top + 20} L${v.left + 16} ${v.bottom - 30}" stroke="white" stroke-opacity="0.5" stroke-width="5" stroke-linecap="round"/>
<path d="M${v.right - 18} ${v.top + 40} L${v.right - 21} ${v.top + 110}" stroke="white" stroke-opacity="0.28" stroke-width="3" stroke-linecap="round"/>
${garnish}
</svg>`;
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
