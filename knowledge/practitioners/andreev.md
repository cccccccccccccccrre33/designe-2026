# Михаил Андреев

Dodo Engineering (iOS Dodo Pizza) · iOS-разработчик: компоненты дизайн-системы на SwiftUI · школа «Dodo — инженерное ремесло интерфейса»

> Сгенерировано из studio/org/practitioners.json. Профессиональный почерк по публичным работам; не биография и не имитация личности.

## Михаил Андреев — приёмы
<!-- meta: id=PR-andreev-signatures; tier=A; tags=practitioner,dodo-craft,andreev; kind=practitioner; rights=public-reference-only; url=https://habr.com/ru/companies/dododev/articles/867086/ -->
- **Переключатель, где текст инвертируется под ползунком** [AND-INVERT-SEGMENT]: Ползунок сегмент-контрола тянется свободно и прилипает к ближайшему сегменту при отпускании; текст сегментов меняет цвет ровно там, где под ним проходит ползунок (белый ↔ чёрный); первая позиция ставится без анимации. В DRIVE&KAVA: Переключатели «У вікні / У залі» и «Готівкою / Карткою» в DRIVE&KAVA — ползунок с прилипанием и инверсией текста; без системного Picker, если он не держит стиль.
- **Проверка на самом светлом контенте** [AND-REAL-BACKGROUNDS]: Режим смешивания давал неверные цвета на светлом фоне — ошибку заметили на карточке пиццы с креветками и исправили двумя слоями контента. В DRIVE&KAVA: Компоненты поверх фото напитка проверяются на самом светлом и самом тёмном кадре серии, а не на нейтральном фоне.

## Михаил Андреев — метод и планка
<!-- meta: id=PR-andreev-method; tier=A; tags=practitioner,dodo-craft,andreev; kind=practitioner; rights=public-reference-only; url=https://habr.com/ru/companies/dododev/articles/867086/ -->
Метод: Переписывали компонент в ходе переноса дизайн-системы на SwiftUI; редизайн карточки шёл A/B-тестом.
Планка: Компонент выглядит верно на любом фоне карточки.
Избегать: Компонент, проверенный только на нейтральном фоне.

## Источники
- Собственный Segmented Control на SwiftUI. Часть 1. Смешиваем цвета (Habr) (тир A): https://habr.com/ru/companies/dododev/articles/867086/

Роли студии, работающие в этой школе: senior-product-designer, mobile-ui-designer, design-system-designer
