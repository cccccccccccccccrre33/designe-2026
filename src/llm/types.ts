export type Tier = 'economy' | 'main' | 'vision' | 'premium';

export type TaskClass =
  | 'classify'
  | 'extract'
  | 'dedupe'
  | 'position'
  | 'brief'
  | 'spec'
  | 'critique'
  | 'science'
  | 'arbiter'
  /** Фото-бриф и промпт генерации: смотрит макет экрана, пишет сцену, свет, физику напитка. */
  | 'photo';

export interface ModelEntry {
  key: string;
  modelId: string;
  kind: 'text' | 'image' | 'video';
  family: string;
  tier?: Tier;
  input: Array<'text' | 'image' | 'video'>;
  contextTokens?: number;
  maxOutputTokens?: number;
  price: { inputPer1M?: number; outputPer1M?: number; perImage?: number; perSecond?: number; confidence: 'high' | 'medium' | 'low' } | null;
  /** Поля модели для Converse additionalModelRequestFields (например, reasoning_effort). */
  requestFields?: Record<string, unknown>;
  /** Модель отклоняет параметр temperature (Kimi K3) — не передавать его. */
  noTemperature?: boolean;
  enabled: boolean;
  region?: string;
  lifecycle?: 'active' | 'legacy';
  eol?: string;
  notes?: string;
}

export interface ModelRegistryConfig {
  region: string;
  models: ModelEntry[];
  assignments: Record<TaskClass, string[]>;
  evalThresholds: Partial<Record<TaskClass, number>>;
  breaker: { failures: number; cooldownMs: number };
  retry: { maxAttemptsPerCall: number; retryDelayMs: number };
  images: { search: string; final: string; inpaint?: string };
  video?: { analyze: string; generate?: string };
}

export interface VideoRequest {
  model: ModelEntry;
  region: string;
  prompt: string;
  /** Видео до 25 МБ — base64 в запросе; большее — ссылкой на S3. */
  base64?: string;
  s3?: { uri: string; bucketOwner: string };
  maxOutputTokens?: number;
  temperature?: number;
}

export interface VideoResponse {
  text: string;
  stopReason: string;
}

export interface VideoProvider {
  analyzeVideo(req: VideoRequest): Promise<VideoResponse>;
}

export interface ImagePart {
  format: 'png' | 'jpeg' | 'webp';
  base64: string;
  label?: string;
}

export interface ChatRequest {
  model: ModelEntry;
  region: string;
  system: string;
  user: string;
  images?: ImagePart[];
  maxTokens: number;
  temperature?: number;
  /** Для повторной попытки ремонта JSON: предыдущий ответ ассистента и замечания. */
  repair?: { previous: string; errors: string[] };
}

export interface ChatResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  stopReason?: string;
  latencyMs: number;
}

export interface LlmProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface ImageRequest {
  model: ModelEntry;
  region: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: '1:1' | '2:3' | '3:2' | '4:5' | '5:4' | '9:16' | '16:9';
  seed?: number;
}

export interface ImageResponse {
  base64: string;
  seed: number;
  format: 'png';
}

export interface ImageProvider {
  generate(req: ImageRequest): Promise<ImageResponse>;
}
