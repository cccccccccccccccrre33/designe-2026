# Облачное развёртывание (этап 5) — план, не развёрнуто

Ничего из этого каталога не развёрнуто в AWS. Нужен IAM-доступ (см. `docs/SETUP.md`).

## Ресурсы (us-west-2)

| Ресурс | Назначение | Соответствие в коде |
|---|---|---|
| Step Functions Standard `dk-initiative` | Конвейер инициативы, ожидание владельца через `waitForTaskToken` | `src/pipeline/studio.ts`, черновик `stepfunctions/initiative.asl.json` |
| Lambda `dk-step` (Node.js 24) | Шаги агентов: вызов `ModelRouter` | `src/pipeline/studio.ts` (этапы), `src/llm/router.ts` |
| Lambda-контейнер `dk-render` (Chromium) или AgentCore Browser | Рендер Screen Spec, автопроверки | `src/render/renderer.ts`, `src/review/checks.ts` |
| Lambda Function URL `dk-telegram` | Вебхук Telegram с проверкой секрета | `src/telegram/bot.ts::handleWebhook` |
| DynamoDB `dk-state` (on-demand) | Инициативы, журнал шагов, ledger, outbox, сессии | интерфейс `src/store/store.ts` (замена `FileStore`) |
| S3 `dk-artifacts` | Рендеры, ассеты, видео | `artifactsDir` |
| Secrets Manager | `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `src/config/load.ts::env` |
| EventBridge Scheduler | Еженедельный аудит, напоминания (без авто-одобрения) | этап 6 |
| AgentCore Memory | Память ролей и сырьё для кандидатов в предпочтения | `src/memory/memory.ts::RoleNotes` |
| Knowledge Base (S3 Vectors) | База знаний | `src/knowledge/base.ts` (интерфейс `search`) |
| AgentCore Gateway + Policy | Инструменты как MCP и права ролей | `studio/policies/tools.json` |
| AWS Budgets 50/80/95% | Сигнализация (не ограничитель) | ограничитель — `src/budget/ledger.ts` |

## Порядок
1. IAM: роль развёртывания через GitHub OIDC только для `designe-2026`.
2. DynamoDB-реализация `Store` (условные записи вместо файловых блокировок) + тест на совместимость с `FileStore`.
3. Бандл Lambda (esbuild), рендер-контейнер (arm64, Chromium).
4. Step Functions по черновику ASL, вебхук Telegram, секреты.
5. Сквозной тест в облаке: тот же сценарий, что `test/e2e.test.ts`, плюс сбои.
