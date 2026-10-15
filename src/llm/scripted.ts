// Сценарный провайдер моделей для демо и сквозных тестов. Отвечает детерминированно
// по маркерам ROLE / TASK_CLASS / OUTPUT в системном промпте. Проверяет механику
// конвейера (маршрутизация, бюджет, журнал, рендер, проверки, выбор, правки,
// утверждение), но НЕ доказывает качество дизайна — это задача живых моделей и eval.

import { ProviderError } from '../core/errors.ts';
import { estimateTokens } from './router.ts';
import { variantA, variantB, variantC } from './fixtures.ts';
import type { ChatRequest, ChatResponse, ImageProvider, ImageRequest, ImageResponse, LlmProvider } from './types.ts';

export interface ScriptHooks {
  /** Вызывается перед ответом; может бросить ProviderError, чтобы сымитировать сбой модели. */
  before?: (req: ChatRequest, meta: { role: string; taskClass: string; output: string }) => void;
}

export class ScriptedProvider implements LlmProvider {
  criteria: string[];
  hooks: ScriptHooks;
  calls: Array<{ model: string; role: string; taskClass: string; output: string }> = [];

  constructor(criteria: string[], hooks: ScriptHooks = {}) {
    this.criteria = criteria;
    this.hooks = hooks;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const meta = {
      role: req.system.match(/^ROLE: (.+)$/m)?.[1]?.trim() ?? '?',
      taskClass: req.system.match(/^TASK_CLASS: (.+)$/m)?.[1]?.trim() ?? '?',
      output: req.system.match(/^OUTPUT: (.+)$/m)?.[1]?.trim() ?? '?',
    };
    this.hooks.before?.(req, meta);
    this.calls.push({ model: req.model.key, ...meta });
    const value = this.answer(meta, req);
    const text = JSON.stringify(value);
    return { text, usage: { inputTokens: estimateTokens(req.system + req.user) + (req.images?.length ?? 0) * 1600, outputTokens: estimateTokens(text) }, stopReason: 'end_turn', latencyMs: 5 };
  }

