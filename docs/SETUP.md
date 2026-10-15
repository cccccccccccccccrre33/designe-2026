# Что нужно, чтобы система заработала вживую

Ниже — блокирующие факторы на 15.10.2026, в порядке важности. Ни одна из этих
интеграций пока не проверялась вживую.

## 1. Репозиторий designe-2026 (блокирует публикацию кода)

`https://github.com/cccccccccccccccrre33/designe-2026` возвращает 404 для
неавторизованного запроса: он либо приватный, либо ещё не создан.

Нужно:
- создать репозиторий (можно пустым, приватным);
- на компьютере установить Git for Windows и GitHub CLI, выполнить `gh auth login`
  — тогда код можно запушить в ветку и открыть PR;
- для бота: fine-grained personal access token **только на designe-2026** с
  правами Contents (read/write), Pull requests (read/write), Issues
  (read/write). Положить в `.env` как `GITHUB_TOKEN` (файл не коммитится),
  в облаке — в Secrets Manager.
- включить защиту ветки `main` (запрет прямого push, обязательный review от
  владельца) — файл `.github/CODEOWNERS` уже готов.

## 2. Bedrock (блокирует живую работу агентов)

- Регион: `us-west-2` (Stable Image Core/Ultra есть только там).
- Включить доступ к моделям в консоли Bedrock → Model access: GLM 4.7 Flash,
  MiniMax M2.5, Kimi K2.5, DeepSeek V3.2, Nova 2 Lite, Claude Haiku 4.5,
  Claude Sonnet 4.6, Stable Image Core и Ultra, Stable Image Inpaint,
  Remove Background, Conservative Upscale. Затем `npm run check:bedrock` покажет, какие модели реально отвечают (ID некоторых моделей помечены в `models.json` как требующие проверки).
- Для локального запуска достаточно **Bedrock API-ключа** (`AWS_BEARER_TOKEN_BEDROCK`
  в `.env`).
- Сверить цены в `studio/policies/models.json` со страницей цен Bedrock; модели
  без цены система не вызывает.

## 3. Telegram (блокирует канал утверждения)

1. @BotFather → `/newbot` → токен → `.env` как `TELEGRAM_BOT_TOKEN`.
2. Написать боту любое сообщение.
3. Узнать свой числовой user id (например, у @userinfobot) → `TELEGRAM_OWNER_ID`.
   Бот отвечает только этому id.

Локально бот работает в режиме long polling: `npm run telegram`.

## 4. AWS-аккаунт для облачного режима (этап 5)

API-ключ Bedrock не даёт доступа к DynamoDB, S3, Step Functions и AgentCore.
Нужно:
- IAM Identity Center или IAM-роль для развёртывания (не ключи root);
- для CI — роль с доверием GitHub OIDC на репозиторий designe-2026;
- AWS Budgets на аккаунт с порогами 50/80/95%.

## 5. Рабочее окружение на этом компьютере

Сейчас установлены: Node.js 24, Microsoft Edge и Google Chrome (используются
рендерером). Не установлены: Git, Python, AWS CLI, Docker. Для работы системы
локально достаточно Node.js; для публикации кода нужен Git.

## 6. Материалы, которых не хватает

- Markdown-архив ссылок из исследования (упомянут в тексте исследования, к
  сообщению не приложен) → `npm run knowledge:ingest -- <файл>`.
- Скриншоты текущего приложения по экранам (главная, каталог, карточка,
  кастомайзер, корзина, активный заказ, профиль) → `product/current/`.
  Частично есть в `D:\DriveKava\Drive_Kava_v81_drinkit\screenshots`.
