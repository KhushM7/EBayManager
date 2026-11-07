import { motion } from "framer-motion";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { gradePhoto, type PhotoGrade } from "../photocheck";
import { Icons } from "../ui";
import { centreOn, clampFrame, cropRect, initialFrame, maxZoom, outputSize, turnBox, turnPoint, type Frame } from "./frame";

// Adjust a listing photo: rotate it a quarter turn at a time, then crop and position it, by dragging (one finger
// or the mouse), zooming (two fingers, the scroll wheel or the slider), a frame shape, and "Centre on item". A
// grid shows the middle. Ordinary edits of the photo as it is (frame.ts): nothing is added or painted. Saving
// makes an edited copy; the original is kept, and the photo checks run again on the result.

const SHAPES = [
  { id: "square", label: "Square", hint: "Best for eBay's gallery" },
  { id: "four3", label: "4:3", hint: "" },
  { id: "original", label: "Original", hint: "" },
] as const;
type Shape = (typeof SHAPES)[number]["id"];

const aspectFor = (shape: Shape, w: number, h: number) => (shape === "square" ? 1 : shape === "four3" ? (w >= h ? 4 / 3 : 3 / 4) : w / h);

/** The photo turned clockwise by a number of quarter turns, on a canvas. */
function turned(img: HTMLImageElement, turns: number): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const q = ((turns % 4) + 4) % 4;
  const c = document.createElement("canvas");
  c.width = q % 2 ? h : w;
  c.height = q % 2 ? w : h;
  const ctx = c.getContext("2d")!;
  ctx.translate(q === 1 ? h : q === 2 ? w : 0, q === 2 ? h : q === 3 ? w : 0);
  ctx.rotate((q * Math.PI) / 2);
  ctx.drawImage(img, 0, 0);
  return c;
}

