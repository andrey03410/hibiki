# Карта зон

Карточки описывают реализованные модули Hibiki, их границы, ограничения и способы
проверки. Начинай с карточки затронутой зоны; при изменении поведения обновляй её
в той же ветке. Результаты живой проверки фиксируются в папке текущей задачи,
а проверочные файлы — в `storage/` вне git.

| Зона | Карточка | Основной код |
|---|---|---|
| Окружение и проверки | [dev-env](dev-env.md) | `package.json`, `scripts/`, Prisma |
| Архитектура и доступ | [architecture](architecture.md) | `apps/server/src/`, `packages/` |
| Медиатека и файлы | [media](media.md) | `library.ts`, `media.ts` |
| Правила плейлистов | [playlists](playlists.md) | `packages/contracts/`, `packages/core/` |
| YouTube | [youtube](youtube.md) | `youtube.ts` |
| Фоновые задания | [jobs](jobs.md) | `jobs.ts`, `apps/worker/` |
| Сайт и плеер | [web](web.md) | `apps/web/src/` |
| MCP | [mcp](mcp.md) | `mcp.ts` |
| Перенос библиотеки | [portability](portability.md) | `portability.ts` |

Согласованные решения: [продукт](../features/01-mvp/product.md),
[техника](../features/01-mvp/tech.md), [план](../features/01-mvp/plan.md).
Рабочий процесс: [feature](../../.claude/skills/feature/SKILL.md),
[verify](../../.claude/skills/verify/SKILL.md). Наличие реализации в карточке
не заменяет итоговый QG и доказательства проверки текущей ветки.
