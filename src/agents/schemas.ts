// Схемы ответов агентов. Всё, что возвращает модель, проверяется кодом.

import type { Schema } from '../core/schema.ts';

const str = (description?: string, maxLength?: number): Schema => ({ type: 'string', description, maxLength });
const strList = (description?: string, minItems?: number, maxItems?: number): Schema => ({ type: 'array', items: { type: 'string' }, description, minItems, maxItems });

export const INITIATIVE_TYPES = ['screen-redesign', 'new-screen', 'drink-visuals', 'motion-transition'];

export const triageSchema: Schema = {
  type: 'object',
  required: ['isDesignTask', 'type', 'screen', 'title', 'problem', 'tags', 'priority'],
  properties: {
    isDesignTask: { type: 'boolean', description: 'false — если это не задача студии (вопрос, болтовня, просьба о коде/выпуске)' },
    type: { type: 'string', enum: INITIATIVE_TYPES },
    screen: str('экран: home, catalog, drink-card, customizer, cart, order-active, pickup, profile, history, favorites, lab, onboarding'),
    title: str('короткое название для владельца, по-русски', 80),
    problem: str('проблема пользователя одной фразой'),
    tags: strList('теги: motion, physics, waiting, glass, pickup, photo, copy'),
    priority: { type: 'string', enum: ['high', 'normal', 'low'] },
  },
};

export const positionSchema: Schema = {
  type: 'object',
  required: ['stance', 'proposals', 'concerns', 'mustHave'],
  properties: {
    stance: str('позиция в 1–2 предложениях'),
    proposals: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['idea', 'why'], properties: { idea: str(), why: str() } } },
    concerns: { type: 'array', maxItems: 4, items: { type: 'object', required: ['issue', 'evidence'], properties: { issue: str(), evidence: str('на что опирается: проверка, источник с тиром, сценарий') } } },
    mustHave: strList('обязательные требования к решению', 0, 5),
    references: strList('ID источников или карточек методов', 0, 6),
  },
};

export const briefSchema: Schema = {
  type: 'object',
  required: ['problem', 'successCriteria', 'constraints', 'directions'],
  properties: {
    problem: str(),
    successCriteria: strList('измеримые или проверяемые за 10 секунд', 2, 6),
    constraints: strList(),
    directions: {
      type: 'array', minItems: 2, maxItems: 3,
      items: {
        type: 'object', required: ['id', 'name', 'hypothesis', 'artIdea', 'structure'],
        properties: { id: str('a, b, c'), name: str(), hypothesis: str('если … то … потому что …'), artIdea: str(), structure: str(), risks: strList() },
      },
    },
    decisions: strList('как разрешены споры из позиций'),
  },
};

export const changeStatusSchema: Schema = {
  type: 'array',
  items: { type: 'object', required: ['changeId', 'status', 'explanation'], properties: { changeId: str(), status: { type: 'string', enum: ['done', 'partially', 'declined'] }, explanation: str() } },
};

export const screenVariantSchema: Schema = {
  type: 'object',
  required: ['rationale', 'spec'],
  properties: {
    rationale: str('почему это решает проблему'),
    spec: { type: 'any', description: 'Screen Spec по формату ниже' },
    signaturesUsed: strList('ID приёмов твоей школы, реально применённых в экране', 0, 8),
    addressed: changeStatusSchema,
  },
};

export const photoBriefSchema: Schema = {
  type: 'object',
  required: ['subject', 'scene', 'light', 'uiZones', 'prompt', 'aspectRatio'],
  properties: {
    subject: str(),
    scene: str('уникальная для напитка'),
    light: str(),
    angle: str(),
    palette: strList(),
    props: strList(),
    uiZones: str('где на кадре интерфейс и что там должно быть спокойным'),
    avoid: strList(),
    prompt: str('промпт генератора на английском'),
    negativePrompt: str(),
    aspectRatio: { type: 'string', enum: ['1:1', '2:3', '3:2', '4:5', '5:4', '9:16', '16:9'] },
  },
};

