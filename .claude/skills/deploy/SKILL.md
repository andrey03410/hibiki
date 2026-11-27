---
name: deploy
description: Используй, когда нужно выложить hibiki на VPS после merge, проверить продовый релиз или откатить его на предыдущий коммит.
---

# Деплой hibiki

Релиз определяется коммитом `main`, фактически запущенным на VPS. Workflow `production.yml` проверяет контейнер и публикует его в GHCR по полному SHA.

1. Сверь SHA с задачей `/feature` и проверь состояние workflow. Если `AUTO_DEPLOY` выключен, запусти `gh workflow run production.yml --ref main` и сверь SHA в запущенном `Production`.
2. Дождись результата job `deploy` через `gh run watch <id> --exit-status`. Успешный job `image` подтверждает только сборку. При сбое проверь статус запущенного образа до повторной попытки. Если контейнер `unhealthy` и в `docker logs` есть `ENOSPC`, на VPS закончилось место: проверь `df -h /` и `docker system df`, удали неиспользуемые старые образы hibiki (`docker rmi`, кроме текущего, нового и предыдущего) и повтори выкладку.
3. Открой HTTPS на порту `8443` удалённого хоста из переменной `DEPLOY_HOST`. Проверь страницу после входа через Caddy, `/api/me` и состояние контейнера `hibiki-worker`. Зафиксируй SHA, ссылку на запуск и результат проверки.
4. Для отката выбери предыдущий проверенный SHA и выполни `bash release.sh hibiki <sha>` из каталога развёртывания на VPS с доступом к GHCR. Сценарий сохраняет копию SQLite перед стартом. Если схема несовместима, отдельно проверь состояние базы перед восстановлением.

Рабочие env и ключи находятся на VPS и в GitHub Actions Secrets. Проверочные аккаунты и результаты с персональными данными находятся в `storage/verification/`.

## Caddy для Hibiki

При смене конфигурации сохраните резервную копию Caddyfile с ограниченным доступом.
В блоке Hibiki на порту 8443 применяется следующий фрагмент.

```caddyfile
@hibikiText not path /files/* /api/items/*/artwork /api/shared* /api/jobs/*/download
encode @hibikiText zstd gzip {
    match {
        header Content-Type application/json*
        header Content-Type application/javascript*
        header Content-Type text/javascript*
        header Content-Type text/css*
    }
}
```

Проверьте кандидат внутри контейнера Caddy через `caddy validate --config - --adapter caddyfile`.
Файл смонтирован отдельно. Сохраняйте его inode при записи, затем выполните
`caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.
При ошибке восстановите сохранённое содержимое и повторите reload. Через HTTPS
проверьте Content-Encoding у большой сводки и байты Range-ответа у медиа.


В том же блоке для точного пути `/mcp` задан свой обработчик. У загрузок по
одноразовой ссылке остаётся отдельный маршрут `/api/uploads/*`.

```caddyfile
handle /mcp {
    reverse_proxy hibiki:8790 {
        lb_try_duration 20s
        lb_try_interval 250ms
    }
}
```

Это даёт контейнеру время начать принимать соединения при смене образа.
Стандартное ограничение Caddy на повтор после установленного соединения
сохраняется. На изолированном прокси проверены оба случая с POST. При
запуске backend с задержкой он получил одно полное тело запроса. Если backend
принял тело и закрыл соединение, Caddy вернул ошибку клиенту после одной
попытки. [Документация Caddy о повторах](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#load-balancing)
