# План

- [ ] 1. Root: полный backup текущих демо через export, удалить восемь известных
  items, импортировать два полных YouTube-плейлиста ссылочно через MCP/jobs.
  Доказательство: отчёты, количество позиций, названия, отсутствие local YT sources.
- [ ] 2. Root: сохранить playlist title в jobs.ts, проверить тестом. Разметить
  импортированные позиции, сохранить исходный порядок, повтор без дублей.
  Импортировать три Key OST и собрать отдельный и составной плейлисты.
- [ ] 3. Frontend: apps/web/src/player.tsx, main.tsx, styles.css и содержательные
  тесты модели — постоянная сцена, очередь справа, audio artwork, pause/fullscreen,
  удобный desktop layout. Единственный engine и сохранение настроек.
- [ ] 4. Backend: artwork module, app.ts, library.ts + tests — embedded cover,
  безопасный формат/размер, owner check, fallback и перенос без миграции.
- [ ] 5. Root: интеграция, npm test → npm run build → npx tsc --noEmit, живой
  браузер/MCP, исправления найденного, независимое ревью, повтор QG при правках.
- [ ] 6. Знания: обновить карточки зон и verify.md, оформить PR, дождаться CI,
  автономно влить и push main, оставить приложение и смешанную подборку владельцу.

Каждый пункт закрывается фактическим результатом в verify.md. Реальные медиа,
аккаунты, отчёты и screenshot только в storage/verification/02-watch-playlists/.
