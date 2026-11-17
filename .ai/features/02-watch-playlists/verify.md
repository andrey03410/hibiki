# Проверка 02: реальные плейлисты и большой плеер

17 ноября 2026. Автономный режим владельца до PR/CI/merge.

## Данные и настоящий MCP

Клиент MCP SDK через Streamable HTTP выполнил initialize/capabilities, полный
export владельца, media_delete восьми известных demo items, media_import_youtube,
job_get, media_import_local, tag_save/media_update_many и playlist_save/preview.
Backup до удаления: 102 266 123 байта, сохранён локально, исходники OST не менялись.

| Подборка | Позиций | Повтор existing | Недоступных |
|---|---:|---:|---:|
| опенинги | 136 | 136 | 7 |
| эндинги | 73 | 73 | 3 |
| Key OST | 3 | — | 0 |

Итого 212 уникальных items: 209 исключительно YouTube sources и 3 local audio.
Точные теги «аниме опенинг»/«аниме эндинг» стоят у 136/73 позиций соответственно.
В обоих импортах errors=0, повтор added=0; исходный порядок сохранён manualOrder.
Названия 199 видео получены от провайдера. Для десяти уже удалённых/закрытых
роликов YouTube не отдаёт название: их ID/items/позиции сохранены как unavailable,
названия не выдумывались. Дополнительная metadata-проверка выявила эти статусы.
Один из повторов содержит предупреждение YouTube о скрытых недоступных роликах;
полученные reported/entries — 136/136 и 73/73, все полученные ID сохранены.

Новых youtube-download jobs и local sources у YouTube items нет. Прежние восемь
item IDs отсутствуют в текущей библиотеке. Оригиналы музыкальной папки не менялись.

Key: Nagisa (CLANNAD), Bird's Poem (AIR), Philosophyz (Rewrite).
HTTP artwork: 200 JPEG 33 242 и 246 918 байт, PNG 354 676 байт; все три media Range
вернули 206/1024 байта. Hibiki Mix объединяет три динамических плейлиста;
первые шесть позиций чередуют OP/audio/ED/audio/OP/audio.
Для удобства проверки третьей позицией выбран доступный в iframe эндинг Tomo-chan;
исходный порядок отдельного ED-плейлиста не менялся.

## Живой браузер агента

Отдельная вкладка IAB агента, localhost:8790, owner andrey. Браузер владельца
не использовался. Проверено реальное воспроизведение, а не только статус кнопки:

- Miss Kobayashi's Dragon Maid OP: кадры и растущая позиция YouTube.
- Tomo-chan ED: iframe video readyState=4, 1280×720, duration100.041,
  currentTime растёт; собственная пауза даёт native paused=true.
- Nagisa: audio readyState=4, duration250, position растёт; cover453×453 загружена.
- После seek в конец Nagisa автоматически стартовал YouTube Tomo-chan; после
  seek в конец эндинга — локальная Bird's Poem с обложкой.
- Переход страницы Mix → Key OST сохранил тот же YouTube iframe и текущую позицию.
- Shuffle включается/выключается, восстановлен исходный порядок общей очереди.
- Первый Railgun ED запрещает встраивание: плеер показал сообщение и продолжил
  очередь с Bird's Poem. Это ограничение провайдера, ссылка/item сохранены.
- На широком ПК очередь справа; на 784px ниже. Native fullscreen разворачивает
  audio/video вместе с controls, выход по Esc/кнопке не останавливает engine.
- Замечание владельца о пустой области справа/снизу воспроизведено при принудительном
  viewport тестового браузера. После reset и завершения смены режима stage rect
  совпадает с viewport1728×1084; screenshot без внешних пустых полос. Пропорции
  картинки сохранены, натуральные поля исходника не обрезаются.

Финальный bundle index-UG6AKyyA.js проверен: после входа native fullscreen
условное ожидание .is-controls-idle завершилось примерно через 3.5 с вместе
со входом. Сцена и media rect оба 1728×1084, панель исчезла; активность вернула
controls без смены engine. Вкладка оставлена на паузе с Nagisa и очередью 212.
Сон/сворачивание и гарантированный YouTube background заново не заявляются.

## Независимое ревью

Свежий reviewer отдельно проверил весь diff, включая незакоммиченные файлы и
данные evidence. Нашёл P2: parseFile ограничивал один payload, но не суммарный
объём всех embedded covers. Исправлено tokenizer read budget до I/O.
Регрессия FLAC130×64 КиБ: до исправления 200, после 404. Обложка за 9 МиБ MP4 padding
сохранилась. Reviewer независимо прогнал эти два теста и подтвердил закрытие P2.
Первый fullscreen fallback и прочая логика player/jobs — без иных P1/P2.
Финальный idle overlay reviewer отдельно проверил: таймер/reset/dispose,
YouTube reveal, keyboard focus-visible, native/fallback; иных P1/P2 нет.

## QG и merge

Свежая тройка после последних production-правок, строго по порядку:

| Команда | Результат |
|---|---|
| npm test | 112/112, 12 файлов, 8.78 с |
| npm run build | Exit 0, JS 458.22 кБ / gzip 136.84 кБ, CSS 58.24 кБ |
| npx tsc --noEmit | Exit 0 |
| git diff --check | Exit 0 |

Локальный Node 26.7.0; CI отдельно проверяет Node 22. Первый CI выявил ошибку
генерации ALAC fixture в Linux-сборке FFmpeg: frames:v1 завершал вывод до аудио
(пустой mdat, только attached PNG). Исправлен только тест: отдельный PNG input,
copy изображения и явная проверка hasAudio/duration. Исходные проверки большого
пропуска и сохранения cover не ослаблены. Диагностика удалена, reviewer подтвердил
исправление. Таблица выше — свежая тройка после этого изменения.
После неё менялись только документы. PR/CI/merge будут записаны после выполнения.

## Доказательства

`storage/verification/02-watch-playlists/` (вне git): before/after snapshots,
before-library.hibiki.zip, два исходных/повторных/уточнённых job report,
raw provider metadata, artwork-http.json и обложки, browser screenshots,
test/build/typecheck logs. Секреты клиента читаются из защищённого storage без вывода.

## Что посмотреть руками

Открыть Hibiki Mix, «Слушать»: первое видео → Nagisa → Tomo-chan ED → Bird's Poem
→ OSHI NO KO → Philosophyz. Проверить обложки, паузу, перемотку, shuffle и fullscreen;
в fullscreen через 3 с управления нет, движение возвращает. Отдельные плейлисты
сохраняют все 136/73 позиции, включая уже недоступные.
