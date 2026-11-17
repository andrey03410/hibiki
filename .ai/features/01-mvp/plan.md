# План первой итерации Hibiki

> Исполнение: superpowers:subagent-driven-development с независимыми пакетами;
> интеграция, живые проверки и финальное ревью — в текущей задаче. Разрешение
> владельца на автономную реализацию и merge записано в brief.md.

**Цель:** работающая локальная медиатека с MCP, смешанными audio/video-плейлистами,
YouTube, долговечными заданиями и переносом библиотеки.

**Архитектура:** Fastify + React/Vite, общий контракт Zod и чистое ядро правил.
Prisma/SQLite хранит пользователей, items/источники, теги, плейлисты, задания и
настройки; storage хранит медиа. Отдельный worker выполняет долгую работу.

**Стек:** TypeScript, Node 22.23.2 (имеющаяся поддерживаемая LTS), npm workspaces,
React 19, Vite, Fastify 5, Prisma 7, SQLite, Zod 4, MCP, yt-dlp/FFmpeg, Vitest.

**Спецификация:** [product.md](product.md), [tech.md](tech.md), [brief.md](brief.md).

## Общие ограничения

- ПК и браузер; русские документы/UI, английский код и conventional-коммиты.
- Один плейлист и очередь поддерживают и видео, и audio без искусственного разделения.
- Постоянный item с несколькими источниками, сохранение метаданных при недоступности.
- Сайт и MCP вызывают общие сервисы с проверкой владельца на каждой операции.
- JSON-правила без исполняемого кода, запрет циклов, объяснение результата.
- Локальные медиа/секреты/доказательства только в storage/env вне публичного git.
- Последний QG: npm test → npm run build → npx tsc --noEmit, затем живые поверхности.
- Приложение проверить в отдельном браузере агента; существующий браузер владельца не использовать.
- Главная ветка изменяется через PR после зелёных проверок и независимого ревью.

## Фокус ревью

1. Подмена ownerId/чужих ID во вложенных правилах, jobs, файлах и архивах.
2. Переход audio → video → YouTube, недоступный источник и восстановление очереди.
3. Рестарт worker между скачиванием и публикацией, повтор импорта без дублей.
4. Полный перенос с переназначением ID, отсутствующие файлы, опасные архивные пути.
5. Переменная структура YouTube-метаданных, частичный успех, отсутствие сети.

## 1. Контракты и вычисление плейлистов

Файлы: package.json, tsconfig.json, packages/contracts/src/index.ts,
packages/core/src/{playlists,queue}.ts и соответствующие *.test.ts.
Контракт: LibraryDto с ItemDto/SourceDto/TagDto/PlaylistDto/JobDto;
PlaylistDefinition v1 с items/playlist/tag/filter/union/intersection/difference и sort.
Evaluator получает медиатеку и возвращает items, reasons/excluded; валидатор
проверяет ссылки и циклы. Queue умеет shuffle/repeat и движение по смешанным items.

- [ ] Красные тесты на композицию, исключения, дубли, циклы, чужие зависимости и порядок.
- [ ] Реализовать схему, evaluator, explain и queue; проверить audio/video вместе.
- [ ] Прогнать пакетные тесты и сохранить результат/коммит.

## 2. БД, аккаунты и медиатека

Файлы: apps/server/prisma/schema.prisma, migrations, src/{db,auth,library,media}.ts,
scripts/{prisma,account}.mjs, тесты сервисов/API.
LibraryService: snapshot(ownerId), importLocal(ownerId,path,title?,itemId?),
upsertYoutube(ownerId,metadata), savePlaylist/resolve, tags, batch updates.
AuthService: регистрация/вход, cookie-сессии и отзываемые личные MCP-токены.

- [ ] Красные интеграционные тесты на сессии, владение, дубли и сохранение метаданных.
- [ ] Реализовать Prisma миграции и общие сервисы; потоковый upload/Range.
- [ ] Проверить реальные файлы и отсутствие чтения всего видео в память.

## 3. YouTube, задания и перенос

Файлы: apps/server/src/{youtube,jobs,portability}.ts, apps/worker/src/main.ts,
тесты этих модулей. JobsService использует db + LibraryService; файлы только в storage.
Входы: youtube-import, youtube-download, youtube-refresh, export, import.
Job: persistent state/progress/result, lease/heartbeat/cancel/retry.

- [ ] Красные тесты на нормализацию YouTube URL, частичный import/retry и export/import.
- [ ] Реализовать yt-dlp metadata/playlist/download, worker и полную переносимую библиотеку.
- [ ] Проверить рестарт, сохранение item при недоступности, архивные пути/хэши/owner mapping.

## 4. Сайт и постоянный плеер

Файлы: apps/web/{package.json,index.html,vite.config.ts,src/*}, тесты queue/player.
API: GET /api/me, /api/library, /api/settings, /api/tokens;
auth/register/login/logout; items/upload, items/batch, tags, playlists,
playlists/preview, playlists/:id/resolve, jobs/cancel/retry, imports/upload.
Данные контрактов — единственный словарь UI/API. Постоянный Player выше маршрутов.

- [ ] Написать проверки перехода между local audio/video и YouTube, восстановления очереди.
- [ ] Реализовать вход, медиатеку, теги, редактор правил/preview/explain, задания,
  настройки/MCP и экспорт/импорт; создать законченный тёмный ПК-интерфейс Hibiki.
- [ ] Реализовать seek/volume/shuffle/repeat/queue persistence и состояния ошибок.

## 5. HTTP/MCP и интеграция

Файлы: apps/server/src/{app,routes,mcp,main}.ts, scripts/verify-mcp.mjs,
интеграционные тесты и root scripts. Сервер отдаёт сайт/API/MCP/files на 8790;
Vite в разработке 5174. API и MCP используют LibraryService/JobsService.

- [ ] Красные HTTP-тесты для auth/ownership/playlist/jobs и настоящего MCP transport.
- [ ] Реализовать общий доступ, JSON errors, пагинацию, upload URLs и capability guide.
- [ ] Пройти сценарий из реального MCP-клиента; отозвать токен и проверить отказ.

## 6. Живая проверка и демонстрационная библиотека

Файлы: scripts/verify-live.mjs, storage/verification/01-mvp/* (вне git), verify.md.

- [ ] Найти локальные Key OST только в разрешённых музыкальных папках и скопировать
  несколько треков в Hibiki, не менять оригиналы. Импортировать anime openings с YouTube.
- [ ] Создать Key OST, Аниме-опенинги и смешанный составной плейлист для владельца.
- [ ] В браузере агента пройти UI, смешанную очередь, seek/shuffle/restore и сворачивание.
- [ ] Пройти полный экспорт/импорт под другим аккаунтом и в чистую установку,
  проверить права, отмену/рестарт worker и недоступные источники.
- [ ] После последних правок выполнить тройку, записать доказательства и ограничения.

## 7. Знания, ревью и merge

- [ ] Обновить AGENTS.md, README.md и все .ai/map/ реальными путями/командами.
- [ ] Независимое ревью всей ветки; устранить существенное и перепроверить изменённое.
- [ ] Push/PR, сохранить PR и итоги QG, затем автономно merge в main и проверить синхронизацию.

## Прогресс

- 2026-11-17: продукт/техника подтверждены; автономный режим до merge; план составлен.
  Предыдущее ограничение документами отменено последним поручением владельца.
