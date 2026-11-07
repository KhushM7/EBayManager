import { motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Sheet } from "./adjust";
import { closestSlot, moveItem, slotFor } from "./order";

// Arrange photos: every photo as a small tile, put in order by dragging. Built the way established sortable
// libraries (dnd-kit, SortableJS) work, which the first version didn't:
//
// - The held photo follows the finger exactly, lifted; the others slide aside with an eased transform.
// - The drop slot is the nearest slot centre, from positions measured once when the drag starts, so it never
//   depends on tiles that are moving (the old version's flicking).
// - The real order changes only on release; the held photo then glides into its slot (FLIP).
// - A drag needs a deliberate start: press and hold about 0.2 s on a phone (before that the sheet scrolls as
//   usual), or move a few pixels with a mouse. Android gives a short buzz on pick-up.
// - Near the top or bottom of the sheet it scrolls by itself. Keyboard: focus a photo and use the arrow keys.

const TOUCH_DELAY_MS = 200;
const TOUCH_TOLERANCE_PX = 8;
const MOUSE_DISTANCE_PX = 4;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const SLIDE_MS = 220;

interface Candidate {
  id: string;
  pointerId: number;
  touch: boolean;
  x: number;
  y: number;
  timer?: number;
}
interface Drag {
  id: string;
  from: number;
  over: number;
  /** Slot centres, relative to the grid's top-left, measured at the start. */
  centres: { x: number; y: number }[];
  /** Each slot's top-left, relative to the grid. */
  slots: { x: number; y: number }[];
  /** Where the finger was, relative to the grid, at the start. */
  start: { x: number; y: number };
}

