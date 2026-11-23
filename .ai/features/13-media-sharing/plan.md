# План реализации доступа по ссылке

Постановка — [продукт](product.md) и [техника](tech.md). Стек — SQLite, Prisma, Fastify, React, MCP. Исполнение подзадач — через `subagent-driven-development`.

## Контракт

Введём `ShareKind`, `ShareLinkDto`, `SharedViewDto`, `SavedSharedPlaylistDto`. Сервис `ShareService` принимает `db` и `library`. Метод `create(ownerId, kind, targetId, expiresAt?)`, `list(ownerId)`, `get(ownerId, id)`, `setExpiry(ownerId, id, expiresAt)`, `revoke(ownerId, id)` управляют ссылками. `open(viewerId, token)`, `save(viewerId, token, itemId?)`, `listSaved(viewerId)`, `openSaved(viewerId, id)`, `saveFromSaved(viewerId, id, itemId)`, `removeSaved(viewerId, id)` обслуживают получателя. `copySource(viewerId, itemId, tx?)` выбирает доступный источник, возвращает `{provider: "local", path, sourceId}` или `{provider: "youtube", externalId, sourceId}`.

| Метод | Маршрут | Результат |
|---|---|---|
| POST | `/api/share-links` | `ShareLinkDto`, вход `{kind, targetId, expiresAt?}` |
| GET | `/api/share-links` | `{links: ShareLinkDto[]}` |
| GET, PATCH | `/api/share-links/:id` | `ShareLinkDto`, PATCH принимает `{expiresAt}` |
| DELETE | `/api/share-links/:id` | `{ok:true}`, отзыв |
| GET | `/api/shared/:token` | `SharedViewDto` |
| POST | `/api/shared/:token/save` | `{id, kind}`, вход `{itemId?}` |
| GET | `/api/shared-playlists` | `{playlists: SavedSharedPlaylistDto[]}` |
| GET | `/api/shared-playlists/:id` | `SharedViewDto` |
| POST | `/api/shared-playlists/:id/save` | `{id, kind}`, вход `{itemId}` |
| DELETE | `/api/shared-playlists/:id` | `{ok:true}`, убрать сохранённый плейлист |
| POST | `/api/items/:id/shared-copy` | `JobDto`, вход `{mode?: "audio"\|"video"}` |

В `SharedViewDto.items` возвращаются записи с минимальными метаданными для плеера. `itemId` при сохранении совпадает с ID из ответа. `ItemDto.shared` передаёт имя автора и действующий доступ, `SourceDto.shared` отмечает заимствованные источники с обычным типом воспроизведения. Клиент использует `shareLinks` только для собственных ссылок.

## Задачи

- [x] Сервис и HTTP. Добавить красные проверки жизненного цикла ссылки и выдачи медиа двум аккаунтам в `apps/server/src/sharing.test.ts`. Создать миграцию, сервис и маршруты в `sharing.ts` и `sharing-routes.ts`. Проверить выдачу, перепроверку прав, Range, удаление из живой подборки и повторное сохранение.
- [x] Медиатека. Зафиксировать тестом получение сохранённого трека в обычном каталоге, избранном и плейлисте без новых файлов. Добавить проекцию заимствованных источников к штатной гидратации записей, переиспользование расчёта `LibraryService.playlistIds` и валидацию копирования при публикации локального импорта. Проверить, что архив не содержит общих файлов и пропусков доступа.
- [x] Интерфейс. Проверить модель попапа и формат срока. Добавить `Sharing.tsx` и стили, действия в записи и плейлисте, пункт «Мои ссылки», страницы получателя и сохранённых подборок. В реальном браузере проверить возврат после входа, проигрывание и отзыв.
- [x] MCP и копирование. Проверить методы через SDK. Добавить `share_create`, `share_list`, `share_set_expiry`, `share_revoke`, `share_open`, `share_save`, `share_copy` и задание `shared-copy`. Проверить копирование WAV и потерю доступа до выполнения отложенного задания.
- [ ] Выпуск. Перечитать дифф и карточки карты, прогнать тройку и живую проверку, исправить существенные замечания свежего ревьюера. Создать PR, дождаться проверок, влить, дождаться `deploy` и подтвердить версию на VPS, UI и worker.

## Что проверяем особо

- Ссылка от другой учётной записи или известный ID файла сами по себе не обходят привязку объекта и прав получателя.
- При изменении динамического состава просрочённый результат не разрешает чтение старого трека. Отзыв одной из двух ссылок сохраняет доступ по второй.
- Сохранение и повторное сохранение обходятся без записи файлов. Явная копия проходит квоты и воспроизводится после отзыва.
- Пустая подборка и отсутствующий счётчик позволяют сразу получить ссылку. Несколько получателей используют один актуальный расчёт.
- Закрытый доступ не удаляет теги, историю и записи из личных плейлистов. Экспорт переносит личное содержимое без доступа к чужому файлу.
