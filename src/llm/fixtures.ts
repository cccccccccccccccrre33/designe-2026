// Эталонные Screen Spec главного экрана для демо и тестов. Это НЕ результат работы
// команды на живых моделях — это фикстуры сценарного провайдера, которые проверяют
// механику: рендер, автопроверки, выбор, доработку, правки владельца.

import type { ScreenSpec, SpecNode } from '../render/spec.ts';

const DRINKS = {
  flatWhite: { name: 'Флет вайт', vessel: 'cup' as const, liquid: ['#d8b089', '#8a5a3b'] as [string, string], foam: true, scene: 'ранкова пара над містом', sceneColors: ['#ff7a45', '#5b3b8c'] as [string, string] },
  raf: { name: 'Раф', vessel: 'cup' as const, liquid: ['#efd9bd', '#b98a5e'] as [string, string], foam: true, scene: 'ванільна хмара', sceneColors: ['#f2c6a0', '#8f6bd1'] as [string, string] },
  iceLatte: { name: 'Айс Лате', vessel: 'tall-glass' as const, liquid: ['#e9d6bf', '#8b5e3c'] as [string, string], ice: true, scene: 'холодний ранок на трасі', sceneColors: ['#7ec8e3', '#2c4a7a'] as [string, string] },
  mango: { name: 'Манго-Маракеш', vessel: 'tall-glass' as const, liquid: ['#ffd36b', '#ff8a2a'] as [string, string], ice: true, garnish: '#ffb547', scene: 'пустельний захід сонця', sceneColors: ['#ff9f43', '#d6336c'] as [string, string] },
  currant: { name: 'Соковита Смородина', vessel: 'tall-glass' as const, liquid: ['#b8326b', '#5a1238'] as [string, string], ice: true, garnish: '#3b1030', scene: 'нічний сад', sceneColors: ['#6a2c91', '#1d2b53'] as [string, string] },
  cappuccino: { name: 'Капучино', vessel: 'cup' as const, liquid: ['#e6c9a5', '#7a4b2e'] as [string, string], foam: true, scene: 'теплий ранок у залі', sceneColors: ['#ffb38a', '#c06c84'] as [string, string] },
};

function tabbar(dark: boolean): SpecNode {
  const tab = (id: string, icon: string, label: string, active: boolean): SpecNode => ({
    id, kind: 'icon', role: 'tab', icon, size: 24, label, frame: { w: 64, h: 44 },
    radius: 'radius.pill', ...(active ? { fill: dark ? 'color.white' : 'color.ink', color: dark ? 'color.ink' : 'color.white' } : { color: dark ? 'color.white' : 'color.ink' }),
  });
  return {
    id: 'tabbar', kind: 'glass', role: 'nav', glass: dark ? 'glass.dark' : 'glass.frost', radius: 'radius.pill',
    frame: { x: 16, y: 760, w: 361, h: 56 },
    layout: { dir: 'row', justify: 'between', align: 'center', pad: [4, 12, 4, 12] },
    children: [tab('tab-home', 'home', 'Головна', true), tab('tab-menu', 'cup', 'Меню', false), tab('tab-cart', 'bag', 'Кошик', false), tab('tab-profile', 'user', 'Профіль', false)],
  };
}

function miniCard(id: string, drink: (typeof DRINKS)[keyof typeof DRINKS], textStyle: string): SpecNode {
  return {
    id, kind: 'glass', glass: 'glass.dark', radius: 'radius.m', frame: { w: 148, h: 76 },
    layout: { dir: 'row', align: 'center', gap: 8, pad: [4, 12, 4, 8] },
    children: [
      { id: `${id}-img`, kind: 'drink', frame: { w: 44, h: 64 }, drink },
      { id: `${id}-name`, kind: 'text', text: drink.name, textStyle, color: 'color.white', maxLines: 2, grow: true },
    ],
  };
}

