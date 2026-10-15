# Сергей Орлов

Dodo Engineering · Лид Android-дизайн-системы Dodo Pizza, Live Updates · школа «Dodo — продуктовый дизайн»

> Сгенерировано из studio/org/practitioners.json. Профессиональный почерк по публичным работам; не биография и не имитация личности.

## Сергей Орлов — приёмы
<!-- meta: id=PR-orlov-signatures; tier=A; tags=practitioner,dodo-product,orlov; kind=practitioner; rights=public-reference-only; url=https://habr.com/ru/companies/dododev/articles/1074898/ -->
- **Паспорт компонента** [DS-PASSPORT]: До кода дизайн и разработка согласуют паспорт: страница компонента в Figma с разделами для дизайна и платформ; разногласия превращаются в проверяемые пункты. В DRIVE&KAVA: Новый компонент в design-system — только с паспортом (состояния, размеры, токены).
- **Только токены и явные состояния** [DS-TOKENS-ONLY]: Только токены, состояния — явными вариантами, а не флагами; без внутреннего состояния; опциональный контент через слоты. В DRIVE&KAVA: validateSpec отвергает значения не из токенов.
- **Приёмка в песочнице** [DS-STORYBOOK]: Каждый компонент — в каталоге с настраиваемыми параметрами; это точка приёмки для дизайнера. В DRIVE&KAVA: Рендер всех компонентов в отдельный лист перед утверждением системы.
- **Расширять, а не дублировать** [DS-EXTEND-NOT-FORK]: Фичи зависят от системы, а не наоборот; нужен вариант — расширить компонент; отклонения фиксируются как осознанный долг. В DRIVE&KAVA: Design System Designer отклоняет дубль кнопки и предлагает вариант существующей.
- **Макеты врут — проверь на устройстве** [LU-MOCKUPS-LIE]: Ограничения SDK проверяются до финала макета; скриншоты документации — пожелание, а не спецификация; прототип — на реальном устройстве. В DRIVE&KAVA: Live Activity и виджеты DRIVE&KAVA проектируются в границах системных шаблонов.

## Сергей Орлов — метод и планка
<!-- meta: id=PR-orlov-method; tier=A; tags=practitioner,dodo-product,orlov; kind=practitioner; rights=public-reference-only; url=https://habr.com/ru/companies/dododev/articles/1074898/ -->
Метод: Распределённая разработка компонентов с двумя ревью: владельцы системы и дизайн.
Планка: Ошибки дешёвые и пойманы до пользователя.
Избегать: 28 стилей одной кнопки.

## Источники
- Дизайн-система в Додо: модуль компонентов — ещё не система (Habr) (тир A): https://habr.com/ru/companies/dododev/articles/1074898/
- Live Updates на Android: где макеты врут (Habr) (тир A): https://habr.com/ru/companies/dododev/articles/969810/

Роли студии, работающие в этой школе: design-system-designer, head-of-research-quality, ux-quality-reviewer, consistency-auditor, advisor-software-systems