  private answer(meta: { role: string; output: string }, req: ChatRequest): unknown {
    const user = req.user;
    switch (meta.output) {
      case 'triage': {
        const request = user.match(/Запрос: «([\s\S]*?)»/)?.[1] ?? '';
        const design = /экран|главн|карточк|каталог|корзин|кнопк|дизайн|напит|меню|фото/i.test(request);
        return {
          isDesignTask: design,
          type: 'screen-redesign',
          screen: /главн/i.test(request) ? 'home' : 'catalog',
          title: /главн/i.test(request) ? 'Главный экран: быстрее к нужному напитку' : 'Каталог напитков',
          problem: 'Гость долго ищет нужный напиток на главном экране, хотя чаще всего повторяет привычный заказ.',
          tags: ['motion', 'pickup'],
          priority: 'high',
        };
      }
      case 'position':
        return POSITIONS[meta.role] ?? { stance: 'Поддерживаю фокус на скорости повторного заказа.', proposals: [{ idea: 'Привычный напиток первым', why: 'чаще всего гость повторяет заказ' }], concerns: [], mustHave: [] };
      case 'brief':
        return {
          problem: 'Гость долго ищет нужный напиток на главной.',
          successCriteria: ['Повтор привычного заказа за 1 касание', 'Способ получения выбирается на главной', 'Время готовности видно сразу, интервалом'],
          constraints: ['Оплата только на месте', 'Интерфейс на украинском', 'Без больших промо-баннеров'],
          directions: [
            { id: 'a', name: 'Ваш ранок за один дотик', hypothesis: 'Если главная показывает привычный напиток героем и кнопку повтора, то путь к заказу сократится до одного касания, потому что большинство утренних заказов повторяются.', artIdea: 'Тёплый свет утра вокруг чашки на тёмном эспрессо-фоне', structure: 'Герой-напиток, «інше на ранок», выбор получения, повтор' },
            { id: 'b', name: 'Полиця напоїв', hypothesis: 'Если меню видно сразу, гость быстрее находит новое.', artIdea: 'Светлая витрина', structure: 'Промо, категории, сетка' },
            { id: 'c', name: 'Світле вікно', hypothesis: 'Если главная построена вокруг окна выдачи, водитель быстрее оформляет заказ.', artIdea: 'Светлое окно кофейни', structure: 'Герой, окно выдачи, кнопка' },
          ],
          decisions: ['UX Quality: путь повтора важнее витрины; Creative: глубина светом, а не 3D'],
        };
      case 'screenVariant': {
        const id = user.match(/spec\.id = "([^"]+)"/)?.[1];
        if (id) {
          const dir = id.slice(-1);
          const spec = dir === 'b' ? variantB(id) : dir === 'c' ? variantC(id) : variantA('initial', id);
          return { rationale: `Направление ${dir}: экран построен вокруг гипотезы брифа.`, spec, signaturesUsed: dir === 'a' ? A_SIGNATURES : [] };
        }
        const currentId = user.match(/"id":"([^"]+)"/)?.[1] ?? 'spec';
        const changes = [...user.matchAll(/^(c\d+): \[([^\]]*)\] (.+)$/gm)].map((m) => ({ id: m[1], target: m[2], request: m[3] }));
        if (changes.length) {
          return {
            rationale: '[revised] Нижняя плашка убрана, кнопки стеклянные, напиток крупнее; контраст сохранён.',
            spec: variantA('revised', currentId),
            signaturesUsed: [...A_SIGNATURES, 'PEROV-GLASS-PILL', 'НЕСУЩЕСТВУЮЩИЙ-ПРИЁМ'],
            addressed: changes.map((c) => ({ changeId: c.id, status: 'done', explanation: `выполнено: ${c.request}` })),
          };
        }
        return { rationale: '[refined] Подписи увеличены до 14 pt, статус готовности читается лучше.', spec: variantA('refined', currentId), signaturesUsed: A_SIGNATURES };
      }
      case 'critique': {
        const ids = [...user.matchAll(/^Вариант ([a-z0-9]+) «/gm)].map((m) => m[1]);
        const work = user.match(/### \[WORK\] Обоснования авторов\n([\s\S]*?)(\n### |$)/)?.[1] ?? '';
        return {
          variants: ids.map((id) => {
            const base = work.includes('[revised]') ? 4.4 : work.includes('[refined]') ? 4.2 : id === 'a' ? 3.6 : id === 'b' ? 3.9 : 3.5;
            const jitter = meta.role === 'creative-director' ? 0.1 : meta.role === 'beverage-art-director' ? -0.1 : 0;
            const score = Math.max(1, Math.min(5, base + jitter));
            const scores: Record<string, number> = {};
            for (const c of this.criteria) scores[c] = Math.round(score * 10) / 10;
            const issues = id === 'a' && base < 4
              ? [{ severity: 'major', nodeId: 'eta', issue: 'Статус готовности набран 12 pt — водитель не прочитает', evidence: 'кегль caption 12 pt на тёмном фоне, сценарий «в машине у окна»', fix: 'поднять до type.label 14 pt' }]
              : [];
            return { variantId: id, scores, issues, strengths: id === 'a' ? ['Привычный напиток — герой, повтор в одно касание', 'Глубина светом вокруг чашки без декоративного 3D'] : [] };
          }),
        };
      }
      case 'arbiter':
        return { winner: 'a', reasoning: 'Вариант a решает задачу повтора заказа короче.' };
      case 'feedback': {
        // Текст владельца — самая длинная цитата «…» в задаче (первая — название экрана).
        const text = [...user.matchAll(/«([\s\S]*?)»/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0] ?? '';
        const changes: Array<{ id: string; target: string; request: string; kind: string }> = [];
        if (/плашк/i.test(text)) changes.push({ id: `c${changes.length + 1}`, target: 'bottom-panel', request: 'Убрать большую плашку снизу', kind: 'layout' });
        if (/прозрач/i.test(text)) changes.push({ id: `c${changes.length + 1}`, target: 'pickup, cta', request: 'Сделать кнопки прозрачнее', kind: 'visual' });
        if (/напит\S*\s+\S*\s*(крупн|больш)|(крупн|больш)\S*\s+\S*\s*напит|сам напиток/i.test(text)) changes.push({ id: `c${changes.length + 1}`, target: 'hero', request: 'Сделать напиток крупнее', kind: 'layout' });
        if (!changes.length) changes.push({ id: 'c1', target: 'экран', request: text.slice(0, 200), kind: 'other' });
        const prefs = /не люблю|никогда|всегда/i.test(text) ? [{ statement: 'Без тяжёлых непрозрачных плашек внизу экрана', scope: 'visual', strength: 'soft' }] : [];
        return { intent: 'changes', changes, preferenceCandidates: prefs };
      }
      case 'motionSpec':
        return {
          transitions: [
            { from: 'home', to: 'drink-card', trigger: 'касание героя', sharedElements: ['hero', 'drink-name'], spring: { duration: 0.45, bounce: 0.15 }, choreography: 'чашка растёт на месте, контент карточки появляется после 50% пути' },
            { from: 'home', to: 'order-active', trigger: 'кнопка «Повторити»', sharedElements: ['hero'], spring: { duration: 0.35, bounce: 0 }, choreography: 'кнопка превращается в статус заказа' },
          ],
          microinteractions: [{ element: 'pickup', trigger: 'выбор способа получения', feedback: 'лёгкий тактильный отклик и смена ETA' }],
          reducedMotion: 'Переходы заменяются перекрёстным затуханием 150 мс без масштаба.',
        };
      case 'technicalNote':
        return { question: 'Прогноз готовности', model: 'M/G/c, Монте-Карло (src/science/queueing.ts)', parameters: [{ name: 'sigma', value: 0.25 }], recommendation: 'Показывать интервал P50–P90 в минутах, пересчитывать при изменении очереди.', confidence: 'medium', limits: ['нужна история заказов для калибровки'], sources: ['SRC-DR-ETA'] };
      case 'photoBrief':
        return { subject: 'Флет вайт в керамической чашке', scene: 'ранний свет у окна выдачи', light: 'контровой тёплый', uiZones: 'низ кадра спокойный', prompt: 'flat white in a ceramic cup, warm morning backlight, dark espresso background, soft glow, product photography', negativePrompt: 'text, logo, hands', aspectRatio: '4:5' };
      default:
        throw new ProviderError('bad_request', 400, `Сценарий не знает OUTPUT=${meta.output}`);
    }
  }
}

