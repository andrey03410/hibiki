---
id: '02'
title: YouTube-плейлисты и видео на первом плане
track: product
stage: merged
branch: codex/02-watch-playlists
pr: https://github.com/andrey03410/hibiki/pull/2
started: 2026-11-17
merged: 2026-11-17
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
- [x] [PR #2](https://github.com/andrey03410/hibiki/pull/2), CI и автономный merge в main.

## Результат

136 опенингов + 73 эндинга ссылочно, 3 Key OST и смешанная очередь из 212 items.
Большой watch-плеер, обложки аудио, fullscreen и controls с idle 3 с.
Локальные 112 тестов/build/tsc, независимое ревью, живая проверка и Node 22 CI
пройдены. Закрытие и вливание выполняются автономно через PR #2; финальный
документационный commit также должен иметь зелёный CI до merge.

## Хвосты

У 10 позиций YouTube уже нет названия/доступа; items и ID сохранены. Запрет встраивания
отдельных видео обрабатывается переходом очереди. Влитую 01-mvp не переписываем.
