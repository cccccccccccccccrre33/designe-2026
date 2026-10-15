// Screen Spec — то, что пишут агенты вместо картинки (ADR-0002). Дерево узлов на
// токенах дизайн-системы. Рендерер превращает его в HTML, Chromium — в PNG.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const NODE_KINDS = ['box', 'text', 'button', 'glass', 'chip', 'icon', 'drink', 'image'] as const;
export const NODE_ROLES = ['hero', 'primary-action', 'secondary-action', 'promo', 'nav', 'tab', 'title', 'price', 'label', 'card', 'decor', 'status'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type NodeRole = (typeof NODE_ROLES)[number];

export interface DrinkVisual {
  name: string;
  vessel: 'tall-glass' | 'cup' | 'tumbler' | 'espresso';
  liquid: [string, string];
  ice?: boolean;
  foam?: boolean;
  scene: string;
  sceneColors: [string, string];
  garnish?: string;
}

export interface SpecNode {
  id: string;
  kind: NodeKind;
  role?: NodeRole;
  frame?: { x?: number; y?: number; w?: number; h?: number; right?: number; bottom?: number };
  layout?: {
    dir: 'row' | 'column';
    gap?: number;
    pad?: number | number[];
    align?: 'start' | 'center' | 'end' | 'stretch';
    justify?: 'start' | 'center' | 'end' | 'between';
    scroll?: boolean;
  };
  grow?: boolean;
  fill?: string;
  glass?: string;
  opacity?: number;
  radius?: string;
  stroke?: string;
  shadow?: string;
  text?: string;
  textStyle?: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
  maxLines?: number;
  icon?: string;
  size?: number;
  drink?: DrinkVisual;
  asset?: string;
  fit?: 'cover' | 'contain';
  label?: string;
  children?: SpecNode[];
}

export interface SpecState {
  id: string;
  label: string;
  patches: Array<{ nodeId: string; set: Partial<SpecNode> }>;
}

export interface ScreenSpec {
  id: string;
  screen: string;
  title: string;
  background: string;
  statusBar?: 'light' | 'dark';
  heroZone?: Rect;
  nodes: SpecNode[];
  states?: SpecState[];
  notes?: string;
}

export interface Tokens {
  version: string;
  font: { family: string; file: string };
  color: Record<string, string>;
  gradient: Record<string, string>;
  type: Record<string, { size: number; line: number; weight: number; tracking: number }>;
  radius: Record<string, number>;
  shadow: Record<string, string>;
  glass: Record<string, { fill: string; stroke: string; blur: number }>;
  device: { name: string; width: number; height: number; safeTop: number; safeBottom: number };
}

export function resolveFill(tokens: Tokens, ref: string | undefined): string | undefined {
  if (!ref || ref === 'none') return undefined;
  const [group, name] = ref.split('.', 2);
  if (group === 'color') return tokens.color[name];
  if (group === 'gradient') return tokens.gradient[name];
  return undefined;
}

export function walk(nodes: SpecNode[], fn: (node: SpecNode, parent: SpecNode | null, depth: number) => void, parent: SpecNode | null = null, depth = 0): void {
  for (const node of nodes) {
    fn(node, parent, depth);
    if (node.children) walk(node.children, fn, node, depth + 1);
  }
}

export function findNode(spec: ScreenSpec, id: string): SpecNode | undefined {
  let found: SpecNode | undefined;
  walk(spec.nodes, (n) => { if (n.id === id) found = n; });
  return found;
}

/** Структурная проверка и проверка ссылок на токены. Пустой массив — спецификация корректна. */
export function validateSpec(value: unknown, tokens: Tokens): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') return ['spec: ожидался объект'];
  const spec = value as ScreenSpec;
  if (typeof spec.id !== 'string' || !spec.id) errors.push('spec.id обязателен');
  if (typeof spec.screen !== 'string') errors.push('spec.screen обязателен');
  if (typeof spec.title !== 'string') errors.push('spec.title обязателен');
  if (!resolveFill(tokens, spec.background)) errors.push(`spec.background: неизвестный токен «${spec.background}»`);
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    errors.push('spec.nodes: нужен хотя бы один узел');
    return errors;
  }
  const ids = new Set<string>();
  const tokenRef = (path: string, ref: string | undefined, groups: string[]) => {
    if (ref === undefined || ref === 'none') return;
    const [group, name] = String(ref).split('.', 2);
    const table = (tokens as unknown as Record<string, Record<string, unknown>>)[group];
    if (!groups.includes(group) || !table || table[name] === undefined) errors.push(`${path}: «${ref}» не токен (${groups.join('/')})`);
  };
  walk(spec.nodes, (node, parent) => {
    const path = `node ${node.id ?? '?'}`;
    if (typeof node.id !== 'string' || !node.id) errors.push('узел без id');
    else if (ids.has(node.id)) errors.push(`${path}: повторяющийся id`);
    else ids.add(node.id);
    if (!NODE_KINDS.includes(node.kind)) errors.push(`${path}: неизвестный kind «${node.kind}»`);
    if (node.role && !NODE_ROLES.includes(node.role)) errors.push(`${path}: неизвестная role «${node.role}»`);
    if (!parent && !node.frame) errors.push(`${path}: узлу верхнего уровня нужен frame`);
    if (parent && !parent.layout && !node.frame) errors.push(`${path}: в родителе без layout нужен frame`);
    for (const [k, v] of Object.entries(node.frame ?? {})) {
      if (typeof v !== 'number' || v < -400 || v > 1400) errors.push(`${path}: frame.${k} вне диапазона`);
    }
    tokenRef(`${path}.fill`, node.fill, ['color', 'gradient']);
    tokenRef(`${path}.color`, node.color, ['color']);
    tokenRef(`${path}.stroke`, node.stroke, ['color']);
    tokenRef(`${path}.radius`, node.radius, ['radius']);
    tokenRef(`${path}.shadow`, node.shadow, ['shadow']);
    tokenRef(`${path}.textStyle`, node.textStyle, ['type']);
    if (node.glass !== undefined) tokenRef(`${path}.glass`, node.glass, ['glass']);
    if (node.opacity !== undefined && (typeof node.opacity !== 'number' || node.opacity < 0 || node.opacity > 1)) errors.push(`${path}: opacity 0..1`);
    if (['text', 'button', 'chip'].includes(node.kind)) {
      if (typeof node.text !== 'string' || !node.text.trim()) errors.push(`${path}: нужен text`);
      if (!node.textStyle) errors.push(`${path}: нужен textStyle`);
      if (!node.color) errors.push(`${path}: нужен color`);
    }
    if (node.kind === 'glass' && !node.glass) errors.push(`${path}: glass-узлу нужен токен glass.*`);
    if (node.kind === 'drink') {
      const d = node.drink;
      if (!d || !d.name || !Array.isArray(d.liquid) || !Array.isArray(d.sceneColors) || !d.scene) errors.push(`${path}: drink требует name, liquid[2], scene, sceneColors[2]`);
    }
    if (node.kind === 'icon' && !node.icon) errors.push(`${path}: нужен icon`);
    if (node.kind === 'image' && !node.asset) errors.push(`${path}: нужен asset`);
  });
  for (const state of spec.states ?? []) {
    for (const patch of state.patches ?? []) {
      if (!ids.has(patch.nodeId)) errors.push(`state ${state.id}: узел «${patch.nodeId}» не найден`);
    }
  }
  return errors;
}

