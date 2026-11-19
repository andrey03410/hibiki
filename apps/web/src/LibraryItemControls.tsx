import React, { useId, type CSSProperties } from "react";
import { Headphones, Pause, Video } from "lucide-react";
import type { TagDto } from "@hibiki/contracts";

const tagPlural = new Intl.PluralRules("ru");

export function ItemTagList({ tags, onTag }: { tags: TagDto[]; onTag?: (id: string) => void }) {
  if (!tags.length) return null;

  function renderTag(tag: TagDto) {
    const props = {
      className: "entry-tag",
      style: { "--tag-color": tag.color } as CSSProperties,
      title: tag.name,
    };
    return onTag
      ? <button type="button" key={tag.id} {...props} onClick={() => onTag(tag.id)}>{tag.name}</button>
      : <span key={tag.id} {...props}>{tag.name}</span>;
  }

  const extra = tags.slice(2);
  const count = tagPlural.select(extra.length);
  const tagWord = count === "one" ? "тег" : count === "few" ? "тега" : "тегов";
  return (
    <div className="entry-tags" aria-label="Теги записи" role="group">
      {tags.slice(0, 2).map(renderTag)}
      {extra.length > 0 && (
        <details className="entry-tags-extra">
          <summary aria-label={`Показать ещё ${extra.length} ${tagWord}`}
            onKeyDown={(event) => { if (event.key === " ") event.stopPropagation(); }}>
            +{extra.length}
          </summary>
          <div className="entry-tags-expanded">{extra.map(renderTag)}</div>
        </details>
      )}
    </div>
  );
}

export function LibraryVideoAction({ mode, title, playing, reason, onClick, onUnavailable }: {
  mode: "original" | "audio";
  title: string;
  playing: boolean;
  reason?: string;
  onClick: () => void;
  onUnavailable: (reason: string) => void;
}) {
  const reasonId = useId();
  const label = mode === "original" ? "Смотреть" : "Слушать";
  const Icon = playing ? Pause : mode === "original" ? Video : Headphones;
  return (
    <div className="entry-video-action-wrap">
      <button type="button" className="entry-video-action" aria-disabled={reason ? true : undefined}
        aria-label={playing ? `Приостановить: ${title} (${label.toLowerCase()})` : `${label} ${title}`}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => reason ? onUnavailable(reason) : onClick()}>
        <Icon size={14} aria-hidden="true" />
        {playing ? "Пауза" : label}
      </button>
      {reason && <span id={reasonId} role="tooltip" className="entry-video-reason">{reason}</span>}
    </div>
  );
}
