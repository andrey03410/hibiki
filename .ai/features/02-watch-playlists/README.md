---
id: '02'
title: YouTube-плейлисты и видео на первом плане
track: product
stage: review
branch: codex/02-watch-playlists
pr: https://github.com/andrey03410/hibiki/pull/2
started: 2026-11-17
merged:
autonomous: true
---

# 02. YouTube-плейлисты и видео на первом плане

Автономный режим до push и merge в main по прямому разрешению владельца.
Заменить демо реальными YouTube-подборками, добавить выборочные Key OST,
переделать просмотр под большое видео с очередью сбоку и удобным fullscreen.

## Стадии

- [x] Бриф — [brief.md](brief.md).
- [x] Продукт — [product.md](product.md).
- [x] Техника — [tech.md](tech.md).
- [x] План — [plan.md](plan.md).
- [x] Реализация и QG — [verify.md](verify.md).
- [x] Независимое ревью — P2 artwork исправлена и перепроверена, иных существенных замечаний нет.
- [ ] PR, CI и автономный merge в main.

## Следующий шаг

[PR #2](https://github.com/andrey03410/hibiki/pull/2) создан; дождаться CI и автономно влить. Локально 112 тестов/build/tsc и живой
браузер/MCP зелёные; в библиотеке 136OP+73ED+3Key, без скачивания YouTube.

## Хвосты

У 10 позиций YouTube уже нет названия/доступа; items и ID сохранены. Запрет встраивания
отдельных видео обрабатывается переходом очереди. Влитую 01-mvp не переписываем.
