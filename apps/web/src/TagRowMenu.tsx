import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Pencil, Trash2 } from "lucide-react";

export function TagRowMenu({ anchor, name, close, edit, remove }: {
  anchor: HTMLButtonElement;
  name: string;
  close: () => void;
  edit: () => void;
  remove: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    menu.showPopover();
    const place = () => {
      const box = anchor.getBoundingClientRect();
      menu.style.left = Math.max(4, box.right - menu.offsetWidth) + "px";
      menu.style.top = (box.bottom + menu.offsetHeight + 8 <= window.innerHeight ? box.bottom + 3 : box.top - menu.offsetHeight - 3) + "px";
    };
    place();
    menu.querySelector("button")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [anchor]);
  function keys(event: KeyboardEvent) {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      anchor.focus({ preventScroll: true });
      close();
    } else if (["Home", "End", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const buttons = [...ref.current!.querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }
  return <div ref={ref} popover="auto" className="directory-menu" role="menu" aria-label={"Действия с тегом " + name}
    onKeyDown={keys} onToggle={event => { if (event.newState === "closed") close(); }}>
    <button type="button" role="menuitem" tabIndex={-1} onClick={edit}><Pencil size={15} />Изменить</button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={remove}><Trash2 size={15} />Удалить</button>
  </div>;
}
