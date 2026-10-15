// Screen Spec → HTML/CSS. Чистая функция: одинаковая спецификация даёт одинаковый HTML.
// Каждый узел получает data-атрибуты, по которым рендерер измеряет геометрию и стили.

import { drinkSvg, escapeAttr, escapeHtml, iconSvg } from './art.ts';
import { resolveFill, type ScreenSpec, type SpecNode, type Tokens } from './spec.ts';

export interface HtmlOptions {
  fontDataUrl?: string;
  assets?: Record<string, string>;
}

const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', between: 'space-between' };

export function renderHtml(spec: ScreenSpec, tokens: Tokens, opts: HtmlOptions = {}): string {
  const d = tokens.device;
  const statusInk = spec.statusBar === 'light' ? '#ffffff' : tokens.color.ink;
  const font = opts.fontDataUrl
    ? `@font-face{font-family:'${tokens.font.family}';src:url(${opts.fontDataUrl}) format('truetype');font-weight:200 800;font-display:block}`
    : '';
  const body = spec.nodes.map((n) => nodeHtml(n, tokens, opts, false)).join('');
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><style>
${font}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${d.width}px;height:${d.height}px;background:#000;-webkit-font-smoothing:antialiased}
#screen{position:relative;width:${d.width}px;height:${d.height}px;overflow:hidden;background:${resolveFill(tokens, spec.background) ?? tokens.color.paper};font-family:'${tokens.font.family}',system-ui,sans-serif;color:${tokens.color.ink}}
[data-node]{min-width:0}
[data-kind=drink] svg,[data-kind=image] img{display:block;width:100%;height:100%}
[data-scroll]{overflow:hidden}
.chrome{position:absolute;pointer-events:none}
</style></head><body><div id="screen" data-screen="${escapeAttr(spec.screen)}">${body}
<div class="chrome" data-chrome="status" style="left:0;top:0;width:${d.width}px;height:54px;color:${statusInk};font:600 17px/22px '${tokens.font.family}',sans-serif">
<span style="position:absolute;left:44px;top:17px">9:41</span>
<span style="position:absolute;left:${d.width / 2 - 62}px;top:11px;width:124px;height:36px;border-radius:20px;background:#000"></span>
<svg style="position:absolute;right:30px;top:19px" width="78" height="14" viewBox="0 0 78 14" fill="${statusInk}"><rect x="0" y="8" width="3.5" height="5" rx="1"/><rect x="5.5" y="5.5" width="3.5" height="7.5" rx="1"/><rect x="11" y="3" width="3.5" height="10" rx="1"/><rect x="16.5" y="0.5" width="3.5" height="12.5" rx="1"/><path d="M31 4.2a9 9 0 0 1 12 0l-1.4 1.5a7 7 0 0 0-9.2 0zM33.6 7a5 5 0 0 1 6.8 0L37 10.5z"/><rect x="50" y="1" width="24" height="12" rx="3.5" fill="none" stroke="${statusInk}" stroke-opacity="0.45"/><rect x="52" y="3" width="18" height="8" rx="2"/><rect x="75.5" y="4.5" width="1.8" height="5" rx="0.9" fill-opacity="0.45"/></svg>
</div>
<div class="chrome" data-chrome="home" style="left:${d.width / 2 - 67}px;bottom:8px;width:134px;height:5px;border-radius:3px;background:${statusInk};opacity:0.85"></div>
</div></body></html>`;
}

function nodeHtml(node: SpecNode, tokens: Tokens, opts: HtmlOptions, inFlow: boolean): string {
  const style: string[] = [];
  const f = node.frame ?? {};
  if (inFlow && !node.frame) {
    style.push('position:relative');
  } else if (inFlow && node.frame) {
    // Ребёнок flex-контейнера с явными размерами.
    style.push('position:relative', 'flex-shrink:0');
    if (f.w !== undefined) style.push(`width:${f.w}px`);
    if (f.h !== undefined) style.push(`height:${f.h}px`);
  } else {
    style.push('position:absolute');
    if (f.x !== undefined) style.push(`left:${f.x}px`);
    if (f.y !== undefined) style.push(`top:${f.y}px`);
    if (f.right !== undefined) style.push(`right:${f.right}px`);
    if (f.bottom !== undefined) style.push(`bottom:${f.bottom}px`);
    if (f.w !== undefined) style.push(`width:${f.w}px`);
    if (f.h !== undefined) style.push(`height:${f.h}px`);
  }
  if (node.grow) style.push('flex:1 1 0');
  if (node.layout) {
    const l = node.layout;
    style.push('display:flex', `flex-direction:${l.dir}`);
    if (l.gap !== undefined) style.push(`gap:${l.gap}px`);
    if (l.pad !== undefined) style.push(`padding:${Array.isArray(l.pad) ? l.pad.map((p) => `${p}px`).join(' ') : `${l.pad}px`}`);
    if (l.align) style.push(`align-items:${ALIGN[l.align]}`);
    if (l.justify) style.push(`justify-content:${ALIGN[l.justify]}`);
  }
  const fill = resolveFill(tokens, node.fill);
  if (fill) style.push(`background:${fill}`);
  if (node.glass) {
    const g = tokens.glass[node.glass.split('.')[1]];
    if (g) style.push(`background:${g.fill}`, `backdrop-filter:blur(${g.blur}px) saturate(1.5)`, `-webkit-backdrop-filter:blur(${g.blur}px) saturate(1.5)`, `border:1px solid ${g.stroke}`);
  }
  if (node.radius) style.push(`border-radius:${tokens.radius[node.radius.split('.')[1]] ?? 0}px`);
  if (node.stroke) style.push(`border:1px solid ${tokens.color[node.stroke.split('.')[1]]}`);
  if (node.shadow) style.push(`box-shadow:${tokens.shadow[node.shadow.split('.')[1]]}`);
  if (node.opacity !== undefined) style.push(`opacity:${node.opacity}`);
  if (node.radius && (node.kind === 'drink' || node.kind === 'image' || node.layout?.scroll)) style.push('overflow:hidden');

  let inner = '';
  const isText = node.kind === 'text' || node.kind === 'button' || node.kind === 'chip';
  if (isText) {
    const t = tokens.type[(node.textStyle ?? 'type.body').split('.')[1]] ?? tokens.type.body;
    const color = tokens.color[(node.color ?? 'color.ink').split('.')[1]] ?? tokens.color.ink;
    style.push(`font-size:${t.size}px`, `line-height:${t.line}px`, `font-weight:${t.weight}`, `letter-spacing:${t.tracking}px`, `color:${color}`);
    if (node.align) style.push(`text-align:${node.align}`);
    if (node.kind !== 'text') {
      style.push('display:flex', 'align-items:center', 'justify-content:center', 'white-space:nowrap');
      if (!node.layout?.pad) style.push(node.kind === 'chip' ? 'padding:0 14px' : 'padding:0 20px');
      if (node.kind === 'chip' && !node.frame?.h) style.push('height:44px');
    }
    if (node.maxLines) style.push('display:-webkit-box', `-webkit-line-clamp:${node.maxLines}`, '-webkit-box-orient:vertical', 'overflow:hidden');
    const icon = node.icon ? iconSvg(node.icon, node.size ?? 20, color) : '';
    inner = icon ? `<span style="display:inline-flex;gap:8px;align-items:center">${icon}<span data-text="1">${escapeHtml(node.text ?? '')}</span></span>` : `<span data-text="1">${escapeHtml(node.text ?? '')}</span>`;
  } else if (node.kind === 'icon') {
    const color = tokens.color[(node.color ?? 'color.ink').split('.')[1]] ?? tokens.color.ink;
    style.push('display:flex', 'align-items:center', 'justify-content:center');
    inner = iconSvg(node.icon ?? 'sparkle', node.size ?? 24, color);
  } else if (node.kind === 'drink' && node.drink) {
    inner = drinkSvg(node.drink, node.id.replace(/[^a-zA-Z0-9]/g, ''));
  } else if (node.kind === 'image' && node.asset) {
    const src = opts.assets?.[node.asset];
    inner = src ? `<img src="${src}" alt="${escapeAttr(node.label ?? '')}" style="object-fit:${node.fit ?? 'cover'}">` : '';
  }
  const children = (node.children ?? []).map((c) => nodeHtml(c, tokens, opts, Boolean(node.layout))).join('');
  const attrs = [
    `data-node="${escapeAttr(node.id)}"`,
    `data-kind="${node.kind}"`,
    node.role ? `data-role="${node.role}"` : '',
    node.layout?.scroll ? 'data-scroll="1"' : '',
    node.label ? `aria-label="${escapeAttr(node.label)}"` : '',
    node.maxLines ? `data-maxlines="${node.maxLines}"` : '',
  ].filter(Boolean).join(' ');
  return `<div ${attrs} style="${style.join(';')}">${inner}${children}</div>`;
}
