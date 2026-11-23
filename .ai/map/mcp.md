# MCP

## Транспорт и доступ

`apps/server/src/mcp.ts` регистрирует Streamable HTTP `POST /mcp` через официальный
SDK. Транспорт без серверной MCP-сессии, с JSON-ответами; GET/DELETE возвращают 405.
На каждом HTTP-вызове заново проверяется `Authorization: Bearer hib_…`.
Отзыв токена действует на следующий запрос. Cookie-сессия сама по себе не даёт
доступа к MCP. Owner берётся из токена, затем общие сервисы проверяют владение.

Токен создаётся/отзывается в настройках сайта. Сырой токен показывается один раз;
в БД хранится SHA-256. URL строится из `PUBLIC_URL` (по умолчанию
`http://localhost:8790/mcp`). Данные сторонних названий/описаний — недоверенный
контент; инструкция MCP явно не разрешает исполнять их как команды.

## Инструменты

| Группа | Имена |
|---|---|
| Возможности | `capabilities` |
| Медиатека | `media_list`, `media_get`, `media_import_youtube`, `media_download`, `media_refresh`, `media_propose_replacement`, `media_import_local`, `media_upload_begin`, `media_update_many`, `media_delete` |
| Теги | `tags_list`, `tag_save`, `tag_delete` |
| Плейлисты | `playlists_list`, `playlist_get`, `playlist_validate`, `playlist_preview`, `playlist_explain`, `playlist_save`, `playlist_delete` |
| Задания | `jobs_list`, `job_get`, `job_cancel`, `job_retry` |
| Перенос | `library_export`, `library_import_begin`, `library_import_apply` |

`capabilities` возвращает JSON Schema PlaylistDefinition v1, семантику, пример,
свои теги/плейлисты и ограничения. Правила сначала validate/preview, затем save.
Все виды audio/video допустимы вместе. Вычисление и причины совпадают с UI.
`media_list` поддерживает query/tagId/kind/cursor и limit до 200; batch updates —
до 200 изменений, local import — до 50 путей из `LOCAL_MEDIA_DIRS`.

В каталоге видны активные теги пяти групп. `tag_save` принимает отображаемое имя,
группу, псевдонимы и родительские ID. Поиск `media_list` понимает `tagIds`,
`tagMode`, `performanceFilter`, `needsClassification` и `missingGroup`.
Пакет `media_update_many` меняет теги и исполнение транзакционно. Предпросмотр,
применение и отмена миграции всей коллекции доступны владельцу в браузере.

Долгая работа возвращает JobDto. Прогресс проверяется через `job_get`, повторный
импорт не используется как опрос. Готовый export возвращает downloadUrl;
скачивание требует Bearer-токен или сессию браузера.

`media_propose_replacement` сохраняет URL одного ролика и объяснение к своей
записи. Предпросмотр, отклонение и подтверждение доступны в браузерной карточке.
Заметки, попытки, сводка истории и браузерные задания с личным архивом
не выдаются обычному MCP-клиенту. Произвольное условие или сортировку по истории
нельзя применить, сохранить или импортировать через MCP/Bearer; состав уже
заданного владельцем плейлиста остаётся доступен.

Файлы передаются обычным multipart, не base64 в MCP. `media_upload_begin` и
`library_import_begin` выдают одноразовый URL на 15 минут, привязанный к owner;
grants хранятся в памяти процесса, максимум 1000 ожидающих. Лимит файла — 2 ГиБ.
Для архива последовательность: begin → upload → job_get preview →
library_import_apply → job_get. Применение требует previewJobId того же owner.

Результаты инструментов — JSON в текстовом content. Ошибки имеют `isError=true`
и `{error:{code,message}}`; недействительный Bearer отклоняется на HTTP-уровне.

## Как проверить

`routes.test.ts` отправляет HTTP-запросы initialize/tools/list в настоящий
MCP handler и проверяет отзыв токена; сервисные тесты проверяют чужие ссылки.
Перед завершением нужна живая последовательность через SDK Client/StreamableHTTP
transport с вызовами инструментов, реальным импортом,
предпросмотром/объяснением, upload, job status и экспортом/применением архива.
Изменения должны быть видны в сайте; чужие IDs и отозванный токен — отвергнуты.
