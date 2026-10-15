// Производство изображений: отдельный от текстовых моделей контур со своим
// бюджетом генераций и метаданными воспроизводимости (модель, сид, промпт, права).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BudgetLedger } from '../budget/ledger.ts';
import type { Store } from '../store/store.ts';
import { newId, sha256, type Clock } from '../core/util.ts';
import type { ImageProvider, ImageRequest, ModelRegistryConfig } from '../llm/types.ts';

export interface AssetMeta {
  assetId: string;
  initiativeId: string;
  model: string;
  seed: number;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: string;
  path: string;
  sha256: string;
  costUsd: number;
  rights: 'generated-bedrock';
  createdAt: number;
}

export class ImageStudio {
  private provider: ImageProvider;
  private config: ModelRegistryConfig;
  private ledger: BudgetLedger;
  private store: Store;
  private clock: Clock;
  private dir: string;

  constructor(opts: { provider: ImageProvider; config: ModelRegistryConfig; ledger: BudgetLedger; store: Store; clock: Clock; artifactsDir: string }) {
    this.provider = opts.provider;
    this.config = opts.config;
    this.ledger = opts.ledger;
    this.store = opts.store;
    this.clock = opts.clock;
    this.dir = opts.artifactsDir;
  }

  async generate(req: { initiativeId: string; autonomous: boolean; prompt: string; negativePrompt?: string; aspectRatio: ImageRequest['aspectRatio']; final: boolean; seed?: number }): Promise<AssetMeta & { dataUrl: string }> {
    const key = req.final ? this.config.images.final : this.config.images.search;
    const model = this.config.models.find((m) => m.key === key && m.enabled);
    if (!model || !model.price?.perImage) throw new Error(`Модель изображений ${key} не настроена`);
    const reservation = await this.ledger.reserve({ initiativeId: req.initiativeId, category: 'image', amountUsd: model.price.perImage, autonomous: req.autonomous, model: model.key, role: 'ai-image-production' });
    let image;
    try {
      image = await this.provider.generate({ model, region: model.region ?? this.config.region, prompt: req.prompt, negativePrompt: req.negativePrompt, aspectRatio: req.aspectRatio, seed: req.seed });
    } catch (err) {
      await this.ledger.release(reservation.id);
      throw err;
    }
    await this.ledger.settle(reservation.id, model.price.perImage);
    const bytes = Buffer.from(image.base64, 'base64');
    const assetId = newId('asset', this.clock.now());
    const folder = join(this.dir, req.initiativeId, 'assets');
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${assetId}.png`);
    await writeFile(path, bytes);
    const meta: AssetMeta = {
      assetId,
      initiativeId: req.initiativeId,
      model: model.key,
      seed: image.seed,
      prompt: req.prompt,
      negativePrompt: req.negativePrompt,
      aspectRatio: req.aspectRatio,
      path,
      sha256: sha256(bytes),
      costUsd: model.price.perImage,
      rights: 'generated-bedrock',
      createdAt: this.clock.now(),
    };
    await this.store.put('assets', assetId, meta);
    return { ...meta, dataUrl: `data:image/png;base64,${image.base64}` };
  }
}

/** Ближайшее поддерживаемое соотношение сторон для рамки узла. */
export function nearestAspect(w: number, h: number): ImageRequest['aspectRatio'] {
  const options: Array<[ImageRequest['aspectRatio'], number]> = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 1.5], ['4:5', 0.8], ['5:4', 1.25], ['9:16', 9 / 16], ['16:9', 16 / 9]];
  const r = w / h;
  return options.reduce((best, cur) => (Math.abs(Math.log(cur[1] / r)) < Math.abs(Math.log(best[1] / r)) ? cur : best))[0];
}