export const motionSpecSchema: Schema = {
  type: 'object',
  required: ['transitions', 'reducedMotion'],
  properties: {
    transitions: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object', required: ['from', 'to', 'trigger', 'spring'],
        properties: {
          from: str(), to: str(), trigger: str(), sharedElements: strList(),
          spring: { type: 'object', required: ['duration', 'bounce'], properties: { duration: { type: 'number', minimum: 0.1, maximum: 2 }, bounce: { type: 'number', minimum: -0.5, maximum: 0.6 } } },
          choreography: str(),
        },
      },
    },
    microinteractions: { type: 'array', items: { type: 'object', required: ['element', 'trigger', 'feedback'], properties: { element: str(), trigger: str(), feedback: str() } } },
    reducedMotion: str(),
  },
};

export function critiqueSchema(criteria: string[]): Schema {
  const scores: Record<string, Schema> = {};
  for (const c of criteria) scores[c] = { type: 'number', minimum: 1, maximum: 5 };
  return {
    type: 'object',
    required: ['variants'],
    properties: {
      variants: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', required: ['variantId', 'scores', 'issues'],
          properties: {
            variantId: str(),
            scores: { type: 'object', required: criteria, properties: scores },
            issues: {
              type: 'array', maxItems: 8,
              items: { type: 'object', required: ['severity', 'issue', 'evidence', 'fix'], properties: { severity: { type: 'string', enum: ['blocking', 'major', 'minor'] }, nodeId: str(), issue: str(), evidence: str(), fix: str() } },
            },
            veto: { type: 'object', required: ['active'], properties: { active: { type: 'boolean' }, reason: str(), evidence: str() } },
            strengths: strList(),
          },
        },
      },
    },
  };
}

export const arbiterSchema: Schema = {
  type: 'object',
  required: ['winner', 'reasoning'],
  properties: { winner: str(), reasoning: str(), mergeIdeas: strList() },
};

export const feedbackSchema: Schema = {
  type: 'object',
  required: ['intent', 'changes', 'preferenceCandidates'],
  properties: {
    intent: { type: 'string', enum: ['changes', 'approve', 'reject', 'question'] },
    changes: {
      type: 'array', maxItems: 12,
      items: { type: 'object', required: ['id', 'target', 'request'], properties: { id: str('c1, c2…'), target: str('какой элемент'), request: str('что сделать, своими словами владельца'), kind: { type: 'string', enum: ['layout', 'visual', 'copy', 'motion', 'content', 'other'] } } },
    },
    preferenceCandidates: {
      type: 'array', maxItems: 5,
      items: { type: 'object', required: ['statement', 'scope', 'strength'], properties: { statement: str('общее правило на будущее, а не правка этого экрана'), scope: str(), strength: { type: 'string', enum: ['hard', 'soft'] } } },
    },
  },
};

export const APP_SCREENS = ['home', 'catalog', 'drink-card', 'customizer', 'cart', 'order-active', 'pickup', 'profile', 'history', 'favorites', 'lab', 'onboarding'];

/** Концепция приложения целиком: цель, визуальный язык, карта экранов (директор студии по позициям старших). */
export const projectConceptSchema: Schema = {
  type: 'object',
  required: ['title', 'goal', 'principles', 'visual', 'flows', 'screens', 'anchor'],
  properties: {
    title: str('название концепции по-русски', 80),
    goal: str('цель приложения одной-двумя фразами: для кого и что гость должен почувствовать и сделать'),
    principles: strList('3–6 принципов продукта, проверяемых на экране', 3, 6),
    visual: {
      type: 'object', required: ['name', 'idea', 'palette', 'typography', 'motion', 'photo'],
      properties: { name: str('имя визуального направления'), idea: str('художественная идея'), palette: str(), typography: str(), motion: str(), photo: str('как выглядят напитки в кадре') },
    },
    flows: strList('главные сценарии: от открытия до получения у окна', 1, 5),
    screens: {
      type: 'array', minItems: 3, maxItems: 9,
      items: {
        type: 'object', required: ['screen', 'title', 'purpose', 'problem'],
        properties: {
          screen: { type: 'string', enum: APP_SCREENS },
          title: str('название экрана по-русски', 60),
          purpose: str('зачем экран в сценарии'),
          problem: str('проблема гостя, которую экран решает'),
          tags: strList('теги: pickup, payment, motion, photo, waiting'),
        },
      },
    },
    anchor: { type: 'string', enum: APP_SCREENS, description: 'ключевой экран: его делают первым, он задаёт визуальный язык остальным' },
  },
};

