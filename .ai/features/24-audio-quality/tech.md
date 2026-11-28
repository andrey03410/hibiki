# Технические решения

## Исходная система

- [`media.ts`](../../../apps/server/src/media.ts): `probeMediaStreams` запускает `ffmpeg -i`
  (ffmpeg-static, ffprobe нет), разбирает строки `Stream #…: Audio|Video:` из stderr.
  `inspectFile` вычисляет `audioCodec`, `videoCodec`, `audioBits`, совместимость.
  Эти значения используются только при импорте и не сохраняются.
- [`schema.prisma`](../../../apps/server/prisma/schema.prisma): `MediaFile` хранит `mime`,
  `bytes`, `kind`, `hasAudio` и подсказки воспроизведения. Кодека нет.
- [`library.ts`](../../../apps/server/src/library.ts): импорт локального файла создаёт
  `MediaFile` оригинала и, если нужна подготовка, второй `MediaFile` копии (источник
  оригинала получает `unsupported_codec`). Связь копии с оригиналом не сохраняется.
  `itemDto` и сырой SQL `itemWindow` формируют `SourceDto`. `backfillAudioTracks` и
  `JobsService.backfillPlayback` — образцы фонового дозаполнения в worker.
- [`library-pages.ts`](../../../apps/server/src/library-pages.ts): `itemFilter` строит SQL
  фильтров, `orderBy`/`compare` — сортировки, `McpMediaPages.read` — курсоры MCP по колонке,
  `facetCounts` — числа тегов, которые страница возвращает при `offset=0`.
- [`mcp.ts`](../../../apps/server/src/mcp.ts): `media_list` берёт `librarySearchSchema`,
  поэтому новые поля фильтра и сортировки попадают в MCP автоматически.
- Сайт: строка записи — `ItemRow` в `main.tsx`, панель — `FacetBar` в `LibraryFilters.tsx`,
  состояние поиска — `library-search.ts`, карточка — `ItemDrawer` + `itemPanels`.
- Формат stderr FFmpeg проверен на локальном 6.0 и продовом 7.0.2: строка звука
  `aac (LC) (mp4a / …), 44100 Hz, stereo, fltp, 128 kb/s`, у FLAC/Opus битрейта потока нет,
  есть общий `bitrate:` в строке `Duration`. Разрядность без потерь — `s16`, `s32 (24 bit)`.

## Решения

### T01. Где хранить

- Варианты: отдельные колонки на каждый параметр; один JSON; JSON и колонки для запросов.
- Рекомендация: JSON для показа и три колонки для фильтра и сортировки.
- **Решение:** в `MediaFile` добавляются `quality TEXT` (JSON `MediaQualityDto`),
  `audioClass`, `audioFormat`, `audioScore INTEGER`, `qualityVersion INT DEFAULT 0` и
  `originFileId TEXT` (без внешнего ключа). Колонки фильтра у подготовленной копии описывают
  её оригинал: так SQL не делает лишний JOIN, а JSON хранит и собственные потоки копии,
  и `origin`.

### T02. Разбор

- **Решение:** новый модуль `media-quality.ts` с чистой функцией
  `parseMediaQuality(ffmpegOutput, ext)`. Он разбирает тот же stderr, что и
  `probeMediaStreams`; `inspectFile` возвращает `quality` без лишнего запуска FFmpeg.
  Разрядность берётся только у кодеков без потерь: у MP3/AAC `fltp` — формат декодера.
  Битрейт потока, если его нет, берётся из общего битрейта, но только для файла без видео.
  `audioScore`: класс × 1 000 000 плюс разрядность × 1000 + кГц для без потерь или
  kb/s для с потерями.

### T03. Выбор файла записи

- **Решение:** функция `qualitySource` (JS) и выражение `qualityFileSql` (SQL) выбирают
  один источник одинаково: локальный, `available`; сначала звук видеоряда, затем
  `preferredSourceId`, затем порядок вставки (`rowid`). `ItemDto.audioQuality` —
  качество этого файла (для копии — оригинала), с `sourceId`.

### T04. Связь копии с оригиналом

- **Решение:** импорт записывает `originFileId` подготовленной копии. Для прежних копий
  дозаполнение связывает файл с оригиналом той же записи с причиной `unsupported_codec`,
  созданным в пределах 10 минут, — именно так сейчас работает одна транзакция импорта.

### T05. Дозаполнение

- **Решение:** `LibraryService.backfillQuality(signal)` выбирает файлы с
  `qualityVersion < QUALITY_VERSION` пакетами по 64, проверяет размер на диске,
  запускает разбор (до 30 с на файл), затем пишет результат условным `updateMany`
  (id, path, версия). Если оригинал копии ещё не обработан, он анализируется первым.
  Нечитаемый файл получает текущую версию и `quality = NULL`, чтобы не повторяться.
  Отсутствующий файл пропускается. Worker вызывает дозаполнение при старте и каждые
  10 минут; также добавлен ключ `--backfill-quality` для ручного запуска.

### T06. Фильтр, сортировка и числа

- **Решение:** `audioQuality` в `librarySearchSchema` (до 32 значений, regex).
  `itemFilter` добавляет `EXISTS (SELECT 1 FROM MediaFile q WHERE q.id = qualityFile AND …)`.
  Сортировка `quality-*` выполняется в SQL (`orderBy`) и в курсоре MCP по тому же
  выражению с NULL в конце. Страница при `offset=0` возвращает `audioCounts`
  (`hires`, `hires.flac`, …), посчитанные без фильтра качества, но со всеми остальными
  условиями. Числа тегов учитывают фильтр качества. `facetToken` включает `audioQuality`.

### T07. MCP

- **Решение:** `SourceDto.quality` и `ItemDto.audioQuality` приходят в `media_list` (full)
  и `media_get` автоматически. `view=summary` добавляет `audioQuality` (label/class/format).
  Описание инструментов и `capabilities` объясняют фильтр и сортировку.

## Затронутые зоны

- [`.ai/map/media.md`](../../map/media.md) — хранение качества, дозаполнение, связь копии.
- [`.ai/map/web.md`](../../map/web.md) — значок, фасет «Качество», сортировка, карточка.
- [`.ai/map/mcp.md`](../../map/mcp.md) — поля качества, фильтр и сортировка.
- [`.ai/map/jobs.md`](../../map/jobs.md) — периодическое дозаполнение в worker.
- [`.ai/design/README.md`](../../design/README.md) — значок качества.

## Живые проверки

- Сайт: настоящий браузер, медиатека с FLAC 24/96, FLAC 16/44.1, MP3, AAC, ADPCM WAV;
  значки, карточка, фасет, сортировка.
- MCP: настоящий клиент, `media_list` с фильтром и сортировкой, `media_get`.
- Worker: дозаполнение старых файлов после миграции, повторный запуск без лишней работы.
- Прод: после деплоя доля файлов с `qualityVersion` = текущей по всем аккаунтам.
