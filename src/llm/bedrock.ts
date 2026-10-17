// Bedrock Runtime через HTTP с Bedrock API-ключом (bearer). Converse — для текста и
// изображений на входе, InvokeModel — для Stability. Без AWS SDK: в локальном режиме
// ключа достаточно; облачный режим (IAM, SigV4) подключается на этапе 5.
//
// Статус: проверено модульными тестами с подменой HTTP. Живой вызов не выполнялся —
// нет ключа. Команда `npm run check:bedrock` делает минимальный живой запрос.

import { ProviderError } from '../core/errors.ts';
import type { ChatRequest, ChatResponse, ImageProvider, ImageRequest, ImageResponse, LlmProvider, VideoProvider, VideoRequest, VideoResponse } from './types.ts';

type FetchLike = typeof fetch;

export interface BedrockOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  endpoint?: (region: string) => string;
  timeoutMs?: number;
}

export class BedrockRuntime implements LlmProvider, ImageProvider, VideoProvider {
  private apiKey: string;
  private fetchImpl: FetchLike;
  private endpoint: (region: string) => string;
  private timeoutMs: number;

  constructor(opts: BedrockOptions) {
    if (!opts.apiKey) throw new Error('AWS_BEARER_TOKEN_BEDROCK не задан');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = opts.endpoint ?? ((region) => `https://bedrock-runtime.${region}.amazonaws.com`);
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  private async post(region: string, path: string, body: unknown): Promise<unknown> {
    const url = `${this.endpoint(region)}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError('retryable', 0, `Сеть недоступна: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw mapError(res.status, res.headers.get('x-amzn-errortype') ?? '', text);
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError('retryable', res.status, 'Некорректный JSON в ответе Bedrock');
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Изображения перед текстом задания: так рекомендуют Kimi K3 и Claude.
    const content: unknown[] = [];
    for (const img of req.images ?? []) {
      if (img.label) content.push({ text: `Изображение: ${img.label}` });
      content.push({ image: { format: img.format, source: { bytes: img.base64 } } });
    }
    content.push({ text: req.user });
    const messages: unknown[] = [{ role: 'user', content }];
    if (req.repair?.truncated) {
      // Оборванный JSON обратно не отправляем: он съедает бюджет токенов, который нужен на сам ответ.
      content.push({ text: 'ВАЖНО: прошлый ответ оборвался на лимите длины. Верни ТОЛЬКО JSON и уложись в лимит: без блока рассуждений, без необязательных полей, без states и декоративных узлов, короткие тексты. Лучше проще, но целиком.' });
    } else if (req.repair) {
      messages.push({ role: 'assistant', content: [{ text: req.repair.previous.slice(0, 20_000) }] });
      messages.push({
        role: 'user',
        content: [{ text: `Ответ не прошёл проверку схемы:\n- ${req.repair.errors.slice(0, 20).join('\n- ')}\nВерни ТОЛЬКО исправленный JSON целиком, без пояснений.` }],
      });
    }
    const body: Record<string, unknown> = {
      system: [{ text: req.system }],
      messages,
      inferenceConfig: req.model.noTemperature ? { maxTokens: req.maxTokens } : { maxTokens: req.maxTokens, temperature: req.temperature ?? 0.4 },
    };
    if (req.model.requestFields) body.additionalModelRequestFields = req.model.requestFields;
    const started = Date.now();
    const data = (await this.post(req.region, `/model/${encodeURIComponent(req.model.modelId)}/converse`, body)) as ConverseResponse;
    const blocks = data.output?.message?.content ?? [];
    const text = blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
    return {
      text,
      usage: { inputTokens: data.usage?.inputTokens ?? 0, outputTokens: data.usage?.outputTokens ?? 0 },
      stopReason: data.stopReason,
      latencyMs: data.metrics?.latencyMs ?? Date.now() - started,
    };
  }

  async generate(req: ImageRequest): Promise<ImageResponse> {
    const body: Record<string, unknown> = {
      prompt: req.prompt,
      aspect_ratio: req.aspectRatio,
      output_format: 'png',
    };
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
    if (req.seed !== undefined) body.seed = req.seed;
    const data = (await this.post(req.region, `/model/${encodeURIComponent(req.model.modelId)}/invoke`, body)) as StabilityResponse;
    const reason = data.finish_reasons?.[0];
    if (reason) throw new ProviderError('bad_request', 200, `Изображение отфильтровано: ${reason}`);
    const image = data.images?.[0];
    if (!image) throw new ProviderError('retryable', 200, 'Пустой ответ генератора изображений');
    return { base64: image, seed: data.seeds?.[0] ?? req.seed ?? 0, format: 'png' };
  }

  /** TwelveLabs Pegasus 1.5: видео → текст через InvokeModel (Converse не поддерживается). */
  async analyzeVideo(req: VideoRequest): Promise<VideoResponse> {
    if (!req.base64 && !req.s3) throw new ProviderError('bad_request', 0, 'Нужно видео: base64 (до 25 МБ) или ссылка S3');
    const body: Record<string, unknown> = {
      analysis_mode: 'general',
      inputPrompt: req.prompt,
      mediaSource: req.base64 ? { base64String: req.base64 } : { s3Location: req.s3 },
      temperature: req.temperature ?? 0.2,
      maxOutputTokens: Math.max(512, req.maxOutputTokens ?? 2048),
    };
    const data = (await this.post(req.region, `/model/${encodeURIComponent(req.model.modelId)}/invoke`, body)) as { message?: string; stopReason?: string };
    if (typeof data.message !== 'string') throw new ProviderError('retryable', 200, 'Пустой ответ видеомодели');
    return { text: data.message, stopReason: data.stopReason ?? 'stop' };
  }
}

interface ConverseResponse {
  output?: { message?: { content?: Array<{ text?: string }> } };
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
  metrics?: { latencyMs?: number };
}

interface StabilityResponse {
  images?: string[];
  seeds?: number[];
  finish_reasons?: Array<string | null>;
}

export function mapError(status: number, errorType: string, body: string): ProviderError {
  const message = `${status} ${errorType} ${body.slice(0, 300)}`.trim();
  if ([408, 424, 429, 500, 502, 503, 504].includes(status)) return new ProviderError('retryable', status, message);
  if (status === 404) return new ProviderError('unavailable', status, message);
  if (status === 401) return new ProviderError('auth', status, message);
  if (status === 403) {
    // Нет доступа к конкретной модели — это недоступность модели, а не проблема ключа.
    return /model|access to the model|not available for this account/i.test(body) ? new ProviderError('unavailable', status, message) : new ProviderError('auth', status, message);
  }
  return new ProviderError('bad_request', status, message);
}
