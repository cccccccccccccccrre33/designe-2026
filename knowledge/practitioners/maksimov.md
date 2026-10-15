# Дмитрий Максимов

Dodo Engineering (Drinkit Android) · Android-разработчик: карточка напитка на Compose, дизайн-система, общие переходы · школа «Drinkit — инженерное ремесло интерфейса»

> Сгенерировано из studio/org/practitioners.json. Профессиональный почерк по публичным работам; не биография и не имитация личности.

## Дмитрий Максимов — приёмы
<!-- meta: id=PR-maksimov-signatures; tier=A; tags=practitioner,drinkit-craft,maksimov; kind=practitioner; rights=public-reference-only; url=https://habr.com/ru/companies/dododev/articles/764540/ -->
- **Видео вместо фото на белом** [MAK-CARD-VIDEO]: У напитка в карточке — видео, а не статичное фото на белом фоне. В DRIVE&KAVA: Карточка напитка DRIVE&KAVA: петля 3–5 с (пар, лёд, пена) поверх которой лежит интерфейс.
- **Настройка на месте** [MAK-INPLACE-CUSTOMIZE]: Размер — одним тапом; панель кастомизации раскрывается на том же экране; одна строка-резюме выбранного вместо отдельных попапов. В DRIVE&KAVA: «350 мл · вівсяне · без цукру» одной строкой, тап по ингредиенту раскрывает панель.
- **Карточка из трёх ярусов** [MAK-THREE-PART]: Верх — видео и свёрнутая настройка; тап по ингредиенту — раскрытие; прокрутка — истории о напитке, состав, допродажи. В DRIVE&KAVA: Структура карточки напитка в Screen Spec: hero-видео, панель, прокручиваемый низ.
- **Сначала рискованное** [MAK-RISKY-FIRST]: Самую нестандартную часть (скролл и привязка) прототипировать в песочнице первой, сравнить несколько подходов. В DRIVE&KAVA: Сложный жест или переход сначала проверяется раскадровкой и физикой, потом рисуется экран.
- **Общие переходы поверх блюра** [MAK-SHARED-ELEMENTS-BLUR]: Общие элементы между экранами — обязательная часть UX даже при блюре и затемнениях. В DRIVE&KAVA: Motion Spec указывает shared elements и поведение блюра на каждом переходе.
- **Токены из Figma в код** [MAK-TOKENS-TO-CODE]: Песочница всех компонентов; токены генерируют код, чтобы дизайнер менял цвета без разработчика. В DRIVE&KAVA: design-system/tokens.json — единственный источник значений для рендера и будущего кода.

## Дмитрий Максимов — метод и планка
<!-- meta: id=PR-maksimov-method; tier=A; tags=practitioner,drinkit-craft,maksimov; kind=practitioner; rights=public-reference-only; url=https://habr.com/ru/companies/dododev/articles/764540/ -->
Метод: Песочница рискованной части за 1–2 дня. Централизованное состояние скролла и привязки. Производительность проверять сразу («осознанный Compose»).
Планка: Результат совпадает с макетом так, что продакты путают Android с iOS.
Избегать: Попапы настройки поверх карточки. Дубли одного компонента в разных фичах.

## Источники
- Сложная карточка товара на Compose (Habr) (тир A): https://habr.com/ru/companies/dododev/articles/764540/
- Android design system на Compose (LinkedIn) (тир A): https://www.linkedin.com/posts/dmitrijmaksimov_androiddev-designsystem-jetpackcompose-activity-7453402726073372673-bgkQ
- Telegram @mobile_cappuccino (по каталогу владельца) (тир A): https://t.me/mobile_cappuccino

Роли студии, работающие в этой школе: senior-product-designer, ux-architect, design-system-designer, motion-designer, animation-quality-reviewer, advisor-mobile-performance