export function ArrangePhotos({ photos, onCancel, onDone }: { photos: { id: string; src: string }[]; onCancel: () => void; onDone: (order: string[]) => Promise<void> }) {
  const [order, setOrder] = useState(photos.map((p) => p.id));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const grid = useRef<HTMLUListElement>(null);
  const tiles = useRef(new Map<string, HTMLLIElement>());
  const cand = useRef<Candidate | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const orderRef = useRef(order);
  const pointer = useRef({ x: 0, y: 0 });
  const flip = useRef<Map<string, DOMRect> | null>(null);
  const src = new Map(photos.map((p) => [p.id, p.src]));
  const changed = order.some((id, i) => id !== photos[i]?.id);
  dragRef.current = drag;
  orderRef.current = order;

  /** Records where every tile is on screen now, so the next render can glide them from there (FLIP). */
  const remember = () => (flip.current = new Map([...tiles.current].map(([id, el]) => [id, el.getBoundingClientRect()])));

  // FLIP: after the order changes, each tile starts where it was and eases into its new place.
  useLayoutEffect(() => {
    const before = flip.current;
    if (!before) return;
    flip.current = null;
    for (const [id, el] of tiles.current) {
      const was = before.get(id);
      if (!was) continue;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (!dx && !dy) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.getBoundingClientRect(); // apply that start position before animating away from it
      el.style.transition = `transform ${SLIDE_MS}ms ${EASE}`;
      el.style.transform = "";
    }
  }, [order]);

  // --- Dragging ---

  const gridRect = () => grid.current!.getBoundingClientRect();

  const begin = (c: Candidate) => {
    const g = gridRect();
    const ids = orderRef.current;
    const rects = ids.map((id) => tiles.current.get(id)!.getBoundingClientRect());
    const from = ids.indexOf(c.id);
    cand.current = null;
    if (from < 0) return;
    const d: Drag = {
      id: c.id,
      from,
      over: from,
      centres: rects.map((r) => ({ x: r.left - g.left + r.width / 2, y: r.top - g.top + r.height / 2 })),
      slots: rects.map((r) => ({ x: r.left - g.left, y: r.top - g.top })),
      start: { x: c.x - g.left, y: c.y - g.top },
    };
    dragRef.current = d;
    setDrag(d);
    navigator.vibrate?.(12);
  };

  /** Moves the held tile under the finger (directly, not through a re-render) and finds the slot it's over. */
  const follow = () => {
    const d = dragRef.current;
    if (!d || !grid.current) return;
    const g = gridRect();
    const dx = pointer.current.x - g.left - d.start.x;
    const dy = pointer.current.y - g.top - d.start.y;
    const el = tiles.current.get(d.id);
    if (el) el.style.transform = `translate(${dx}px, ${dy}px)`;
    const centre = d.centres[d.from];
    const over = closestSlot(d.centres, { x: centre.x + dx, y: centre.y + dy });
    if (over !== d.over) {
      const next = { ...d, over };
      dragRef.current = next;
      setDrag(next);
    }
  };

  const drop = () => {
    const d = dragRef.current;
    if (!d) return;
    remember(); // the held tile where it was let go, the rest where they slid to
    for (const el of tiles.current.values()) (el.style.transform = ""), (el.style.transition = "");
    dragRef.current = null;
    setDrag(null);
    if (d.over !== d.from) {
      setOrder(moveItem(orderRef.current, d.from, d.over));
      setSaid(`Photo moved to place ${d.over + 1}${d.over === 0 ? ", the main photo" : ""}.`);
    } else setOrder([...orderRef.current]); // same place: still glide the tile home
  };

  const cancelCandidate = () => {
    if (cand.current?.timer) clearTimeout(cand.current.timer);
    cand.current = null;
  };

  // Window listeners, so a drag keeps working wherever the finger goes.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      const c = cand.current;
      if (c && e.pointerId === c.pointerId) {
        const dist = Math.hypot(e.clientX - c.x, e.clientY - c.y);
        if (c.touch && dist > TOUCH_TOLERANCE_PX) cancelCandidate(); // a scroll, not a drag
        else if (!c.touch && dist > MOUSE_DISTANCE_PX) begin(c);
      }
      if (dragRef.current) follow();
    };
    const up = () => {
      cancelCandidate();
      if (dragRef.current) drop();
    };
    // Once a drag is on, the sheet mustn't scroll under the finger (needs a non-passive listener).
    const noScroll = (e: TouchEvent) => {
      if (dragRef.current && e.cancelable) e.preventDefault();
    };
    const noMenu = (e: Event) => {
      if (cand.current || dragRef.current) e.preventDefault();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    addEventListener("touchmove", noScroll, { passive: false });
    addEventListener("contextmenu", noMenu);
    return () => {
      cancelCandidate();
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      removeEventListener("touchmove", noScroll);
      removeEventListener("contextmenu", noMenu);
    };
  }, []);

  // Scrolls the sheet while the held photo is near its top or bottom edge.
  useEffect(() => {
    if (!drag) return;
    const box = grid.current?.closest("[data-scroll]") as HTMLElement | null;
    if (!box) return;
    let raf = 0;
    const tick = () => {
      const r = box.getBoundingClientRect();
      const y = pointer.current.y;
      const edge = 56;
      const speed = y < r.top + edge ? -Math.ceil((r.top + edge - y) / 6) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 6) : 0;
      if (speed) {
        const before = box.scrollTop;
        box.scrollTop += speed;
        if (box.scrollTop !== before) follow();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [drag !== null]);

  const press = (id: string) => (e: PointerEvent) => {
    if (saving || dragRef.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    pointer.current = { x: e.clientX, y: e.clientY };
    const c: Candidate = { id, pointerId: e.pointerId, touch: e.pointerType !== "mouse", x: e.clientX, y: e.clientY };
    cancelCandidate();
    if (c.touch) c.timer = window.setTimeout(() => cand.current === c && begin(c), TOUCH_DELAY_MS);
    cand.current = c;
  };

  // --- Keyboard: arrow keys move the focused photo, and it glides there ---

  const key = (id: string) => (e: KeyboardEvent) => {
    const i = order.indexOf(id);
    const cols = grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length : 4;
    const by: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols, Home: -i, End: order.length - 1 - i };
    if (by[e.key] === undefined) return;
    e.preventDefault();
    const to = Math.min(order.length - 1, Math.max(0, i + by[e.key]));
    if (to === i) return;
    remember();
    setOrder(moveItem(order, i, to));
    setSaid(`Photo moved to place ${to + 1}${to === 0 ? ", the main photo" : ""}.`);
    requestAnimationFrame(() => tiles.current.get(id)?.focus());
  };

  const done = async () => {
    if (!changed) return onCancel();
    setSaving(true);
    setError(null);
    try {
      await onDone(order);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Sheet title="Arrange photos" onCancel={saving ? undefined : onCancel}>
      <p class="mb-3 text-sm text-muted">Press and hold a photo, then drag it where you want it. The first one is the main photo buyers see in search.</p>
      <ul ref={grid} class="relative grid grid-cols-4 gap-2 p-0 sm:grid-cols-5" aria-label="Photos in order. Focus a photo and use the arrow keys to move it.">
        {order.map((id, i) => {
          const held = drag?.id === id;
          const place = drag ? slotFor(i, drag.from, drag.over) : i;
          // While dragging, the others slide to their new place; the held one is moved by follow().
          const slide = drag && !held && place !== i ? { x: drag.slots[place].x - drag.slots[i].x, y: drag.slots[place].y - drag.slots[i].y } : null;
          const style: Record<string, string> = { touchAction: drag ? "none" : "manipulation", WebkitTouchCallout: "none" };
          if (drag && !held) Object.assign(style, { transform: slide ? `translate(${slide.x}px, ${slide.y}px)` : "translate(0px, 0px)", transition: `transform ${SLIDE_MS}ms ${EASE}` });
          if (held) style.transition = "none";
          return (
            <li
              key={id}
              ref={(el) => {
                if (el) tiles.current.set(id, el);
                else tiles.current.delete(id);
              }}
              tabIndex={0}
              aria-label={`Photo ${i + 1}${i === 0 ? ", main photo" : ""}`}
              class={`relative aspect-square list-none select-none rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent ${held ? "z-20 cursor-grabbing" : "z-0 cursor-grab"}`}
              style={style}
              onPointerDown={press(id)}
              onKeyDown={key(id)}
            >
              <div
                class="size-full overflow-hidden rounded-xl"
                style={{
                  transform: held ? "scale(1.08)" : "scale(1)",
                  boxShadow: held ? "0 18px 40px -12px rgba(0,0,0,0.6), 0 0 0 2px var(--accent)" : "0 0 0 0 transparent",
                  transition: `transform 180ms ${EASE}, box-shadow 180ms ${EASE}`,
                }}
              >
                <img src={src.get(id)} alt="" draggable={false} class="pointer-events-none size-full object-cover" />
              </div>
              <span class="pointer-events-none absolute left-1 top-1 rounded-md bg-black/60 px-1.5 text-xs font-semibold text-white">{place === 0 ? "Main" : place + 1}</span>
            </li>
          );
        })}
      </ul>
      <p class="sr-only" aria-live="polite">
        {said}
      </p>
      {error && <p class="error mt-3">{error}</p>}
      <div class="mt-4 flex flex-wrap gap-2">
        <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={saving || drag !== null} onClick={done}>
          {saving ? "Saving…" : "Done"}
        </motion.button>
        <button
          class="btn btn-text"
          disabled={saving || !changed || drag !== null}
          onClick={() => {
            remember();
            setOrder(photos.map((p) => p.id));
          }}
        >
          Undo changes
        </button>
        <button class="btn btn-text" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
