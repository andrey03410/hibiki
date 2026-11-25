import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Download, Plus, Check, Upload, KeyRound, Copy, FolderOpen } from "lucide-react";
import type { UserDto } from "@hibiki/contracts";
import { api } from "./api";
import { Button, ErrorMessage, Modal, PageTop, useData } from "./WorkspaceUi";
import { KanameSettings } from "./KanameSettings";
import { StorageSettings } from "./StorageSettings";
import { YoutubeSyncSettings } from "./YoutubeSync";
import { HistorySettings } from "./HistorySettings";

export default function SettingsPage({ user, kaname }: { user: UserDto; kaname: boolean }) {
  const { overview, notify, refresh, openImport } = useData(),
    [tokens, setTokens] = useState<
      { id: string; name: string; createdAt: string }[]
    >([]),
    [name, setName] = useState(""),
    [newToken, setNewToken] = useState(""),
    [busy, setBusy] = useState(false),
    [includeFiles, setIncludeFiles] = useState(true),
    [includeNotes, setIncludeNotes] = useState(false),
    [includeHistorySummary, setIncludeHistorySummary] = useState(false),
    [exportBusy, setExportBusy] = useState(false),
    [error, setError] = useState("");
  const navigate = useNavigate();
  async function loadTokens() {
    try {
      const data = await api("/tokens");
      setTokens(data.tokens);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void loadTokens();
  }, []);
  const mcpUrl = `${location.origin}/mcp`;
  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(success);
    } catch {
      notify(
        "Не удалось скопировать. Выделите и скопируйте текст вручную.",
        true,
      );
    }
  }
  return (
    <>
      <PageTop label="Настройки" />
      <div className="title-row">
        <div>
          <span className="eyebrow">ВАШЕ ПРОСТРАНСТВО ПОД КОНТРОЛЕМ</span>
          <h1>
            Настройки<span className="heading-dot">.</span>
          </h1>
          <p className="muted">
            Подключайте агента и берите медиатеку с собой.
          </p>
        </div>
      </div>
      <div className="settings-layout">
        {kaname && <KanameSettings userId={user.id} />}
        <StorageSettings key={user.id} />
        <YoutubeSyncSettings />
        <HistorySettings playlists={overview.playlists} revision={overview.revision} />
        <section className="settings-card">
          <div className="settings-card-heading">
            <span className="settings-icon">
              <KeyRound size={22} />
            </span>
            <div>
              <h2>Подключение ИИ-агента</h2>
              <p>
                Пусть ваш агент помогает собирать и настраивать медиатеку через
                MCP.
              </p>
            </div>
          </div>
          <label>
            Адрес MCP-сервера
            <div className="copy-field">
              <input value={mcpUrl} readOnly />
              <button
                className="icon-button"
                aria-label="Скопировать адрес MCP"
                onClick={() => copy(mcpUrl, "Адрес MCP скопирован")}
              >
                <Copy size={16} />
              </button>
            </div>
          </label>
          <p className="small muted">
            Добавьте этот адрес в MCP-клиент агента и передайте личный токен как{" "}
            <code>Authorization: Bearer …</code>. Агент получает доступ только к
            вашей библиотеке.
          </p>
          <div className="section-heading token-heading">
            <h3>Личные токены</h3>
            <span className="small muted">{tokens.length} активно</span>
          </div>
          <ErrorMessage error={error} />
          <div className="token-list">
            {tokens.map((token) => (
              <div key={token.id}>
                <span className="token-dot">
                  <KeyRound size={15} />
                </span>
                <div>
                  <strong>{token.name}</strong>
                  <small>
                    Создан{" "}
                    {new Date(token.createdAt).toLocaleDateString("ru-RU")}
                  </small>
                </div>
                <Button
                  className="subtle compact"
                  onClick={async () => {
                    try {
                      await api(`/tokens/${token.id}`, "DELETE");
                      await loadTokens();
                      notify(
                        "Токен отозван. Агент больше не сможет его использовать.",
                      );
                    } catch (e) {
                      notify((e as Error).message, true);
                    }
                  }}
                >
                  Отозвать
                </Button>
              </div>
            ))}
            {!tokens.length && (
              <p className="muted small">
                Пока нет токенов. Создайте отдельный для каждого агента.
              </p>
            )}
          </div>
          <form
            className="create-token-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const data = await api("/tokens", "POST", { name });
                setNewToken(data.token);
                setName("");
                await loadTokens();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              aria-label="Название токена"
              placeholder="Название, например Codex"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Button
              className="primary"
              type="submit"
              busy={busy}
              disabled={!name.trim()}
            >
              <Plus size={16} />
              Создать токен
            </Button>
          </form>
        </section>
        <section className="settings-card">
          <div className="settings-card-heading">
            <span className="settings-icon warm">
              <FolderOpen size={22} />
            </span>
            <div>
              <h2>Ваша медиатека — с вами</h2>
              <p>
                Переносите записи, теги, плейлисты и настройки в другую
                установку или аккаунт.
              </p>
            </div>
          </div>
          <div className="export-block">
            <h3>Экспортировать библиотеку</h3>
            <p className="small muted">
              Архив сохраняет названия и связи между записями. Пароли, сессии и
              токены в него не входят.
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={includeFiles}
                onChange={(e) => setIncludeFiles(e.target.checked)}
              />
              <span>
                Включить локальные медиафайлы
                <small>
                  Без файлов сохранятся метаданные и ссылки на источники.
                </small>
              </span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} />
              <span>Включить личные заметки</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={includeHistorySummary} onChange={(event) => setIncludeHistorySummary(event.target.checked)} />
              <span>Включить сводку прослушиваний<small>Счётчики для правил плейлистов.</small></span>
            </label>
            <Button
              className="subtle"
              busy={exportBusy}
              onClick={async () => {
                setExportBusy(true);
                try {
                  await api("/jobs", "POST", {
                    kind: "export",
                    input: { includeFiles, includeNotes, includeHistorySummary },
                  });
                  await refresh();
                  notify(
                    "Экспорт запущен. Ссылка на архив появится в заданиях.",
                  );
                  navigate("/jobs");
                } catch (e) {
                  notify((e as Error).message, true);
                } finally {
                  setExportBusy(false);
                }
              }}
            >
              <Download size={16} />
              Создать архив
            </Button>
          </div>
          <div className="import-block">
            <h3>Импортировать архив</h3>
            <p className="small muted">
              Hibiki проверит файлы и связи перед применением. Текущая
              библиотека сохранится.
            </p>
            <Button className="subtle" onClick={openImport}>
              <Upload size={16} />
              Выбрать архив
            </Button>
          </div>
        </section>
        <section className="settings-card account-settings">
          <div className="settings-card-heading">
            <span className="avatar">
              {user.login.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <h2>{user.login}</h2>
              <p>Личный аккаунт в вашей установке Hibiki</p>
            </div>
            <span className="status-pill">
              <span className="online-dot" />
              Подключён
            </span>
          </div>
          <p className="muted small">
            Положение в очереди, громкость, перемешивание и повтор сохраняются
            автоматически. После перезагрузки нажмите «Воспроизвести», чтобы
            продолжить.
          </p>
        </section>
      </div>
      {newToken && (
        <Modal
          title="Токен готов"
          subtitle="Скопируйте его сейчас — полностью он показывается один раз."
          close={() => setNewToken("")}
        >
          <div className="token-secret">
            <code>{newToken}</code>
            <button
              className="icon-button"
              aria-label="Скопировать токен"
              onClick={() => copy(newToken, "Токен скопирован")}
            >
              <Copy size={18} />
            </button>
          </div>
          <p className="muted small">
            Сохраните токен в настройках вашего агента. При необходимости его
            можно отозвать на этой странице.
          </p>
          <div className="modal-actions">
            <Button className="primary" onClick={() => setNewToken("")}>
              Готово
              <Check size={16} />
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