// Приёмы школ, которые сценарный автор «заявляет» для направления A. В демо есть и
// заведомо несуществующий ID — конвейер обязан его отбросить.
const A_SIGNATURES = ['PEROV-USUAL', 'PEROV-WARM-IMMERSIVE', 'KAL-STATES-COMPLETE', 'DODO-ORDER-TYPE', 'MEK-EMOTION-LAYER'];

const POSITIONS: Record<string, unknown> = {
  'creative-director': { stance: 'Главная должна ощущаться утренним ритуалом: тёплый свет вокруг привычного напитка, глубина светом.', proposals: [{ idea: 'Герой — привычный напиток на тёмном фоне со светом', why: 'характер без декоративного 3D' }], concerns: [{ issue: 'Большая витрина превращает главную в каталог', evidence: 'PREF-002, M-CHARACTER' }], mustHave: ['Напиток крупно и без перекрытий'], references: ['M-CHARACTER', 'SRC-DR-VISION'] },
  'senior-product-designer': { stance: 'Сократить путь: повтор привычного заказа в одно касание, получение выбирается на главной.', proposals: [{ idea: 'Кнопка «Повторити» с ценой', why: 'утренние заказы повторяются' }], concerns: [{ issue: 'Выбор окна/зала спрятан в профиле', evidence: 'сценарий водителя у окна, SRC-DK-V82' }], mustHave: ['Одна основная кнопка в зоне большого пальца'], references: ['M-PROOF'] },
  'beverage-art-director': { stance: 'Каждый напиток в «інше на ранок» — со своей сценой.', proposals: [{ idea: 'Разные сцены для миникарточек', why: 'PREF-003' }], concerns: [], mustHave: ['Свободная зона вокруг чашки'], references: ['M-SERIES', 'M-PHOTO-UI-ZONES'] },
  'ux-quality-reviewer': { stance: 'Статус готовности должен читаться за секунду, интервалом.', proposals: [{ idea: 'ETA интервалом в шапке', why: 'исследование Drinkit о тревожных предупреждениях' }], concerns: [{ issue: 'Мелкий текст статуса', evidence: 'сценарий в машине' }], mustHave: ['Интервал готовности, а не обещание'], references: ['M-HONEST-ETA'] },
  'motion-designer': { stance: 'Герой остаётся тем же объектом при переходе в карточку.', proposals: [{ idea: 'Общий элемент — чашка', why: 'M-CONTINUITY' }], concerns: [], mustHave: ['Вариант для reduced motion'], references: ['M-CONTINUITY', 'M-SPRINGS'] },
};

/** Сценарный генератор изображений: однотонный PNG 1×1 (для тестов контура изображений). */
export class ScriptedImages implements ImageProvider {
  async generate(req: ImageRequest): Promise<ImageResponse> {
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return { base64: png1x1, seed: req.seed ?? 7, format: 'png' };
  }
}
