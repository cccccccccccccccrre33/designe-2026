# Факты об AWS, на которые опирается архитектура

Сверено 15.10.2026. Всё, что помечено «проверить», нужно подтвердить в консоли
конкретного аккаунта и региона перед развёртыванием. Цены — ориентиры для
бюджетирования, а не обязательства; система считает реальные токены из ответа
API и сверяется с Cost Explorer.

## AgentCore

| Факт | Дата | Источник |
|---|---|---|
| AgentCore GA (Runtime, Memory, Gateway, Identity, Observability, Browser, Code Interpreter) | 13.10.2025 | [What's New](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-bedrock-agentcore-available) |
| Policy GA | 03.2026 | [Release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html) |
| Evaluations GA; с 09.2026 поддерживает TypeScript-версии Strands, LangGraph, OpenAI Agents, Vercel AI SDK | 31.03.2026 / 09.2026 | [What's New](https://aws.amazon.com/about-aws/whats-new/2026/03/agentcore-evaluations-generally-available), release notes |
| Runtime: Node.js direct code deployment (zip без контейнера) | 04.2026 | release notes |
| Harness GA (агент без собственного кода оркестрации), интеграция со Step Functions, включая шаги human approval | 07.2026 | release notes |
| Managed Knowledge Base в AgentCore GA (S3, SharePoint, Confluence, Drive, OneDrive, Web Crawler; текст, изображения, видео) | 07.2026 | release notes |
| Memory: эпизодическая стратегия (12.2025), фильтрация по метаданным (04.2026), прямая запись в долговременную память и JSON-пейлоады (08.2026), TTL записей (10.2026) | — | release notes |
| Gateway: Runtime как цель, HTTP passthrough, лимиты запросов, Web Search Tool GA | 07–08.2026 | release notes |
| Policy поддерживает Bedrock Guardrails на уровне Gateway | 07.2026 | release notes |

## Bedrock

| Факт | Источник |
|---|---|
| Две конечные точки: `bedrock-runtime` (InvokeModel, Converse, Chat Completions, Responses, Messages; рекомендуется) и `bedrock-mantle` (OpenAI-совместимая + Messages) | [Endpoint availability](https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html) |
| В каталоге (по таблице конечных точек): GLM 4.7 / 4.7 Flash / 5 / 5.3, MiniMax M2 / M2.1 / M2.5, Kimi K2.5 / K2 Thinking / K3, DeepSeek V3.1 / V3.2 / R1, Nemotron Nano 3 30B, Nemotron 3 Super 120B, Ministral 3 8B / 14B, gpt-oss-20b / 120b, Nova Micro / Lite / Pro / 2 Lite, Qwen3 VL 235B, Claude Haiku 4.5 / Haiku 5.5 / Sonnet 4.6 / Sonnet 5 / Sonnet 5.5 / Opus 4.x–5.5 и др. | то же |
| Наличие в таблице не означает наличие во всех регионах — проверять доступность модели в регионе | то же |
| Stable Image Core и Ultra доступны только в us-west-2 (in-region); Inpaint — через us.-профиль | [Core](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-core-1-0.html), [Ultra](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-ultra-1-0.html), [Inpaint](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-inpaint.html) |
| MiniMax M2.5: контекст 196K, выход до 8K токенов; Kimi K2.5: изображения до 3 МБ, выход 16K; GLM 4.7 Flash — статус Legacy, EOL 30.03.2027; Claude Haiku 5.5 вышел 07.10.2026, только через us./global.-профили | карточки моделей ([MiniMax](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html), [Kimi](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html), [GLM Flash](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7-flash.html), [Haiku 5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html)) |
| Bedrock API-ключи (bearer, `AWS_BEARER_TOKEN_BEDROCK`) работают только для Bedrock/Bedrock Runtime; долгосрочный ключ — для разработки, в продакшене — IAM-роли | [API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html) |
| Bedrock Agents (classic) — в режиме поддержки с 07.2026 | [Forbes, 24.07.2026](https://www.forbes.com/sites/janakirammsv/2026/07/24/aws-kills-the-ai-services-it-launched-just-two-years-ago/) |
| Nova Canvas: Legacy 30.03.2026, EOL 30.09.2026 (вызовы после EOL падают) | [Model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html) |
| Stability в Bedrock: Stable Image Ultra 1.0, Core 1.0, SD 3.5 Large; сервисы Inpaint, Outpaint, Erase Object, Search and Replace, Search and Recolor, Remove Background, Control Sketch/Structure, Style Guide/Transfer, Conservative/Creative/Fast Upscale | [Endpoint availability](https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html), [Image Services](https://aws.amazon.com/about-aws/whats-new/2025/09/stability-ai-image-services-generally-available-amazon-bedrock) |

## Ориентировочные цены (USD, on-demand) — проверить

| Модель | Вход / 1M | Выход / 1M | Уверенность |
|---|---|---|---|
| GLM 4.7 Flash | 0.07 | 0.40 | средняя (AWS Builder cheat sheet) |
| MiniMax M2.5 | 0.30 | 1.20 | высокая (страница цен AWS через поиск) |
| GLM 4.7 | 0.60 | 2.20 | средняя |
| Kimi K2.5 | 0.60 | 3.00 | высокая |
| DeepSeek V3.2 | 0.62 | 1.85 | низкая (сторонний источник) |
| Nova 2 Lite | 0.30 | 2.50 | средняя |
| Claude Haiku 4.5 | 1.00 | 5.00 | высокая |
| Claude Sonnet 4.6 | 3.00 | 15.00 | высокая |
| Claude Haiku 5.5 / Sonnet 5.5 | — | — | **не найдено** — маршрутизатор не вызывает модель без цены (`price: null` в `studio/policies/models.json`) |
| Stable Image Core | ~0.04 / изображение | | низкая |
| Stable Image Ultra | ~0.08–0.14 / изображение | | низкая |

Batch inference — около −50%; Flex-уровень — около −50%, Priority — +75% (по
странице цен MiniMax, проверить для других моделей).
