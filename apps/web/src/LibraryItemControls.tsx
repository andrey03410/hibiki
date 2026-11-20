import { useId, useRef, type CSSProperties } from "react";
import type { TagDto } from "@hibiki/contracts";

const tagPlural = new Intl.PluralRules("ru");
const visibleTagLimit = 5;

export function ItemTagList({ tags, onTag }: { tags: TagDto[]; onTag?: (id: string) => void }) {
  const popupId = useId();
  const popup = useRef<HTMLDivElement>(null);
  if (!tags.length) return null;

  function renderTag(tag: TagDto) {
    const props = {
      className: "entry-tag",
      style: { "--tag-color": tag.color } as CSSProperties,
      title: tag.name,
    };
    return onTag
      ? <button type="button" key={tag.id} {...props} onClick={() => {
        popup.current?.hidePopover();
        onTag(tag.id);
      }}>{tag.name}</button>
      : <span key={tag.id} {...props}>{tag.name}</span>;
  }

  const extra = tags.slice(visibleTagLimit);
  const count = tagPlural.select(extra.length);
  const tagWord = count === "one" ? "тег" : count === "few" ? "тега" : "тегов";
  return (
    <div className="entry-tags" aria-label="Теги записи" role="group">
      {tags.slice(0, visibleTagLimit).map(renderTag)}
      {extra.length > 0 && (
        <>
          <button type="button" className="entry-tags-more" popoverTarget={popupId}
            aria-label={`Показать ещё ${extra.length} ${tagWord}`}>+{extra.length}</button>
          <div popover="auto" id={popupId} ref={popup} className="entry-tags-popup" role="group" aria-label="Остальные теги">
            {extra.map(renderTag)}
          </div>
        </>
      )}
    </div>
  );
}