export function PhotoAdjust({ src, onCancel, onSave }: { src: string; onCancel: () => void; onSave: (blob: Blob, grade: PhotoGrade, edits: string[]) => Promise<void> }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [turns, setTurns] = useState(0);
  const shown = useRef<HTMLCanvasElement>(null);
  const source = useMemo(() => (img ? turned(img, turns) : null), [img, turns]);
  const [grade, setGrade] = useState<PhotoGrade | null>(null);
  const [shape, setShape] = useState<Shape>("square");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [view, setView] = useState(320);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  // Load the photo as shown on the listing now, and check it, for "Centre on item". It's loaded straight from
  // the app's own address (allowed by the page's security policy, and same-origin, so it can be cropped on a
  // canvas); a blob: copy was blocked by that policy on the live app (2026-11-07).
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const el = new Image();
        el.src = src;
        await el.decode().catch(() => {
          throw new Error("Couldn't load the photo. Check your connection and try again.");
        });
        if (gone) return;
        setImg(el);
        setFrame(initialFrame(el.naturalWidth, el.naturalHeight, aspectFor("square", el.naturalWidth, el.naturalHeight)));
        // The photo check reads the same file (from the browser's cache) for "Centre on item".
        const res = await fetch(src, { credentials: "same-origin" });
        if (res.ok && !gone) setGrade(await gradePhoto(await res.blob()).catch(() => null));
      } catch (e) {
        if (!gone) setError((e as Error).message);
      }
    })();
    return () => {
      gone = true;
    };
  }, [src]);

  // The frame's on-screen width, for turning finger movement into photo pixels.
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setView(e.contentRect.width));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [img]);

  // The on-screen copy of the (turned) photo.
  useLayoutEffect(() => {
    const c = shown.current;
    if (!c || !source) return;
    c.getContext("2d")!.drawImage(source, 0, 0);
  }, [source, frame !== null]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !saving && onCancel();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [saving]);

  if (error)
    return (
      <Sheet onCancel={onCancel}>
        <p class="error">{error}</p>
      </Sheet>
    );
  if (!img || !frame || !source)
    return (
      <Sheet onCancel={onCancel}>
        <p class="text-muted" role="status">
          Loading the photo…
        </p>
      </Sheet>
    );

  const W = source.width;
  const H = source.height;
  const set = (f: Frame) => setFrame(clampFrame(W, H, f));
  const rect = cropRect(W, H, frame);
  const scale = view / rect.w; // screen px per photo px
  const top = maxZoom(W, H, frame.aspect);
  const out = outputSize(rect);

  const pick = (s: Shape) => {
    setShape(s);
    const aspect = aspectFor(s, W, H);
    set({ ...frame, aspect, zoom: Math.min(frame.zoom, maxZoom(W, H, aspect)) });
  };
  // The photo check ran on the photo before turning, so its centre and outline are turned to match.
  const centre = () => grade && set(centreOn(W, H, frame.aspect, turnPoint(grade.centre, turns), turnBox(grade.box, turns)));
  /** A quarter turn clockwise (1) or anticlockwise (-1); the frame starts again on the turned photo. */
  const turn = (by: 1 | -1) => {
    const next = (turns + by + 4) % 4;
    const w = next % 2 ? img.naturalHeight : img.naturalWidth;
    const h = next % 2 ? img.naturalWidth : img.naturalHeight;
    setTurns(next);
    setFrame(initialFrame(w, h, aspectFor(shape, w, h)));
  };
  const cropped = rect.w < W - 0.5 || rect.h < H - 0.5;
  const edits = [...(turns ? ["rotate"] : []), ...(cropped ? ["crop"] : [])];

  const down = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: frame.zoom };
    }
  };
  const move = (e: PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      set({ ...frame, zoom: pinch.current.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.current.dist)) });
    } else if (pointers.current.size === 1) {
      // Dragging moves the photo under the frame, so the window moves the other way.
      set({ ...frame, cx: frame.cx - (e.clientX - prev.x) / scale, cy: frame.cy - (e.clientY - prev.y) / scale });
    }
  };
  const up = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    set({ ...frame, zoom: frame.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08) });
  };
  const nudge = (e: KeyboardEvent) => {
    const step = 20 / scale;
    const by: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (by[e.key]) (e.preventDefault(), set({ ...frame, cx: frame.cx + by[e.key][0], cy: frame.cy + by[e.key][1] }));
    if (e.key === "+" || e.key === "=") set({ ...frame, zoom: frame.zoom * 1.1 });
    if (e.key === "-") set({ ...frame, zoom: frame.zoom / 1.1 });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const c = document.createElement("canvas");
      c.width = out.w;
      c.height = out.h;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, out.w, out.h);
      const blob = await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't prepare the photo"))), "image/jpeg", 0.9));
      await onSave(blob, await gradePhoto(blob), edits);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Sheet onCancel={saving ? undefined : onCancel}>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <button class="btn btn-secondary h-9 px-3 text-sm" disabled={saving} onClick={() => turn(-1)} aria-label="Rotate left">
          <span aria-hidden="true">↺</span> Rotate left
        </button>
        <button class="btn btn-secondary h-9 px-3 text-sm" disabled={saving} onClick={() => turn(1)} aria-label="Rotate right">
          Rotate right <span aria-hidden="true">↻</span>
        </button>
      </div>
      <div class="mb-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Frame shape">
        {SHAPES.map((s) => (
          <button key={s.id} role="radio" aria-checked={shape === s.id} class={`rounded-full border px-3 py-1.5 text-sm ${shape === s.id ? "border-accent bg-accent-soft text-ink" : "border-line text-muted"}`} onClick={() => pick(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      <div
        ref={box}
        class="relative mx-auto w-full max-w-[520px] cursor-grab touch-none select-none overflow-hidden rounded-xl bg-surface-3 outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
        style={{ aspectRatio: String(frame.aspect) }}
        tabIndex={0}
        aria-label="Photo frame. Drag to move, pinch or scroll to zoom, or use the arrow keys and plus and minus."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={wheel}
        onKeyDown={nudge}
      >
        <canvas
          ref={shown}
          key={turns}
          width={W}
          height={H}
          aria-hidden="true"
          class="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left"
          style={{ width: `${W}px`, height: `${H}px`, transform: `scale(${scale}) translate(${-rect.x}px, ${-rect.y}px)` }}
        />
        {/* Thirds, and a brighter cross for the middle */}
        <svg class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 300 300" preserveAspectRatio="none" aria-hidden="true">
          <g stroke="rgba(255,255,255,0.45)" stroke-width="1" vector-effect="non-scaling-stroke">
            <line x1="100" y1="0" x2="100" y2="300" />
            <line x1="200" y1="0" x2="200" y2="300" />
            <line x1="0" y1="100" x2="300" y2="100" />
            <line x1="0" y1="200" x2="300" y2="200" />
          </g>
          <g stroke="rgba(255,255,255,0.9)" stroke-width="1.5" vector-effect="non-scaling-stroke">
            <line x1="150" y1="138" x2="150" y2="162" />
            <line x1="138" y1="150" x2="162" y2="150" />
          </g>
        </svg>
      </div>

      <label class="mt-4 flex items-center gap-3 text-sm text-muted">
        Zoom
        <input type="range" class="flex-1" min={1} max={top} step={0.01} value={frame.zoom} disabled={top <= 1} onInput={(e) => set({ ...frame, zoom: Number(e.currentTarget.value) })} />
      </label>
      <p class="mt-1 text-xs text-muted">
        Drag to move, pinch or scroll to zoom. The result is {out.w}×{out.h}px
        {Math.max(out.w, out.h) < 1600 ? ": under 1600px, so buyers can zoom in less." : "."}
      </p>
      {error && <p class="error mt-2">{error}</p>}

      <div class="mt-4 flex flex-wrap gap-2">
        <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={saving || edits.length === 0} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </motion.button>
        <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" disabled={saving || !grade} onClick={centre}>
          <Icons.focus size={16} /> Centre on item
        </motion.button>
        <button
          class="btn btn-text"
          disabled={saving}
          onClick={() => {
            setTurns(0);
            setFrame(initialFrame(img.naturalWidth, img.naturalHeight, frame.aspect));
          }}
        >
          Reset
        </button>
        <button class="btn btn-text" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

/** A full-screen sheet over the app, for focused editing. Rendered into the page body, so no animated card around it can shift it. */
export function Sheet({ title = "Adjust photo", onCancel, children }: { title?: string; onCancel?: () => void; children: any }) {
  return createPortal(
    <div class="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.target === e.currentTarget && onCancel?.()}>
      <motion.div data-scroll class="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-line-strong bg-surface p-5 shadow-float sm:rounded-3xl" initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 380, damping: 34 }}>
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg">{title}</h2>
          {onCancel && (
            <button class="btn-link" onClick={onCancel} aria-label="Close">
              <Icons.x size={18} />
            </button>
          )}
        </div>
        {children}
      </motion.div>
    </div>,
    document.body,
  );
}
