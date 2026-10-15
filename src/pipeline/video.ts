// Понимание видео (TwelveLabs Pegasus через Bedrock): отдельный контур со своей
// оценкой стоимости — модель тарифицирует секунды видео и токены ответа, а в ответе
// не сообщает расход, поэтому резерв и списание считаются по заявленной длине ролика.

import type { BudgetLedger } from '../budget/ledger.ts';
import type { ModelRegistryConfig, VideoProvider } from '../llm/types.ts';

const MAX_BASE64_BYTES = 25 * 1024 * 1024;

export class VideoStudio {
  private provider: VideoProvider;
  private config: ModelRegistryConfig;
  private ledger: BudgetLedger;

  constructor(opts: { provider: VideoProvider; config: ModelRegistryConfig; ledger: BudgetLedger }) {
    this.provider = opts.provider;
    this.config = opts.config;
    this.ledger = opts.ledger;
  }

  /** Стоимость: секунды видео × цена секунды + максимум токенов ответа × цена токена. */
  estimate(seconds: number, maxOutputTokens: number): number {
    const model = this.model();
    const p = model.price!;
    return Math.round((seconds * (p.perSecond ?? 0) + (maxOutputTokens * (p.outputPer1M ?? 0)) / 1e6) * 10_000) / 10_000;
  }

  private model() {
    const key = this.config.video?.analyze;
    const model = this.config.models.find((m) => m.key === key && m.enabled && m.kind === 'video');
    if (!model || !model.price?.perSecond) throw new Error(`Видеомодель ${key ?? '(не задана)'} не настроена в studio/policies/models.json`);
    return model;
  }

  async analyze(req: { initiativeId: string; prompt: string; video: Buffer; seconds: number; maxOutputTokens?: number; autonomous?: boolean }): Promise<{ text: string; costUsd: number; model: string }> {
    if (req.video.length > MAX_BASE64_BYTES) throw new Error('Видео больше 25 МБ: такие ролики передаются через S3 (пока не подключено)');
    if (!(req.seconds > 0)) throw new Error('Укажите длительность ролика в секундах — по ней считается стоимость');
    const model = this.model();
    const maxOutputTokens = req.maxOutputTokens ?? 2048;
    const cost = this.estimate(req.seconds, maxOutputTokens);
    const reservation = await this.ledger.reserve({ initiativeId: req.initiativeId, category: 'video', amountUsd: cost, autonomous: req.autonomous ?? false, model: model.key, role: 'video-motion-art-director' });
    try {
      const res = await this.provider.analyzeVideo({ model, region: model.region ?? this.config.region, prompt: req.prompt, base64: req.video.toString('base64'), maxOutputTokens });
      await this.ledger.settle(reservation.id, cost);
      return { text: res.text, costUsd: cost, model: model.key };
    } catch (err) {
      await this.ledger.release(reservation.id);
      throw err;
    }
  }
}
