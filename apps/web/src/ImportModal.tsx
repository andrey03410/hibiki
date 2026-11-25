import React, { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowUpRight, Youtube, X, Upload, Link2, FolderOpen } from "lucide-react";
import { api } from "./api";
import { Button, ErrorMessage, Modal, useData } from "./WorkspaceUi";
import { YoutubeLinkImport } from "./YoutubeSync";

export default function ImportModal({ close }: { close: () => void }) {
  const { refresh, notify } = useData(),
    [tab, setTab] = useState("files"),
    [url, setUrl] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [drag, setDrag] = useState(false);
  const navigate = useNavigate();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (tab === "youtube") {
        await api("/jobs", "POST", { kind: "youtube-import", input: { url } });
        notify("Импорт YouTube начат. Прогресс — в заданиях.");
      } else {
        const body = new FormData();
        files.forEach((file) =>
          body.append(tab === "archive" ? "file" : "files", file),
        );
        await api(
          tab === "archive" ? "/imports/upload" : "/items/upload",
          "POST",
          body,
        );
        notify(
          tab === "archive"
            ? "Архив отправлен на проверку. Посмотрите отчёт перед применением."
            : `Добавлено файлов: ${files.length}`,
        );
      }
      await refresh();
      close();
      if (tab !== "files") navigate("/jobs");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Добавить в медиатеку"
      subtitle="Файлы, ссылки и подборки — всё на своём месте."
      close={close}
    >
      <div className="import-tabs">
        {[
          ["files", "Файлы", <Upload size={16} />],
          ["youtube", "YouTube", <Youtube size={17} />],
          ["archive", "Архив Hibiki", <FolderOpen size={16} />],
        ].map(([id, label, icon]) => (
          <button
            key={id as string}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id as string);
              setFiles([]);
              setError("");
            }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submit}>
        {tab === "youtube" ? (
          <>
            <label>
              Ссылка на видео или плейлист
              <div className="input-icon">
                <Link2 size={17} />
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  required
                />
              </div>
            </label>
            <div className="import-info">
              <Youtube size={21} />
              <p>
                Каждое видео появится отдельной записью. Импорт сохраняет ссылки
                и названия. Скачивание можно запустить отдельно в меню записи.
              </p>
            </div>
            <YoutubeLinkImport url={url} onCreated={async (playlist) => {
              await refresh();
              close();
              navigate(`/playlists/${playlist.id}`);
            }} />
          </>
        ) : (
          <>
            <label
              className={`dropzone ${drag ? "dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                setFiles(
                  Array.from(e.dataTransfer.files).slice(
                    0,
                    tab === "archive" ? 1 : undefined,
                  ),
                );
              }}
            >
              <input
                type="file"
                multiple={tab === "files"}
                accept={
                  tab === "archive"
                    ? ".zip,application/zip"
                    : "audio/*,video/*,.flac,.m4a,.ogg,.mkv"
                }
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              <span className="drop-icon">
                <Upload size={26} />
              </span>
              <strong>
                {files.length
                  ? `Выбрано файлов: ${files.length}`
                  : "Перетащите файлы сюда"}
              </strong>
              <span>
                или <u>выберите на устройстве</u>
              </span>
              <small>
                {tab === "archive"
                  ? "ZIP-архив, экспортированный из Hibiki"
                  : "Аудио и видео · MP3, FLAC, WAV, MP4, WebM и другие"}
              </small>
            </label>
            {files.length > 0 && (
              <div className="upload-file-list">
                {files.map((f, index) => (
                  <div key={`${f.name}-${index}`}>
                    <span className="truncate">{f.name}</span>
                    <small>{(f.size / 1024 / 1024).toFixed(1)} МБ</small>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Убрать ${f.name}`}
                      onClick={() =>
                        setFiles((old) => old.filter((_, i) => i !== index))
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {tab === "archive" && (
              <p className="muted small">
                Сначала Hibiki проверит содержимое архива и покажет отчёт в
                заданиях. Вы сможете применить импорт после проверки.
              </p>
            )}
          </>
        )}
        <ErrorMessage error={error} />
        <div className="modal-actions">
          <Button
            type="button"
            className="subtle"
            onClick={close}
            disabled={busy}
          >
            Отмена
          </Button>
          <Button
            type="submit"
            className="primary"
            busy={busy}
            disabled={tab === "youtube" ? !url : !files.length}
          >
            {tab === "files"
              ? "Добавить файлы"
              : tab === "youtube"
                ? "Импортировать"
                : "Проверить архив"}
            <ArrowUpRight size={16} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