/** Подача всего приложения владельцу. */
export const projectPitchSchema: Schema = {
  type: 'object',
  required: ['headline', 'story', 'question'],
  properties: {
    headline: str('заголовок, до 80 знаков', 80),
    story: str('3–5 предложений: что команда сделала, ключевые решения, почему это уровень Drinkit/amo; без лести'),
    question: str('один короткий вопрос владельцу'),
    highlights: { type: 'array', maxItems: 6, items: { type: 'object', required: ['screen', 'note'], properties: { screen: str(), note: str('что сильного на этом экране, одна фраза') } } },
  },
};

/** Правки владельца к приложению целиком: к какому экрану относится каждая. */
export const projectFeedbackSchema: Schema = {
  type: 'object',
  required: ['changes', 'preferenceCandidates'],
  properties: {
    changes: {
      type: 'array', minItems: 1, maxItems: 16,
      items: { type: 'object', required: ['id', 'screen', 'target', 'request'], properties: { id: str('c1, c2…'), screen: str('id экрана из списка или all — ко всем экранам'), target: str('какой элемент'), request: str('что сделать, словами владельца') } },
    },
    preferenceCandidates: {
      type: 'array', maxItems: 5,
      items: { type: 'object', required: ['statement', 'scope', 'strength'], properties: { statement: str(), scope: str(), strength: { type: 'string', enum: ['hard', 'soft'] } } },
    },
  },
};

/** Следующая самостоятельная задача студии (директор студии, автономный режим). */
export const autonomyPlanSchema: Schema = {
  type: 'object',
  required: ['skip', 'title', 'request', 'why'],
  properties: {
    skip: { type: 'boolean', description: 'true — сейчас нет задачи, которая стоит денег владельца' },
    reason: str('почему пропуск'),
    title: str('короткое название по-русски', 80),
    request: str('задача так, как её поставил бы владелец: экран и проблема гостя, 1–3 предложения'),
    why: str('почему именно это сейчас приближает приложение к цели — 1–2 предложения для владельца'),
    references: strList('ID карточек базы знаний, на которые опирается выбор', 0, 4),
  },
};

/** Короткая подача результата владельцу от ведущего (старшая роль в манере своей школы). */
export const pitchSchema: Schema = {
  type: 'object',
  required: ['headline', 'story', 'question'],
  properties: {
    headline: str('заголовок подачи, до 80 знаков', 80),
    story: str('2–3 предложения: что сделали и почему это сильно, своим профессиональным вкусом; без лести и без обещаний'),
    question: str('один короткий вопрос владельцу, на который легко ответить'),
    references: strList('ID карточек базы знаний, которые стоит открыть как референс', 0, 3),
  },
};

/** Заметки изучения публикации практика: только то, что подтверждается цитатой. */
export const studyNotesSchema: Schema = {
  type: 'object',
  required: ['relevant', 'likes', 'dislikes', 'methods'],
  properties: {
    relevant: { type: 'boolean', description: 'false — страница не о работе практика (логин, ошибка, чужой текст)' },
    likes: { type: 'array', maxItems: 6, items: { type: 'object', required: ['text', 'quote'], properties: { text: str('что ценит в работе'), quote: str('дословная цитата со страницы') } } },
    dislikes: { type: 'array', maxItems: 6, items: { type: 'object', required: ['text', 'quote'], properties: { text: str('что отвергает в работе'), quote: str('дословная цитата со страницы') } } },
    methods: { type: 'array', maxItems: 6, items: { type: 'object', required: ['text', 'quote'], properties: { text: str('приём или метод работы'), quote: str('дословная цитата со страницы') } } },
  },
};

export const technicalNoteSchema: Schema = {
  type: 'object',
  required: ['question', 'model', 'recommendation', 'confidence', 'limits'],
  properties: {
    question: str(),
    model: str('модель/метод'),
    parameters: { type: 'array', items: { type: 'object', required: ['name', 'value'], properties: { name: str(), value: { type: 'any' }, unit: str() } } },
    recommendation: str(),
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    limits: strList(),
    sources: strList(),
  },
};