/** Применить патчи состояния к копии спецификации. */
export function applyState(spec: ScreenSpec, stateId: string): ScreenSpec {
  const copy = structuredClone(spec);
  const state = copy.states?.find((s) => s.id === stateId);
  if (!state) return copy;
  for (const patch of state.patches) {
    walk(copy.nodes, (n) => {
      if (n.id === patch.nodeId) Object.assign(n, patch.set);
    });
  }
  return copy;
}

/** Компактная справка по формату для промпта автора. */
export function specGuide(tokens: Tokens): string {
  const list = (o: Record<string, unknown>) => Object.keys(o).join(', ');
  return [
    'Формат Screen Spec (JSON). Экран iPhone 393×852 pt, безопасные зоны: сверху 59, снизу 34.',
    'Узел: { id, kind, role?, frame?{x,y,w,h,right,bottom}, layout?{dir,gap,pad,align,justify,scroll}, grow?, fill?, glass?, opacity?, radius?, stroke?, shadow?, text?, textStyle?, color?, align?, maxLines?, icon?, size?, drink?, asset?, label?, children? }',
    `kind: ${NODE_KINDS.join(', ')}. role: ${NODE_ROLES.join(', ')}.`,
    'Узлы верхнего уровня позиционируются абсолютно через frame. Дети узла с layout идут потоком (flex).',
    'Стили только токенами:',
    `  color.*: ${list(tokens.color)}`,
    `  gradient.*: ${list(tokens.gradient)}`,
    `  type.* (textStyle): ${list(tokens.type)}`,
    `  radius.*: ${list(tokens.radius)}; shadow.*: ${list(tokens.shadow)}; glass.* (для kind glass): ${list(tokens.glass)}`,
    'drink — иллюстрация-заглушка напитка до генерации фото: { name, vessel: tall-glass|cup|tumbler|espresso, liquid:[hex,hex], ice?, foam?, scene, sceneColors:[hex,hex], garnish? }. scene уникальна для каждого напитка.',
    'Иконки (icon): home, search, bag, user, heart, plus, minus, car, cup, clock, arrow-right, close, filter, star, sparkle.',
    'heroZone {x,y,w,h} — где напиток. Ничто непрозрачное не перекрывает эту зону. role "primary-action" — одна на экран, в нижней части.',
    'Тексты интерфейса — только на украинском.',
  ].join('\n');
}