/** Направление A «Ваш ранок за один дотик». refined — после критики, revised — после правок владельца. */
export function variantA(stage: 'initial' | 'refined' | 'revised', id: string): ScreenSpec {
  const small = stage === 'initial' ? 'type.caption' : 'type.label';
  const big = stage === 'revised';
  const hero = big ? { x: 52, y: 108, w: 288, h: 384 } : { x: 76, y: 120, w: 240, h: 320 };
  const titleY = big ? 500 : 448;
  const carouselY = big ? 564 : 520;
  const nodes: SpecNode[] = [
    {
      id: 'header', kind: 'box', frame: { x: 20, y: 64, w: 353, h: 44 }, layout: { dir: 'row', justify: 'between', align: 'center' },
      children: [
        {
          id: 'header-text', kind: 'box', grow: true, layout: { dir: 'column', gap: 0 },
          children: [
            { id: 'greeting', kind: 'text', text: 'Доброго ранку', textStyle: 'type.headline', color: 'color.white' },
            { id: 'eta', kind: 'text', role: 'status', text: 'Бариста вільний · готово за 4–6 хв', textStyle: small, color: 'color.white-80' },
          ],
        },
        { id: 'profile', kind: 'glass', glass: 'glass.light', role: 'secondary-action', radius: 'radius.pill', frame: { w: 44, h: 44 }, label: 'Профіль', layout: { dir: 'row', align: 'center', justify: 'center' }, children: [{ id: 'profile-icon', kind: 'icon', icon: 'user', size: 22, color: 'color.white' }] },
      ],
    },
    { id: 'hero', kind: 'drink', role: 'hero', frame: hero, drink: DRINKS.flatWhite, label: 'Флет вайт' },
    {
      id: 'title-block', kind: 'box', frame: { x: 20, y: titleY, w: 353, h: 60 }, layout: { dir: 'column', gap: 4 },
      children: [
        { id: 'drink-name', kind: 'text', role: 'title', text: 'Флет вайт · 250 мл', textStyle: 'type.title', color: 'color.white' },
        { id: 'drink-sub', kind: 'text', text: 'Як минулого разу: вівсяне молоко', textStyle: 'type.body', color: 'color.white-80' },
      ],
    },
    {
      id: 'carousel', kind: 'box', frame: { x: 20, y: carouselY, w: 373, h: big ? 72 : 80 }, layout: { dir: 'row', gap: 12, align: 'center', scroll: true },
      children: [miniCard('more-raf', DRINKS.raf, small), miniCard('more-ice', DRINKS.iceLatte, small), miniCard('more-mango', DRINKS.mango, small)],
    },
  ];
  const chips = (glass: boolean): SpecNode => ({
    id: 'pickup', kind: 'box', layout: { dir: 'row', gap: 8 }, ...(glass ? { frame: { x: 20, y: 648, w: 353, h: 44 } } : {}),
    children: [
      glass
        ? { id: 'pickup-window', kind: 'chip', icon: 'car', size: 18, text: 'У вікні авто', textStyle: 'type.label', color: 'color.ink', fill: 'color.white', radius: 'radius.pill' }
        : { id: 'pickup-window', kind: 'chip', icon: 'car', size: 18, text: 'У вікні авто', textStyle: 'type.label', color: 'color.white', fill: 'color.ink', radius: 'radius.pill' },
      glass
        ? { id: 'pickup-hall', kind: 'chip', icon: 'cup', size: 18, text: 'У залі', textStyle: 'type.label', color: 'color.white', glass: 'glass.light', radius: 'radius.pill' }
        : { id: 'pickup-hall', kind: 'chip', icon: 'cup', size: 18, text: 'У залі', textStyle: 'type.label', color: 'color.ink', fill: 'color.white', stroke: 'color.line', radius: 'radius.pill' },
    ],
  });
  if (stage === 'revised') {
    // Правки владельца: без нижней плашки, прозрачные кнопки, напиток крупнее.
    nodes.push(chips(true));
    nodes.push({ id: 'cta', kind: 'button', role: 'primary-action', text: 'Повторити · 85 ₴', icon: 'arrow-right', size: 20, textStyle: 'type.button', color: 'color.white', glass: 'glass.light', radius: 'radius.l', frame: { x: 20, y: 700, w: 353, h: 48 } });
  } else {
    nodes.push({
      id: 'bottom-panel', kind: 'box', role: 'card', fill: 'color.paper', radius: 'radius.xl', shadow: 'shadow.float',
      frame: { x: 12, y: 612, w: 369, h: 144 }, layout: { dir: 'column', gap: 12, pad: [16, 16, 16, 16] },
      children: [chips(false), { id: 'cta', kind: 'button', role: 'primary-action', text: 'Повторити · 85 ₴', textStyle: 'type.button', color: 'color.ink', fill: 'color.accent', radius: 'radius.l', frame: { w: 337, h: 56 } }],
    });
  }
  nodes.push(tabbar(true));
  return {
    id, screen: 'home', title: 'Ваш ранок за один дотик', background: 'gradient.dusk', statusBar: 'light', heroZone: hero, nodes,
    states: [{ id: 'hall', label: 'Обрано «У залі»', patches: [{ nodeId: 'eta', set: { text: 'Бариста вільний · у залі за 3–5 хв' } }] }],
  };
}

