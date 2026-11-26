import { useEffect, useId, useRef, useState } from "react";
import type { ItemDto, JobDto, SourceDto } from "@hibiki/contracts";
import { api, formatDuration } from "./api";
import { ItemSelect } from "./ItemPicker";
import { donorVideoFiles, offeredStreams } from "./visual-editor-model";

function sourceName(source: SourceDto, index: number) {
  return `Файл ${index + 1} · ${source.mime ?? "Локальный файл"}`;
}

export function VisualEditor({ item, reload }: { item: ItemDto; reload: () => Promise<void> }) {
  const path = `/items/${encodeURIComponent(item.id)}`;
  const storageKey = `hibiki.visual.job.${item.id}`;
  const heading = useId();
  const [updated, setUpdated] = useState(item);
  const current = (item.visualRevision ?? 0) > (updated.visualRevision ?? 0) ? item : updated;
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"library" | "file">("library");
  const [donorId, setDonorId] = useState("");
  const [donor, setDonor] = useState<ItemDto>();
  const [visualSourceId, setVisualSourceId] = useState("");
  const [streamIndex, setStreamIndex] = useState("");
  const [reportedStreams, setReportedStreams] = useState<NonNullable<SourceDto["videoStreams"]>>([]);
  const [soundId, setSoundId] = useState("");
  const [file, setFile] = useState<File>();
  const [jobId, setJobId] = useState(() => sessionStorage.getItem(storageKey) ?? "");
  const [pollAttempt, setPollAttempt] = useState(0);
  const [pollError, setPollError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const soundFiles = current.sources.filter(s => !s.shared && s.provider === "local" && s.status !== "unavailable" &&
    (s.hasAudio ?? s.mime?.startsWith("audio/")));
  const assignedSound = soundFiles.find(s => s.id === (current.visual?.soundSourceId ?? current.preferredSourceId)) ?? soundFiles[0];
  const donorSources = donorVideoFiles(donor?.sources ?? []);
  const donorSource = donorSources.find(source => source.id === visualSourceId) ?? donorSources[0];
  const streams = mode === "library" && donorSource?.videoStreams?.length ? donorSource.videoStreams : reportedStreams;
  const chooseStream = streams.length > 1;
  function showFailure(message: string) {
    const choices = offeredStreams(message);
    if (choices.length) {
      setReportedStreams(choices);
      setError("В файле несколько видеопотоков. Выберите поток и прикрепите клип.");
    } else setError(message);
  }
  const locked = busy || !!jobId;
  const refreshed = useRef(reload);
  refreshed.current = reload;
  useEffect(() => {
    if (!donorId) return;
    const controller = new AbortController();
    api<ItemDto>(`/items/${encodeURIComponent(donorId)}`, "GET", undefined, undefined, controller.signal)
      .then(row => { if (!controller.signal.aborted) setDonor(row); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [donorId]);
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    const {signal} = controller;
    let timer: ReturnType<typeof setTimeout>;
    const clear = () => { sessionStorage.removeItem(storageKey); setJobId(""); };
    async function poll() {
      try {
        const job = await api<JobDto>(`/jobs/${encodeURIComponent(jobId)}`, "GET", undefined, undefined, signal);
        if (signal.aborted) return;
        if (job.state === "failed" || job.state === "cancelled") {
          clear();
          showFailure(job.error || "Подготовка видеоряда остановлена.");
        } else if (job.state === "done") {
          const row = await api<ItemDto>(path, "GET", undefined, undefined, signal);
          if (signal.aborted) return;
          setUpdated(row);
          clear();
          setFile(undefined);
          setNotice("Клип обновлён.");
          setEditing(false);
          void refreshed.current().catch(failure => setError(failure.message));
        } else timer = setTimeout(poll, 900);
      } catch (failure) {
        if (!signal.aborted) { setError((failure as Error).message); setPollError(true); }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [jobId, path, storageKey, pollAttempt]);

  async function save(remove = false) {
    if (locked) return;
    setBusy(true);
    setError("");
    setNotice("");
    const expectedRevision = current.visualRevision ?? current.visual?.revision ?? 0;
    const soundSourceId = soundId || assignedSound?.id;
    try {
      if (remove) {
        await api(path + "/visual", "DELETE", {expectedRevision});
        setUpdated(await api<ItemDto>(path));
        setEditing(false);
        setNotice("Оригинал восстановлен.");
        await reload();
        return;
      }
      const options = {expectedRevision, soundSourceId, ...(streamIndex && {videoStreamIndex: Number(streamIndex)})};
      let job: JobDto;
      if (mode === "file") {
        if (!file) return;
        const form = new FormData();
        form.append("file", file);
        const query = new URLSearchParams({expectedRevision: String(expectedRevision)});
        if (streamIndex) query.set("videoStreamIndex", streamIndex);
        if (soundSourceId) query.set("soundSourceId", soundSourceId);
        job = await api<JobDto>(path + "/visual/upload?" + query, "POST", form);
      } else {
        job = await api<JobDto>(path + "/visual/prepare", "POST", {...options, visualSourceId: donorSource?.id});
      }
      sessionStorage.setItem(storageKey, job.id);
      setJobId(job.id);
      setPollError(false);
    } catch (failure) {
      showFailure((failure as Error).message);
      void api<ItemDto>(path).then(setUpdated).catch(() => {});
    } finally { setBusy(false); }
  }
  return <section className="source-replacement" aria-labelledby={heading}>
    <h3 id={heading}>Видеоряд</h3>
    <p className="small">Звук · {assignedSound ? sourceName(assignedSound, soundFiles.indexOf(assignedSound)) : "Нужен свой файл со звуком"}</p>
    <p className="small">Видеоряд · {current.visual ? `Клип · ${formatDuration(current.visual.duration)}` : current.kind === "video" ? "Исходное видео" : "Обложка записи"}</p>
    {!editing && (soundFiles.length > 0 || current.visual) && <div className="source-replacement-actions">
      <button type="button" className="button subtle" disabled={locked || !soundFiles.length} onClick={() => { setEditing(true); setNotice(""); setReportedStreams([]); setStreamIndex(""); }}>
        {current.visual ? "Заменить клип" : "Добавить клип"}</button>
      {current.visual && <button type="button" className="button subtle" disabled={locked} onClick={() => void save(true)}>Вернуть оригинал</button>}
    </div>}
    {editing && <fieldset className="visual-editor-fields" disabled={locked}><legend>Прикрепить видеоряд</legend>
      {soundFiles.length > 1 && <label>Источник звука<select value={soundId || assignedSound?.id} onChange={e => setSoundId(e.target.value)}>
        {soundFiles.map((s,i) => <option key={s.id} value={s.id}>{sourceName(s,i)}</option>)}</select></label>}
      <label>Откуда взять видеоряд<select value={mode} onChange={e => { setMode(e.target.value as typeof mode); setReportedStreams([]); setStreamIndex(""); }}>
        <option value="library">Из моей медиатеки</option><option value="file">Загрузить файл</option>
      </select></label>
      {mode === "file" ? <label>Видеофайл<input type="file" accept="video/*,.mkv,.m4v" onChange={e => { setFile(e.target.files?.[0]); setReportedStreams([]); setStreamIndex(""); setError(""); }} /></label> :
        <><ItemSelect label="Запись с видеорядом" empty="Выберите запись" value={donorId} onChange={id => {
          setDonorId(id); setDonor(undefined); setVisualSourceId(""); setStreamIndex(""); setReportedStreams([]); setError("");
        }} />
          {donor && !donorSources.length && <p role="status">У этой записи нет своего видеофайла. Выберите другую запись.</p>}
          {donorSources.length > 1 && <label>Видеофайл записи<select value={visualSourceId || donorSources[0].id} onChange={e => { setVisualSourceId(e.target.value); setStreamIndex(""); setReportedStreams([]); }}>
            {donorSources.map((s,i) => <option key={s.id} value={s.id}>{sourceName(s,i)}</option>)}</select></label>}
        </>}
      {chooseStream && <label>Видеопоток<select value={streamIndex} onChange={e => setStreamIndex(e.target.value)}>
        <option value="">Выберите поток</option>
        {streams.map(({index,codec}) => <option key={index} value={index}>{index} · {codec}</option>)}
      </select></label>}
      <div className="source-replacement-actions">
        <button type="button" className="button primary" disabled={(chooseStream && !/^\d+$/.test(streamIndex)) || (mode === "file" ? !file : !donorSources.length)}
          onClick={() => void save()}>Прикрепить клип</button>
        <button type="button" className="button subtle" onClick={() => setEditing(false)}>Отмена</button>
      </div>
    </fieldset>}
    {(locked || notice) && <p role="status" className="small muted">{locked ? "Готовим видеоряд…" : notice}</p>}
    {error && <p role="alert" className="small danger-text">{error} {pollError && jobId && <button type="button" className="text-button"
      onClick={() => { setError(""); setPollError(false); setPollAttempt(n => n + 1); }}>Проверить ещё раз</button>}</p>}
  </section>;
}
