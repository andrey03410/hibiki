import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Check, Copy, FilePlus2, Headphones, Link2, LoaderCircle, Pause, Play, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import type { ItemDto, PlaybackMode, SavedSharedPlaylistDto, ShareKind, ShareLinkDto, SharedViewDto } from "@hibiki/contracts";
import { api, formatDuration, mediaWord } from "./api";
import { ItemArtwork } from "./ItemArtwork";
import { usePlayer } from "./player";
import { playbackSources, soundUnavailableReason } from "./player-model";
import { formatShareExpiry, isClosedShare, issueShare, orderedSharedItems, shareExpiry, shareLocalTime, shareStatusLabel, type ShareDuration } from "./sharing-model";
import { useSharingRequest } from "./use-sharing-request";
import "./sharing.css";

function ShareDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog ref={ref} className="modal share-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close(); }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Закрыть" onClick={close}><X size={19} /></button>
      </div>
      {children}
    </dialog>
  );
}

function CopyLink({ url, withField = false }: { url: string; withField?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<"done" | "manual">();
  const absoluteUrl = new URL(url, typeof window === "undefined" ? "http://localhost" : location.origin).href;
  useEffect(() => {
    if (result !== "manual") return;
    input.current?.focus();
    input.current?.select();
  }, [result]);
  useEffect(() => {
    if (result !== "done") return;
    const timer = window.setTimeout(() => setResult(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [result]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setResult("done");
    } catch {
      if (result === "manual") input.current?.select();
      setResult("manual");
    }
  }
  return (
    <div className="share-copy">
      {(withField || result === "manual") && (
        <input ref={input} aria-label="Адрес ссылки" value={absoluteUrl} readOnly onFocus={event => event.target.select()} />
      )}
      <button type="button" className={`button ${withField ? "primary" : "subtle"}`} onClick={copy}>
        {result === "done" ? <Check size={16} /> : <Copy size={16} />}
        {result === "done" ? "Скопировано" : "Скопировать"}
      </button>
      <span className={result === "manual" ? "small muted share-copy-status" : "sr-only"} role="status">
        {result === "manual" ? "Скопируйте выделенный адрес." : result === "done" ? "Ссылка скопирована" : ""}
      </span>
    </div>
  );
}

type LinkUpdate = { expiresAt: string | null } | { allowReshare: boolean };

function updateShareLink(id: string, settings: LinkUpdate) {
  return api<ShareLinkDto>(`/share-links/${encodeURIComponent(id)}`, "PATCH", settings);
}

function sharedCount(trackCount: number, totalCount?: number | null) {
  return totalCount == null ? `${trackCount} ${mediaWord(trackCount)}` : `Доступно по ссылке — ${trackCount} из ${totalCount}`;
}

export function ShareLinkFields({ link, origin, patch }: {
  link: ShareLinkDto;
  origin: string;
  patch: (settings: LinkUpdate) => Promise<void>;
}) {
  const [selected, setSelected] = useState<ShareDuration>(link.expiresAt ? "custom" : "never");
  const [applied, setApplied] = useState(selected);
  const [localTime, setLocalTime] = useState(link.expiresAt ? shareLocalTime(link.expiresAt) : "");
  const [pending, setPending] = useState<"expiry" | "permission">();
  const busy = pending !== undefined;
  const hintId = useId();
  const [error, setError] = useState("");
  async function apply(duration: ShareDuration) {
    const previous = applied;
    setError("");
    setPending("expiry");
    try {
      await patch({ expiresAt: shareExpiry(duration, localTime) });
      setApplied(duration);
    } catch (error) {
      if (duration !== "custom") setSelected(previous);
      setError((error as Error).message);
    } finally {
      setPending(undefined);
    }
  }
  async function setPermission(allowReshare: boolean) {
    setError("");
    setPending("permission");
    try {
      await patch({ allowReshare });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(undefined);
    }
  }
  return (
    <>
      <p className="share-dialog-target" title={link.title}>{link.title}</p>
      {link.kind === "playlist" && <div className="share-count small muted" role="status">
        {link.trackCount === null ? "Считаем записи…" : sharedCount(link.trackCount, link.totalCount)}
        {(!!link.missingPermissionCount || !!link.unavailableCount) && <dl>
          {!!link.missingPermissionCount && <><dt>Требуется разрешение автора</dt><dd>{link.missingPermissionCount}</dd></>}
          {!!link.unavailableCount && <><dt>Оригинал недоступен</dt><dd>{link.unavailableCount}</dd></>}
        </dl>}
      </div>}
      {link.url && <CopyLink url={new URL(link.url, origin).href} withField />}
      <form className="share-duration" onSubmit={event => { event.preventDefault(); void apply("custom"); }}>
        <label>
          Срок действия
          <select value={selected} disabled={busy} onChange={event => {
            const duration = event.target.value as ShareDuration;
            setSelected(duration);
            setError("");
            if (duration !== "custom") void apply(duration);
          }}>
            <option value="never">Бессрочно</option>
            <option value="day">1 день</option>
            <option value="custom">Указать дату и время</option>
          </select>
        </label>
        {selected === "custom" && <div className="share-custom-expiry">
          <label>Дата и время окончания
            <input type="datetime-local" value={localTime} onChange={event => setLocalTime(event.target.value)} required disabled={busy} />
          </label>
          <button type="submit" className="button subtle" disabled={busy}>Применить</button>
        </div>}
        <span className="small muted" role="status">
          {pending === "expiry" ? "Сохраняем срок…" : link.expiresAt ? `Действует до ${formatShareExpiry(link.expiresAt)}` : "Ссылка действует бессрочно"}
        </span>
      </form>
      <div className="share-permission">
        <label>
          <input type="checkbox" checked={link.allowReshare ?? false} disabled={busy} aria-describedby={hintId}
            onChange={event => void setPermission(event.target.checked)} />
          Разрешить слушать в плейлистах других пользователей
        </label>
        <p className="small muted" id={hintId}>
          Вошедшие в Hibiki пользователи смогут слушать {link.kind === "playlist" ? "ваши записи из этой подборки" : "эту запись"} по уже выданным и будущим ссылкам на чужие плейлисты.
          {link.kind === "playlist" && " При изменении состава разрешение действует на записи, которые сейчас входят в подборку."}
        </p>
        {pending === "permission" && <span className="small muted" role="status">Сохраняем разрешение…</span>}
      </div>
      {error && <p className="small danger-text" role="alert">{error}</p>}
    </>
  );
}

export function IssueShare({ kind, targetId, issued, close }: {
  kind: ShareKind; targetId: string; issued: Promise<ShareLinkDto>; close: () => void;
}) {
  const [link, setLink] = useState<ShareLinkDto>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(issued);
  useEffect(() => {
    let active = true;
    void attempt.then(
      result => { if (active) setLink(result); },
      (failure: Error) => { if (active) setError(failure.message); },
    );
    return () => { active = false; };
  }, [attempt]);
  const id = link?.id;
  const pendingCount = link?.kind === "playlist" && link.trackCount === null;
  useEffect(() => {
    if (!id || !pendingCount) return;
    let active = true;
    let timer: number;
    const readCount = async () => {
      const next = await api<ShareLinkDto>(`/share-links/${encodeURIComponent(id)}`, "GET", undefined, "low").catch(() => undefined);
      if (!active) return;
      if (next?.trackCount != null) {
        setLink(current => current && {
          ...current, trackCount: next.trackCount, totalCount: next.totalCount,
          missingPermissionCount: next.missingPermissionCount, unavailableCount: next.unavailableCount,
        });
        return;
      }
      timer = window.setTimeout(readCount, 3000);
    };
    void readCount();
    return () => { active = false; window.clearTimeout(timer); };
  }, [id, pendingCount]);
  async function patch(settings: LinkUpdate) {
    setLink(await updateShareLink(id!, settings));
  }
  return (
    <ShareDialog title="Поделиться" close={close}>
      {link && <ShareLinkFields link={link} origin={location.origin} patch={patch} />}
      {!link && !error && <Loading>Создаём ссылку…</Loading>}
      {error && <>
        <p className="error-box" role="alert">{error}</p>
        <button type="button" className="button subtle" onClick={() => {
          setError("");
          setAttempt(issueShare(kind, targetId));
        }}>Повторить</button>
      </>}
    </ShareDialog>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return <div className="loading-inline" role="status"><LoaderCircle className="spin" size={18} />{children}</div>;
}

export function ShareManager() {
  const { data, error, refresh, setData } = useSharingRequest<{ links: ShareLinkDto[] }>("/share-links");
  const [target, setTarget] = useState<ShareLinkDto>();
  const [editingId, setEditingId] = useState<string>();
  const editing = editingId && data?.links.find(link => link.id === editingId && link.status === "active");
  const [busy, setBusy] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  const close = () => { if (!busy) { setTarget(undefined); setRevokeError(""); } };
  async function patch(settings: LinkUpdate) {
    if (!editing) return;
    const updated = await updateShareLink(editing.id, settings);
    setData(before => before && { links: before.links.map(link => link.id === updated.id ? updated : link) });
    void refresh();
  }
  async function revoke() {
    if (!target) return;
    setBusy(true);
    setRevokeError("");
    try {
      await api(`/share-links/${encodeURIComponent(target.id)}`, "DELETE");
      setData(before => before && { links: before.links.map(link => link.id === target.id ? { ...link, url: undefined, status: "revoked" } : link) });
      setTarget(undefined);
      void refresh();
    } catch (failure) {
      setRevokeError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sharing-page">
      <div className="title-row library-title-row"><h1>Мои ссылки</h1></div>
      {error && <p className="error-box" role="alert">{error.message}</p>}
      {!data && !error && <Loading>Загружаем ссылки…</Loading>}
      {data?.links.length === 0 && <div className="empty-state">
        <div className="empty-icon"><Link2 size={29} /></div>
        <h3>Здесь будут ваши ссылки</h3>
        <p>Нажмите «Поделиться» у записи или плейлиста.</p>
      </div>}
      {data && data.links.length > 0 && <ul className="share-links">
        {data.links.map(link => <li className="share-link-row" key={link.id}>
          <div className="share-link-target">
            <strong>{link.title}</strong>
            <span className="small muted">{link.kind === "item" ? "Запись" : "Плейлист"} · {formatShareExpiry(link.expiresAt)}</span>
          </div>
          <span className="share-status" data-status={link.status}>{shareStatusLabel[link.status]}</span>
          <div className="share-link-actions">
            {link.status === "active" && <>
              {link.url && <CopyLink url={link.url} />}
              <button type="button" className="button subtle" onClick={() => setEditingId(link.id)} aria-label={`Настройки ссылки на «${link.title}»`}>
                <Settings2 size={15} /> Настройки
              </button>
              <button type="button" className="button subtle" onClick={() => setTarget(link)}>
                <Trash2 size={15} /> Отозвать
              </button>
            </>}
          </div>
        </li>)}
      </ul>}
      {editing && <ShareDialog title="Настройки ссылки" close={() => setEditingId(undefined)}>
        <ShareLinkFields key={editing.id} link={editing} origin={location.origin} patch={patch} />
      </ShareDialog>}
      {target && <ShareDialog title="Отозвать ссылку?" close={close}>
        <p>Доступ по ссылке на «{target.title}» закроется.</p>
        {revokeError && <p className="error-box" role="alert">{revokeError}</p>}
        <div className="modal-actions">
          <button type="button" className="button subtle" disabled={busy} onClick={close}>Отмена</button>
          <button type="button" className="button danger" disabled={busy} onClick={() => void revoke()}>Отозвать</button>
        </div>
      </ShareDialog>}
    </section>
  );
}

export function SavedSharedPlaylistCard({ playlist, onPlay }: { playlist: SavedSharedPlaylistDto; onPlay: () => void }) {
  return (
    <article className="playlist-card saved-shared-card">
      <button type="button" className="shared-card-art" onClick={onPlay}
        aria-label={`Воспроизвести плейлист «${playlist.title}»`}>
        <span className="playlist-play-mark" aria-hidden="true"><Play size={22} fill="currentColor" /></span>
      </button>
      <Link className="playlist-card-title" to={`/shared-playlists/${encodeURIComponent(playlist.id)}`}>{playlist.title}</Link>
      <p>Поделился {playlist.sharedBy}</p>
      <span className="small muted">
        {playlist.status !== "active" ? "Доступ закрыт" : playlist.trackCount === null
          ? "Обновляется автоматически" : sharedCount(playlist.trackCount, playlist.totalCount)}
      </span>
    </article>
  );
}

export function SharedMediaPage({ saved, refreshLibrary }: { saved?: boolean; refreshLibrary: () => Promise<void> }) {
  const { id, token } = useParams();
  const path = saved ? `/shared-playlists/${encodeURIComponent(id!)}` : `/shared/${encodeURIComponent(token!)}`;
  return <SharedMedia key={path} path={path} saved={saved} refreshLibrary={refreshLibrary} />;
}

function SharedMedia({ path, saved, refreshLibrary }: { path: string; saved?: boolean; refreshLibrary: () => Promise<void> }) {
  const { data, error, refresh } = useSharingRequest<SharedViewDto>(path);
  const [playingRequest, setPlayingRequest] = useState<string>();
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState<string>();
  const [savedId, setSavedId] = useState<string>();
  const [savedItems, setSavedItems] = useState(new Set<string>());
  const [remove, setRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const playbackRequest = useRef(0);
  const navigate = useNavigate();
  const player = usePlayer();
  const closed = isClosedShare(error);
  const available = !closed && data;
  const cover = available && data.items.find(item => item.sources.some(source => source.thumbnail));
  const positions = available ? orderedSharedItems(available) : [];
  const singleItemId = data?.kind === "item" ? data.items[0]?.id : undefined;
  const singlePlaying = !!singleItemId && player.playing && player.current?.id === player.sharedId(path, singleItemId);
  const savedPlaylistId = data?.kind === "playlist" && (savedId ?? data.savedId);
  const alreadySaved = savedId ?? data?.savedId;
  useEffect(() => () => { ++playbackRequest.current; }, []);
  const loadEntries = useCallback(async () => {
    try {
      const view = await api<SharedViewDto>(path, "GET", undefined, "high");
      return orderedSharedItems(view).filter((item): item is ItemDto => item !== null);
    } catch (failure) {
      if (isClosedShare(failure)) return [];
      throw failure;
    }
  }, [path]);
  async function play(itemId?: string, mode: PlaybackMode = "original") {
    if (itemId && player.sharedId(path, itemId) === player.current?.id && player.playing) {
      ++playbackRequest.current;
      setPlayingRequest(undefined);
      player.toggle();
      return;
    }
    const request = ++playbackRequest.current;
    const isCurrent = () => request === playbackRequest.current;
    setPlayingRequest(itemId ?? "collection");
    setActionError("");
    try {
      const next = await loadEntries();
      if (!isCurrent()) return;
      const index = itemId ? next.findIndex(item => item.id === itemId) : 0;
      if (!next.length || index < 0) {
        setActionError(itemId ? "Доступ к записи закрыт" : "В подборке сейчас нет доступных записей");
        void refresh();
        return;
      }
      const fromLibrary = data?.kind === "playlist" && (!!itemId || mode === "audio");
      if (fromLibrary && itemId && soundUnavailableReason(next[index]!)) {
        void refresh();
        return;
      }
      await player.playShared(path, next, index, loadEntries, {
        mode: fromLibrary ? "audio" : mode, isCurrent, fromLibrary, activate: !!itemId,
        openPlayer: !fromLibrary && mode === "original" && (!!next[index]?.visual || data?.kind === "playlist"),
      });
    } catch (failure) {
      if (isCurrent()) setActionError((failure as Error).message);
    } finally {
      if (isCurrent()) setPlayingRequest(undefined);
    }
  }
  async function save(itemId?: string) {
    setSaving(itemId ?? "collection");
    setActionError("");
    try {
      const result = await api<{ id: string; kind: ShareKind }>(`${path}/save`, "POST", itemId ? { itemId } : {});
      if (itemId) setSavedItems(previous => new Set(previous).add(itemId));
      else setSavedId(result.id);
      if (result.kind === "item") void refreshLibrary().catch(() => {});
    } catch (failure) {
      setActionError((failure as Error).message);
      if (isClosedShare(failure)) void refresh();
    } finally {
      setSaving(undefined);
    }
  }
  async function removePlaylist() {
    setRemoving(true);
    setRemoveError("");
    try {
      await api(path, "DELETE");
      navigate("/playlists");
    } catch (failure) {
      setRemoveError((failure as Error).message);
      setRemoving(false);
    }
  }
  return (
    <section className="sharing-page">
      <div className="page-top">
        <div className="breadcrumb">{saved ? "Плейлисты" : "По ссылке"}</div>
        {saved && <Link className="text-button" to="/playlists"><ArrowLeft size={14} />К подборкам</Link>}
      </div>
      {!data && !error && <Loading>Загружаем…</Loading>}
      {error && !closed && <div className="error-box" role="alert">{error.message}
        <button className="text-button" onClick={() => void refresh()}><RefreshCw size={14} />Повторить</button>
      </div>}
      {(data || closed) && <div className="playlist-detail-hero shared-media-hero">
        <div className="shared-media-art"><ItemArtwork size="cover" source={cover ? cover.sources.find(source => source.thumbnail) : undefined} kind={cover ? cover.kind : "audio"} /></div>
        <div>
          <h1>{data?.title ?? (closed ? "Доступ закрыт" : "Плейлист")}</h1>
          {data && <p className="muted">Поделился {data.sharedBy}{saved && !closed && " · Состав обновляется автоматически"}</p>}
          {closed && <p role="status" className="muted">{data ? "Доступ закрыт" : "Ссылка больше не действует."}</p>}
          {available && data.kind === "playlist" && <p className="muted">{sharedCount(data.trackCount, data.totalCount)}</p>}
          <div className="playlist-actions">
            {available && <>
              <button className="button primary" type="button" disabled={!data.items.some(item => playbackSources(item).length) || playingRequest !== undefined}
                onClick={() => void play(singleItemId)}>
                {singlePlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                {singlePlaying ? "Приостановить" : "Воспроизвести"}
              </button>
              {data.kind === "playlist" && <button className="button subtle" type="button" disabled={!data.items.some(item => playbackSources(item, "audio").length) || playingRequest !== undefined}
                onClick={() => void play(undefined, "audio")}><Headphones size={16} />Слушать</button>}
              {!saved && (!alreadySaved ?
                <button className="button subtle" type="button" disabled={saving !== undefined} onClick={() => void save()}>
                  <FilePlus2 size={16} />{saving === "collection" ? "Добавляем…" : "Добавить в медиатеку"}
                </button> : savedPlaylistId ?
                  <Link className="button subtle" to={`/shared-playlists/${encodeURIComponent(savedPlaylistId)}`}><Check size={16} />Открыть сохранённый плейлист</Link> :
                  <span className="share-saved-marker" role="status"><Check size={16} />Добавлено в медиатеку</span>)}
            </>}
            {saved && <button className="button subtle" type="button" onClick={() => setRemove(true)}>
              <Trash2 size={16} />Убрать из плейлистов
            </button>}
          </div>
        </div>
      </div>}
      {actionError && <p className="error-box" role="alert">{actionError}</p>}
      {available && data.kind === "playlist" && positions.length > 0 && !data.trackCount && (
        <p className="muted" role="status">Все записи в подборке закрыты для прослушивания, поэтому очередь пока пуста.</p>
      )}
      {available && data.kind === "playlist" && (positions.length > 0
        ? <ol className="shared-tracks" aria-label="Состав плейлиста">
          {positions.map((item, index) => {
            if (!item) return <li key={`closed-${index}`} className="shared-track shared-track-closed">
              <span className="small" aria-hidden="true">{index + 1}</span>Запись недоступна
            </li>;
            const active = player.current?.id === player.sharedId(path, item.id) && !!player.current;
            const playing = active && player.playing;
            const unavailable = soundUnavailableReason(item);
            return <li key={item.id} className="shared-track" aria-current={active || undefined}>
              <button type="button" className="icon-button" onClick={() => void play(item.id)}
                aria-label={`${playing ? "Приостановить" : "Воспроизвести"} ${item.title}`}
                disabled={!playing && (!!unavailable || playingRequest === item.id)} title={unavailable}>
                {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              </button>
              <span className={`item-art art-${index % 6}`} aria-hidden="true">
                <ItemArtwork source={item.sources.find(source => source.thumbnail)} kind={item.kind} />
              </span>
              <div className="share-link-target"><strong>{item.title}</strong><span className="small muted">{item.kind === "video" ? "Видео" : "Аудио"} · {formatDuration(item.duration)} · {item.shared?.sharedBy ?? data.sharedBy}</span>
                {unavailable && <span className="small muted">{unavailable}</span>}</div>
              {!item.shared?.delegated && (savedItems.has(item.id) ? <span className="share-saved-marker" role="status"><Check size={16} />Добавлено</span> :
                <button type="button" className="button subtle" disabled={saving !== undefined} onClick={() => void save(item.id)}
                  aria-label={`Добавить в медиатеку: ${item.title}`}><FilePlus2 size={16} />{saving === item.id ? "Добавляем…" : "Добавить"}</button>)}
            </li>;
          })}
        </ol>
        : <p className="empty-state muted">В плейлисте пока нет записей.</p>)}
      {remove && <ShareDialog title="Убрать сохранённый плейлист?" close={() => { if (!removing) setRemove(false); }}>
        <p>Отдельно добавленные записи останутся в медиатеке.</p>
        {removeError && <p className="error-box" role="alert">{removeError}</p>}
        <div className="modal-actions">
          <button className="button subtle" type="button" disabled={removing} onClick={() => setRemove(false)}>Отмена</button>
          <button className="button danger" type="button" disabled={removing} onClick={() => void removePlaylist()}>Убрать</button>
        </div>
      </ShareDialog>}
    </section>
  );
}