/** Направление B «Полиця напоїв»: каталог первым экраном. Содержит промо-баннер больше 25% экрана. */
export function variantB(id: string): ScreenSpec {
  const card = (cid: string, drink: (typeof DRINKS)[keyof typeof DRINKS], price: string): SpecNode => ({
    id: cid, kind: 'box', fill: 'color.white', radius: 'radius.l', shadow: 'shadow.soft', frame: { w: 172, h: 150 }, layout: { dir: 'column', pad: [8, 12, 10, 12], gap: 2 },
    children: [
      { id: `${cid}-img`, kind: 'drink', frame: { w: 148, h: 92 }, drink },
      { id: `${cid}-name`, kind: 'text', text: drink.name, textStyle: 'type.label', color: 'color.ink', maxLines: 1 },
      { id: `${cid}-price`, kind: 'text', role: 'price', text: price, textStyle: 'type.label', color: 'color.muted' },
    ],
  });
  return {
    id, screen: 'home', title: 'Полиця напоїв', background: 'gradient.morning', statusBar: 'dark',
    nodes: [
      { id: 'title', kind: 'text', role: 'title', text: 'Меню', textStyle: 'type.title', color: 'color.ink', frame: { x: 20, y: 64, w: 260, h: 32 } },
      { id: 'search', kind: 'icon', role: 'secondary-action', icon: 'search', size: 24, label: 'Пошук', frame: { x: 329, y: 58, w: 44, h: 44 } },
      {
        id: 'promo', kind: 'box', role: 'promo', fill: 'color.accent', radius: 'radius.xl', frame: { x: 16, y: 112, w: 361, h: 248 }, layout: { dir: 'column', justify: 'end', pad: [20, 20, 20, 20] },
        children: [{ id: 'promo-text', kind: 'text', text: 'Осінній дроп: два лате за 150 ₴', textStyle: 'type.title', color: 'color.white' }],
      },
      {
        id: 'cats', kind: 'box', frame: { x: 16, y: 372, w: 377, h: 44 }, layout: { dir: 'row', gap: 8, scroll: true },
        children: [
          { id: 'cat-hot', kind: 'chip', text: 'Гарячі напої', textStyle: 'type.label', color: 'color.white', fill: 'color.ink', radius: 'radius.pill' },
          { id: 'cat-cold', kind: 'chip', text: 'Холодні напої', textStyle: 'type.label', color: 'color.ink', fill: 'color.white', radius: 'radius.pill' },
          { id: 'cat-lemon', kind: 'chip', text: 'Лимонади', textStyle: 'type.label', color: 'color.ink', fill: 'color.white', radius: 'radius.pill' },
        ],
      },
      {
        id: 'grid', kind: 'box', frame: { x: 16, y: 428, w: 361, h: 312 }, layout: { dir: 'column', gap: 12 },
        children: [
          { id: 'row-1', kind: 'box', layout: { dir: 'row', gap: 17 }, children: [card('c-cap', DRINKS.cappuccino, '75 ₴'), card('c-raf', DRINKS.raf, '95 ₴')] },
          { id: 'row-2', kind: 'box', layout: { dir: 'row', gap: 17 }, children: [card('c-mango', DRINKS.mango, '120 ₴'), card('c-currant', DRINKS.currant, '120 ₴')] },
        ],
      },
      tabbar(false),
    ],
  };
}

/** Направление C «Світле вікно»: светлый экран выдачи. Белый текст на оранжевой кнопке не проходит контраст. */
export function variantC(id: string): ScreenSpec {
  const hero = { x: 68, y: 112, w: 256, h: 330 };
  return {
    id, screen: 'home', title: 'Світле вікно', background: 'gradient.morning', statusBar: 'dark', heroZone: hero,
    nodes: [
      { id: 'greeting', kind: 'text', role: 'title', text: 'Кава вже чекає', textStyle: 'type.title', color: 'color.ink', frame: { x: 20, y: 64, w: 353, h: 32 } },
      { id: 'hero', kind: 'drink', role: 'hero', frame: hero, drink: DRINKS.cappuccino, label: 'Капучино' },
      { id: 'name', kind: 'text', text: 'Капучино · 350 мл', textStyle: 'type.headline', color: 'color.ink', frame: { x: 20, y: 456, w: 353, h: 26 } },
      { id: 'window', kind: 'box', fill: 'color.lavender', radius: 'radius.l', frame: { x: 20, y: 500, w: 353, h: 120 }, layout: { dir: 'column', gap: 6, pad: [16, 16, 16, 16] }, children: [
        { id: 'window-title', kind: 'text', text: 'Окно для авто №2', textStyle: 'type.headline', color: 'color.ink' },
        { id: 'window-sub', kind: 'text', text: 'Номер авто: АА 1234 ВС · приїзд о 8:40', textStyle: 'type.body', color: 'color.ink-64' },
      ] },
      { id: 'cta', kind: 'button', role: 'primary-action', text: 'Замовити · 75 ₴', textStyle: 'type.button', color: 'color.accent-ink', fill: 'color.accent', radius: 'radius.l', frame: { x: 20, y: 640, w: 353, h: 56 } },
      tabbar(false),
    ],
  };
}
