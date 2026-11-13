import { animate, AnimatePresence, motion, useAnimationControls, useMotionValue, useReducedMotion } from "framer-motion";
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { tone } from "../camera";
import { gradePhoto, gradePixels, gradeWord, type PhotoGrade } from "../photocheck";
import { EASE_OUT, Icons, SPRING } from "../ui";
import { turnBox, turnPoint } from "./frame";
import {
  centreRect,
  clampRect,
  coverScale,
  fitRatio,
  fullRect,
  lockRatio,
  moveRect,
  outputFor,
  resizeRect,
  sameRect,
  snapRect,
  turnRect,
  zoomRect,
  type AspectId,
  type Handle,
  type Rect,
} from "./geometry";
import { aiNotSetUp, photoAi, PhotoAiError, type AiOp } from "./photoai";
import { ADJUST_RANGE, adjustEdits, applyAdjust, autoAdjust, isNeutral, NO_ADJUST, type Adjust, type AdjustKey } from "./pixels";
import type { TidyOptions } from "./tidy";

// The photo editor (K, 2026-11-13): a full-screen, always-dark editing suite in the spirit of iOS Photos and
// Lightroom. The photo is the hero; tools are icons in three tabs (Crop, Adjust, Magic) whose controls slide up
// above the tab bar (a sidebar on a desktop). Every change is undoable, the original photo is always kept (the
// wizard saves an edited copy the person can switch back from), and the photo checks run again on the result.
//
// - Crop: a free crop box with corner and edge handles, aspect ratios, quarter turns, a straighten dial and
//   auto-centre on the item (geometry.ts).
// - Adjust: brightness, contrast, warmth and sharpness, and Auto (pixels.ts); the preview runs the same maths.
// - Magic: AI background removal, spot removal of clutter and upscaling on the app's AI service (photoai.ts),
//   and the on-device background tidy (tidy.ts, in a worker). Spot removal is for clutter around the item, never
//   marks or wear on it: eBay requires photos to show the actual item.

const PREVIEW_LONG = 1400;
const PAD = 30;
const HANDLES: Handle[] = ["nw", "ne", "sw", "se", "n", "s", "e", "w"];
const ASPECTS: { id: AspectId; label: string }[] = [
  { id: "free", label: "Free" },
  { id: "original", label: "Original" },
  { id: "square", label: "Square" },
  { id: "4:3", label: "4:3" },
  { id: "16:9", label: "16:9" },
];
const ADJUSTS: { key: AdjustKey; label: string; Icon: (p: { size?: number }) => any }[] = [
  { key: "brightness", label: "Brightness", Icon: Icons.sun },
  { key: "contrast", label: "Contrast", Icon: Icons.contrast },
  { key: "warmth", label: "Warmth", Icon: Icons.thermometer },
  { key: "sharpness", label: "Sharpness", Icon: Icons.triangle },
];
type Tab = "crop" | "adjust" | "magic";
const TABS: { id: Tab; label: string; Icon: (p: { size?: number }) => any }[] = [
  { id: "crop", label: "Crop", Icon: Icons.crop },
  { id: "adjust", label: "Adjust", Icon: Icons.sliders },
  { id: "magic", label: "Magic", Icon: Icons.sparkles },
];

interface EditState {
  /** The photo before quarter turns: the original, or the result of the last Magic tool. */
  base: HTMLCanvasElement;
  /** Edits already baked into the base by Magic tools. */
  baseEdits: string[];
  turns: number;
  /** Straighten, degrees (-45..45). */
  angle: number;
  /** In the pixels of the turned photo. */
  crop: Rect;
  aspect: AspectId;
  portrait: boolean;
  adjust: Adjust;
}

// ---------------------------------------------------------------- Canvas helpers

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const buzz = (ms = 8) => {
  try {
    navigator.vibrate?.(ms);
  } catch {}
};

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
const ctx2d = (c: HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: true })!;

/** The base turned clockwise by a number of quarter turns. */
function turnCanvas(src: HTMLCanvasElement, turns: number): HTMLCanvasElement {
  const q = ((turns % 4) + 4) % 4;
  if (!q) return src;
  const w = src.width;
  const h = src.height;
  const c = canvasOf(q % 2 ? h : w, q % 2 ? w : h);
  const ctx = c.getContext("2d")!;
  ctx.translate(q === 1 ? h : q === 2 ? w : 0, q === 2 ? h : q === 3 ? w : 0);
  ctx.rotate((q * Math.PI) / 2);
  ctx.drawImage(src, 0, 0);
  return c;
}

/** Draws the turned photo straightened by `angle`, scaled up to cover its W×H frame. */
function drawGeometry(ctx: CanvasRenderingContext2D, turned: HTMLCanvasElement, angle: number) {
  const W = turned.width;
  const H = turned.height;
  ctx.imageSmoothingQuality = "high";
  if (!angle) return void ctx.drawImage(turned, 0, 0);
  const s = coverScale(angle, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.scale(s, s);
  ctx.drawImage(turned, -W / 2, -H / 2);
}

/** The edited photo: straightened, cropped, sized (long side `long`, or its own pixels up to 2400), adjusted. */
function renderOutput(s: EditState, turned: HTMLCanvasElement, long?: number): HTMLCanvasElement {
  const own = outputFor(s.crop);
  const k = long ? long / Math.max(s.crop.w, s.crop.h) : own.w / s.crop.w;
  const c = canvasOf(s.crop.w * k, s.crop.h * k);
  const ctx = ctx2d(c);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.scale(c.width / s.crop.w, c.height / s.crop.h);
  ctx.translate(-s.crop.x, -s.crop.y);
  drawGeometry(ctx, turned, s.angle);
  ctx.restore();
  if (!isNeutral(s.adjust)) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    applyAdjust(img.data, c.width, c.height, s.adjust, long ? Math.min(1, k) : 1);
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

/** The turned photo's size for a state. */
const turnedSize = (s: EditState) => (s.turns % 2 ? { w: s.base.height, h: s.base.width } : { w: s.base.width, h: s.base.height });

/** The edit names a state's turns, straighten and crop add. */
function geometryEditsOf(s: EditState): string[] {
  const t = turnedSize(s);
  return [...(s.turns ? ["rotate"] : []), ...(s.angle ? ["straighten"] : []), ...(sameRect(s.crop, fullRect(t.w, t.h)) ? [] : ["crop"])];
}

/**
 * The photo exactly as it's been edited so far (turned, straightened, cropped, adjusted), as one image: what the
 * Magic tools work on (K, 2026-11-13), so a background removal or upscale sees the crop and the light the user
 * chose, not the original. The base itself when nothing has been changed on top of it.
 */
function flatten(s: EditState): HTMLCanvasElement {
  return geometryEditsOf(s).length || !isNeutral(s.adjust) ? renderOutput(s, turnCanvas(s.base, s.turns)) : s.base;
}

/** A small JPEG copy of a canvas, for the before/after wipe. */
function snapshot(c: HTMLCanvasElement): string {
  const k = Math.min(1, 1200 / Math.max(c.width, c.height));
  const t = canvasOf(c.width * k, c.height * k);
  t.getContext("2d")!.drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.75);
}

const toBlob = (c: HTMLCanvasElement, type = "image/jpeg", q = 0.9) =>
  new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't prepare the photo"))), type, q));

/** A photo from bytes as a canvas; a transparent one (a removed background) goes onto pure white. */
async function canvasFromBlob(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const c = canvasOf(bmp.width, bmp.height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

/** The photo check on a canvas, measured on a 320px copy (as photocheck.ts does) but judged at `w`×`h`. */
function gradeCanvas(c: HTMLCanvasElement, w = c.width, h = c.height): PhotoGrade {
  const s = 320 / Math.max(c.width, c.height);
  const small = canvasOf(c.width * s, c.height * s);
  const ctx = ctx2d(small);
  ctx.drawImage(c, 0, 0, small.width, small.height);
  return gradePixels(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height, w, h);
}

// ---------------------------------------------------------------- On-device tidy (in a worker)

let worker: Worker | null | undefined;
let jobId = 0;
async function runTidy(data: Uint8ClampedArray, w: number, h: number, opts: TidyOptions): Promise<{ data: Uint8ClampedArray; w: number; h: number; edits: string[] } | { refused: string }> {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL("./magic.worker.ts", import.meta.url), { type: "module" });
    } catch {
      worker = null;
    }
  }
  if (worker) {
    const w0 = worker;
    const id = ++jobId;
    try {
      return await new Promise((ok, no) => {
        const onMsg = (e: MessageEvent) => {
          if (e.data?.id !== id) return;
          w0.removeEventListener("message", onMsg);
          w0.removeEventListener("error", onErr);
          if (e.data.error) no(new Error(e.data.error));
          else ok(e.data);
        };
        const onErr = () => (w0.removeEventListener("message", onMsg), w0.removeEventListener("error", onErr), no(new Error("worker")));
        w0.addEventListener("message", onMsg);
        w0.addEventListener("error", onErr);
        w0.postMessage({ id, data, w, h, opts }, [data.buffer]);
      });
    } catch (e) {
      if ((e as Error).message !== "worker") throw e;
      worker = null; // fall through to the main thread; the pixels were transferred, so the caller re-reads them
      throw new Error("retry");
    }
  }
  // Main-thread fallback: give the animation a frame first.
  await new Promise((r) => setTimeout(r, 60));
  const { tidy } = await import("./tidy");
  const r = tidy({ data, w, h }, opts);
  return "refused" in r ? r : { data: r.image.data, w: r.image.w, h: r.image.h, edits: r.edits };
}

// ---------------------------------------------------------------- The editor

/** How long the editor takes to fade away when it closes. */
const CLOSE_MS = 220;

/**
 * The editor closes itself: on Cancel, or once onSave has finished, it stops taking taps at once, fades out and
 * then calls onClose so the parent unmounts it. Not left to AnimatePresence: on production its exit never
 * reported finishing inside this portal, so an invisible full-screen layer stayed over the page and swallowed
 * every tap (2026-11-13).
 */
export function PhotoEditor({ src, onClose, onSave }: { src: string; onClose: () => void; onSave: (blob: Blob, grade: PhotoGrade, edits: string[]) => Promise<void> }) {
  const [boot, setBoot] = useState<{ base: HTMLCanvasElement; grade: PhotoGrade | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    document.body.style.overflow = "";
    setTimeout(onClose, CLOSE_MS);
  };
  const onCancel = close;
  const save = async (blob: Blob, grade: PhotoGrade, edits: string[]) => {
    await onSave(blob, grade, edits);
    close();
  };

  // Loaded straight from the app's own address (same-origin, allowed by the page's security policy), so it can be
  // read back from a canvas; a blob: copy is blocked by that policy on the live app (2026-11-07).
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const el = new Image();
        el.src = src;
        await el.decode().catch(() => {
          throw new Error("Couldn't load the photo. Check your connection and try again.");
        });
        const base = canvasOf(el.naturalWidth, el.naturalHeight);
        base.getContext("2d")!.drawImage(el, 0, 0);
        let grade: PhotoGrade | null = null;
        try {
          const res = await fetch(src, { credentials: "same-origin" });
          if (res.ok) grade = await gradePhoto(await res.blob());
        } catch {}
        if (!gone) setBoot({ base, grade: grade ?? gradeCanvas(base) });
      } catch (e) {
        if (!gone) setError((e as Error).message);
      }
    })();
    return () => {
      gone = true;
    };
  }, [src]);

  // No scrolling the page underneath.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <motion.div
      class="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#09090b] text-white select-none"
      role="dialog"
      aria-modal="true"
      aria-label="Edit photo"
      style={{ pointerEvents: closing ? "none" : undefined }}
      initial={{ opacity: 0 }}
      animate={{ opacity: closing ? 0 : 1, scale: closing ? 0.985 : 1 }}
      transition={{ duration: closing ? CLOSE_MS / 1000 : 0.25, ease: EASE_OUT }}
    >
      {boot ? (
        <EditorBody src={src} initialBase={boot.base} initialGrade={boot.grade} onCancel={onCancel} onSave={save} />
      ) : (
        <div class="flex flex-1 flex-col">
          <div class="flex h-14 items-center px-3" style={{ paddingTop: "env(safe-area-inset-top)" }}>
            <button class="rounded-full px-3 py-2 text-sm font-medium text-white/75 hover:text-white" onClick={onCancel}>
              Cancel
            </button>
          </div>
          <div class="grid flex-1 place-items-center px-6 text-center">
            {error ? (
              <p class="max-w-xs text-sm text-[#ff8a8e]">{error}</p>
            ) : (
              <div class="flex flex-col items-center gap-4" role="status">
                <span class="size-9 animate-spin rounded-full border-2 border-white/15 border-t-[var(--accent)]" />
                <span class="text-sm text-white/60">Opening the photo…</span>
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>,
    document.body,
  );
}

interface Busy {
  label: string;
  op: AiOp | "tidy" | "whiten";
  ai: boolean;
}
interface ToastState {
  id: number;
  tone: "info" | "good" | "warn" | "bad";
  text: string;
  action?: { label: string; run: () => void };
}
interface Stroke {
  size: number;
  pts: [number, number][];
}

function EditorBody({ src, initialBase, initialGrade, onCancel, onSave }: { src: string; initialBase: HTMLCanvasElement; initialGrade: PhotoGrade | null; onCancel: () => void; onSave: (blob: Blob, grade: PhotoGrade, edits: string[]) => Promise<void> }) {
  const reduce = useReducedMotion();
  const initial: EditState = useMemo(
    () => ({ base: initialBase, baseEdits: [], turns: 0, angle: 0, crop: fullRect(initialBase.width, initialBase.height), aspect: "free", portrait: initialBase.height > initialBase.width, adjust: NO_ADJUST }),
    [],
  );
  const [hist, setHist] = useState<{ stack: EditState[]; i: number }>({ stack: [initial], i: 0 });
  const present = hist.stack[hist.i];
  const [live, setLive] = useState<Partial<EditState> | null>(null);
  const cur: EditState = live ? { ...present, ...live } : present;
  const curRef = useRef(cur);
  curRef.current = cur;

  const commit = (patch: Partial<EditState>) => {
    setLive(null);
    setHist((h) => {
      const stack = [...h.stack.slice(0, h.i + 1), { ...h.stack[h.i], ...patch }].slice(-40);
      return { stack, i: stack.length - 1 };
    });
  };
  const canUndo = hist.i > 0;
  const canRedo = hist.i < hist.stack.length - 1;
  const undo = () => canUndo && (setLive(null), setHist((h) => ({ ...h, i: h.i - 1 })));
  const redo = () => canRedo && (setLive(null), setHist((h) => ({ ...h, i: h.i + 1 })));

  const [tab, setTab] = useState<Tab>("crop");
  const [brush, setBrush] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [waking, setWaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [wipe, setWipe] = useState<{ url: string; same: boolean } | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [aiOff, setAiOff] = useState(aiNotSetUp());
  const abort = useRef<AbortController | null>(null);
  const say = (t: Omit<ToastState, "id">, ms = 3800) => {
    const id = Date.now() + Math.random();
    setToast({ ...t, id });
    setTimeout(() => setToast((x) => (x?.id === id ? null : x)), ms);
  };

  // ---- The photo as edited, at preview size
  const turned = useMemo(() => turnCanvas(cur.base, cur.turns), [cur.base, cur.turns]);
  const W = turned.width;
  const H = turned.height;
  const p = Math.min(1, PREVIEW_LONG / Math.max(W, H));
  const geom = useMemo(() => {
    const c = canvasOf(W * p, H * p);
    const ctx = ctx2d(c);
    ctx.scale(c.width / W, c.height / H);
    drawGeometry(ctx, turned, cur.angle);
    return ctx.getImageData(0, 0, c.width, c.height);
  }, [turned, cur.angle]);

  // ---- The workspace's size, and where the photo sits in it
  const ws = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!ws.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ws.current);
    return () => ro.disconnect();
  }, []);
  const shown = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = shown.current;
    if (!c) return;
    const frame = requestAnimationFrame(() => {
      if (c.width !== geom.width || c.height !== geom.height) (c.width = geom.width), (c.height = geom.height);
      const img = isNeutral(cur.adjust) ? geom : new ImageData(new Uint8ClampedArray(geom.data), geom.width, geom.height);
      if (img !== geom) applyAdjust(img.data, img.width, img.height, cur.adjust, p);
      c.getContext("2d")!.putImageData(img, 0, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [geom, cur.adjust, brush, size.w > 0]);
  const k = size.w ? Math.max(0.01, Math.min((size.w - 2 * PAD) / W, (size.h - 2 * PAD) / H)) : 0.01;
  const boxW = W * k;
  const boxH = H * k;
  const left = (size.w - boxW) / 2;
  const top = (size.h - boxH) / 2;
  // Outside the Crop tab, the view zooms to the crop so the result fills the screen.
  const zoomed = tab !== "crop" && size.w > 0;
  const z = zoomed ? Math.min((size.w - 2 * PAD) / (cur.crop.w * k), (size.h - 2 * PAD) / (cur.crop.h * k)) : 1;
  const tx = zoomed ? size.w / 2 - left - (cur.crop.x + cur.crop.w / 2) * k * z : 0;
  const ty = zoomed ? size.h / 2 - top - (cur.crop.y + cur.crop.h / 2) * k * z : 0;

  // ---- The score: the photo check on the edited result, a moment after each change
  const [grade, setGrade] = useState<PhotoGrade | null>(initialGrade);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const out = outputFor(present.crop);
        setGrade(gradeCanvas(renderOutput(present, turnCanvas(present.base, present.turns), 320), out.w, out.h));
      } catch {}
    }, 700);
    return () => clearTimeout(t);
  }, [present]);
  // The base photo's own check, for "Auto-centre" (where the item is).
  const baseGrade = useMemo(() => (cur.base === initialBase && initialGrade ? initialGrade : gradeCanvas(cur.base)), [cur.base]);

  // ---- Crop gestures
  const ratio = lockRatio(cur.aspect, W, H, cur.portrait);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ mode: "move" | "resize" | "pinch"; handle?: Handle; sx: number; sy: number; start: Rect; dist?: number } | null>(null);
  const overlay = useAnimationControls();

  const finishCrop = (c: Rect) => {
    let rect = c;
    if (cur.aspect === "free") {
      const snap = snapRect(rect, W, H);
      if (snap) {
        rect = snap.rect;
        buzz();
        overlay.start({ scale: [1, 1.025, 0.995, 1], transition: { duration: 0.42, ease: EASE_OUT } });
      }
      const r = rect.w / rect.h;
      if (r > 2 || r < 0.5)
        say({ tone: "info", text: r > 2 ? "Very wide. Square suits eBay's gallery." : "Very tall. Square suits eBay's gallery.", action: { label: "Make square", run: () => pickAspect("square") } });
    }
    if (sameRect(rect, present.crop)) setLive(null);
    else commit({ crop: rect });
  };

  const down = (e: PointerEvent) => {
    if (tab !== "crop" || busy || saving) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const c = curRef.current.crop;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { mode: "pinch", sx: 0, sy: 0, start: c, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    } else {
      const h = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset.handle as Handle | undefined;
      gesture.current = { mode: h ? "resize" : "move", handle: h, sx: e.clientX, sy: e.clientY, start: c };
    }
    setInteracting(true);
  };
  const move = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g.mode === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      setLive({ crop: zoomRect(g.start, Math.hypot(a.x - b.x, a.y - b.y) / g.dist!, W, H) });
      return;
    }
    const dx = (e.clientX - g.sx) / k;
    const dy = (e.clientY - g.sy) / k;
    setLive({ crop: g.mode === "move" ? moveRect(g.start, dx, dy, W, H) : resizeRect(g.start, g.handle!, dx, dy, W, H, ratio) });
  };
  const up = (e: PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size === 1 && gesture.current?.mode === "pinch") {
      // One finger lifted from a pinch: carry on as a move from here.
      const [only] = [...pointers.current.values()];
      gesture.current = { mode: "move", sx: only.x, sy: only.y, start: curRef.current.crop };
      return;
    }
    if (pointers.current.size) return;
    gesture.current = null;
    setInteracting(false);
    finishCrop(curRef.current.crop);
  };
  const wheelTimer = useRef<number | undefined>(undefined);
  const wheel = (e: WheelEvent) => {
    if (tab !== "crop" || busy) return;
    e.preventDefault();
    const next = zoomRect(curRef.current.crop, e.deltaY < 0 ? 1.06 : 1 / 1.06, W, H);
    setLive({ crop: next });
    setInteracting(true);
    clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => (setInteracting(false), commit({ crop: curRef.current.crop })), 280);
  };

  const pickAspect = (id: AspectId) => {
    const c = curRef.current;
    const flip = id === c.aspect && (id === "4:3" || id === "16:9");
    const portrait = flip ? !c.portrait : id === c.aspect ? c.portrait : c.crop.h > c.crop.w;
    const r = lockRatio(id, W, H, portrait);
    commit({ aspect: id, portrait, crop: r == null ? c.crop : fitRatio(c.crop, r, W, H) });
  };
  const turn = (by: 1 | -1) => {
    const c = curRef.current;
    commit({ turns: (c.turns + by + 4) % 4, crop: turnRect(c.crop, W, H, by), portrait: !c.portrait });
  };
  const autoCentre = () => {
    const c = curRef.current;
    const r = ratio ?? 1;
    commit({ crop: centreRect(W, H, r, turnPoint(baseGrade.centre, c.turns), turnBox(baseGrade.box, c.turns)) });
    overlay.start({ scale: [1, 1.02, 1], transition: { duration: 0.4, ease: EASE_OUT } });
  };
  const resetGeometry = () => {
    const b = curRef.current.base;
    commit({ turns: 0, angle: 0, crop: fullRect(b.width, b.height), aspect: "free", portrait: b.height > b.width });
  };

  // ---- Adjust
  const [adjustKey, setAdjustKey] = useState<AdjustKey>("brightness");
  const autoRun = useRef<{ stop: () => void } | null>(null);
  const autoEnhance = () => {
    const target = autoAdjust(geom.data, geom.width, geom.height);
    const from = { ...curRef.current.adjust };
    autoRun.current?.stop();
    if (reduce) return commit({ adjust: target });
    autoRun.current = animate(0, 1, {
      duration: 0.7,
      ease: EASE_OUT,
      onUpdate: (t) => {
        const a = {} as Adjust;
        for (const key of Object.keys(target) as AdjustKey[]) a[key] = Math.round(from[key] + (target[key] - from[key]) * t);
        setLive({ adjust: a });
      },
      onComplete: () => commit({ adjust: target }),
    });
    say({ tone: "good", text: "Auto-enhanced: light, contrast and colour balanced." }, 2600);
  };

  // ---- Magic
  /**
   * A Magic result becomes the new photo. It was made from the flattened edit (`input`), so the turns, straighten,
   * crop and adjustments are now part of it: they reset, and their names carry over into the record. Undo still
   * steps back to before it.
   */
  const applyBase = async (next: HTMLCanvasElement, input: HTMLCanvasElement, edits: string[]) => {
    const c = curRef.current;
    const same = Math.abs(next.width / next.height - input.width / input.height) < 0.005;
    try {
      // The old picture is the flattened edit, framed exactly like the result: a wipe when the shape is the same.
      setWipe({ url: snapshot(input), same });
    } catch {}
    commit({
      base: next,
      baseEdits: [...new Set([...c.baseEdits, ...geometryEditsOf(c), ...adjustEdits(c.adjust), ...edits])],
      turns: 0,
      angle: 0,
      crop: fullRect(next.width, next.height),
      adjust: NO_ADJUST,
      ...(same ? {} : { aspect: "free" as AspectId }),
    });
  };

  const runMagic = async (op: Busy["op"], mask?: Blob, from?: HTMLCanvasElement) => {
    if (busy) return;
    const ai = op === "remove_background" || op === "erase" || op === "upscale";
    const labels: Record<Busy["op"], string> = { remove_background: "Removing the background", erase: "Removing clutter", upscale: "Enhancing detail", tidy: "Tidying the background", whiten: "Whitening the background" };
    setBusy({ op, ai, label: labels[op] });
    setWaking(false);
    const started = Date.now();
    const wakeTimer = ai ? window.setTimeout(() => setWaking(true), 6000) : undefined;
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      // What the user sees now, as one image (the brush paints on the same image, so its mask lines up).
      const base = from ?? flatten(curRef.current);
      if (ai) {
        const { blob, edit } = await photoAi(op as AiOp, await toBlob(base, "image/jpeg", 0.92), { mask, signal: ctl.signal });
        const next = await canvasFromBlob(blob);
        await new Promise((r) => setTimeout(r, Math.max(0, 900 - (Date.now() - started))));
        if (ctl.signal.aborted) return;
        await applyBase(next, base, [edit]);
        if (op === "erase") (setStrokes([]), setBrush(false));
        say({ tone: "good", text: op === "remove_background" ? "Background removed." : op === "erase" ? "Clutter removed." : next.width === base.width && next.height === base.height ? "Detail enhanced." : `Upscaled to ${next.width} × ${next.height}.` }, 2600);
      } else {
        const opts: TidyOptions = op === "whiten" ? { balance: false, crop: false } : {};
        const read = () => ctx2d(base).getImageData(0, 0, base.width, base.height).data;
        let r;
        try {
          r = await runTidy(read(), base.width, base.height, opts);
        } catch (e) {
          if ((e as Error).message !== "retry") throw e;
          r = await runTidy(read(), base.width, base.height, opts);
        }
        await new Promise((res) => setTimeout(res, Math.max(0, 1100 - (Date.now() - started))));
        if (ctl.signal.aborted) return;
        if ("refused" in r) return say({ tone: "warn", text: r.refused }, 5200);
        const next = canvasOf(r.w, r.h);
        next.getContext("2d")!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), 0, 0);
        await applyBase(next, base, r.edits);
        say({ tone: "good", text: op === "whiten" ? "Background whitened." : "Background tidied. Nothing on the item was changed." }, 2600);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError" || ctl.signal.aborted) return;
      if (e instanceof PhotoAiError && e.code === "not_set_up") {
        setAiOff(true);
        say({ tone: "warn", text: "AI tools aren't set up yet." });
      } else say({ tone: "bad", text: (e as Error).message || "That didn't work. Nothing was changed." }, 5200);
    } finally {
      clearTimeout(wakeTimer);
      if (abort.current === ctl) abort.current = null;
      setBusy(null);
      setWaking(false);
    }
  };
  const cancelBusy = () => {
    abort.current?.abort();
    setBusy(null);
    setWaking(false);
  };

  // ---- Spot remove: brush strokes on the base photo
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [brushSize, setBrushSize] = useState(36);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const brushCanvas = useRef<HTMLCanvasElement>(null);
  /** The flattened edit the brush paints on (and erase is sent), made when the brush opens. */
  const [brushSrc, setBrushSrc] = useState<HTMLCanvasElement | null>(null);
  const bsrc = (brush && brushSrc) || cur.base;
  const BW = bsrc.width;
  const BH = bsrc.height;
  const kb = size.w ? Math.max(0.01, Math.min((size.w - 2 * PAD) / BW, (size.h - 2 * PAD) / BH)) : 0.01;
  useLayoutEffect(() => {
    const c = brushCanvas.current;
    if (!c || !brush) return;
    const pb = Math.min(1, PREVIEW_LONG / Math.max(BW, BH));
    c.width = Math.round(BW * pb);
    c.height = Math.round(BH * pb);
    c.getContext("2d")!.drawImage(bsrc, 0, 0, c.width, c.height);
  }, [brush, bsrc]);
  const painting = useRef(false);
  const toBase = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * BW, ((e.clientY - r.top) / r.height) * BH] as [number, number];
  };
  const paintDown = (e: PointerEvent) => {
    if (busy) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    painting.current = true;
    setStrokes((s) => [...s, { size: brushSize / kb, pts: [toBase(e)] }]);
  };
  const paintMove = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
    if (!painting.current) return;
    const pt = toBase(e);
    setStrokes((s) => {
      if (!s.length) return s;
      const last = s[s.length - 1];
      const prev = last.pts[last.pts.length - 1];
      if (Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) < last.size / 6) return s;
      return [...s.slice(0, -1), { ...last, pts: [...last.pts, pt] }];
    });
  };
  const paintUp = () => (painting.current = false);
  const applyErase = async () => {
    const m = canvasOf(BW, BH);
    const ctx = m.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, BW, BH);
    ctx.strokeStyle = ctx.fillStyle = "#fff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes) {
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.arc(s.pts[0][0], s.pts[0][1], s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      if (s.pts.length > 1) {
        ctx.beginPath();
        ctx.moveTo(s.pts[0][0], s.pts[0][1]);
        for (const pt of s.pts.slice(1)) ctx.lineTo(pt[0], pt[1]);
        ctx.stroke();
      }
    }
    await runMagic("erase", await toBlob(m, "image/png"), bsrc);
  };

  // ---- Saving
  const geometryEdits = [...(cur.turns ? ["rotate"] : []), ...(cur.angle ? ["straighten"] : []), ...(sameRect(cur.crop, fullRect(W, H)) ? [] : ["crop"])];
  const edits = [...new Set([...cur.baseEdits, ...geometryEdits, ...adjustEdits(cur.adjust)])];
  const out = outputFor(cur.crop);
  const save = async () => {
    if (!edits.length || saving) return;
    setSaving(true);
    try {
      const c = renderOutput(present, turnCanvas(present.base, present.turns));
      const blob = await toBlob(c, "image/jpeg", 0.9);
      await onSave(blob, await gradePhoto(blob), edits);
    } catch (e) {
      say({ tone: "bad", text: (e as Error).message || "Couldn't save the photo." }, 5200);
      setSaving(false);
    }
  };

  // ---- Keyboard
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (saving) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") return busy ? cancelBusy() : brush ? setBrush(false) : onCancel();
    if (mod && e.key.toLowerCase() === "z") return e.preventDefault(), e.shiftKey ? redo() : undo();
    if (mod && e.key.toLowerCase() === "y") return e.preventDefault(), redo();
    if (tab === "crop" && !busy && e.key.startsWith("Arrow") && !(e.target as HTMLElement)?.closest?.("[role=slider]")) {
      e.preventDefault();
      const step = (e.shiftKey ? 40 : 10) / k;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (d[e.key]) commit({ crop: moveRect(curRef.current.crop, d[e.key][0], d[e.key][1], W, H) });
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, []);

  const dim = tab === "crop" ? 0.62 : 0.97;
  const resTone = Math.max(out.w, out.h) >= 1600 ? "var(--green)" : Math.max(out.w, out.h) >= 500 ? "var(--yellow)" : "var(--red)";
  const locked = Boolean(busy) || saving;

  return (
    <>
      {/* ---- Top bar ---- */}
      <motion.header
        class="relative z-20 grid h-14 flex-none grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 sm:px-4"
        style={{ paddingTop: "env(safe-area-inset-top)", boxSizing: "content-box" }}
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -16, opacity: 0 }}
        transition={{ ...SPRING, delay: 0.05 }}
      >
        <div>
          <button class="rounded-full px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:text-white disabled:opacity-40" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div class="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1">
          <IconButton label="Undo" disabled={!canUndo || locked} onClick={undo}>
            <Icons.undo size={18} />
          </IconButton>
          <IconButton label="Redo" disabled={!canRedo || locked} onClick={redo}>
            <Icons.redo size={18} />
          </IconButton>
          <span class="mx-0.5 h-5 w-px bg-white/10" />
          <motion.button
            whileTap={{ scale: 0.9 }}
            class={`grid size-9 place-items-center rounded-full transition-colors ${comparing ? "bg-white text-black" : "text-white/80 hover:bg-white/10"}`}
            aria-label="Hold to see the original"
            title="Hold to see the original"
            onPointerDown={(e: PointerEvent) => ((e.currentTarget as HTMLElement).setPointerCapture(e.pointerId), setComparing(true))}
            onPointerUp={() => setComparing(false)}
            onPointerCancel={() => setComparing(false)}
            onKeyDown={(e: KeyboardEvent) => e.key === " " && (e.preventDefault(), setComparing(true))}
            onKeyUp={() => setComparing(false)}
          >
            <Icons.compare size={18} />
          </motion.button>
        </div>
        <div class="flex items-center justify-end gap-2">
          <ScoreRing score={grade?.score ?? null} />
          <motion.button
            whileTap={{ scale: 0.94 }}
            class="relative h-9 rounded-full bg-white px-4 text-sm font-semibold text-black shadow-[0_0_24px_-6px_rgba(255,255,255,0.55)] transition-opacity disabled:opacity-35 disabled:shadow-none"
            disabled={!edits.length || locked}
            onClick={save}
          >
            {saving ? (
              <span class="flex items-center gap-2">
                <span class="size-3.5 animate-spin rounded-full border-2 border-black/20 border-t-black" /> Saving
              </span>
            ) : (
              "Done"
            )}
          </motion.button>
        </div>
      </motion.header>

      <div class="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* ---- Workspace ---- */}
        <div ref={ws} class="relative min-h-0 flex-1 overflow-hidden touch-none" onWheel={brush ? undefined : wheel}>
          {/* A soft glow behind the photo */}
          <div class="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(60% 50% at 50% 50%, rgba(91,140,255,0.08), transparent 70%)" }} />

          {size.w > 0 && !brush && (
            <motion.div
              class="absolute"
              style={{ left, top, width: boxW, height: boxH, transformOrigin: "0 0" }}
              initial={{ opacity: 0, scale: 0.94, filter: "blur(8px)" }}
              animate={{ opacity: 1, x: tx, y: ty, scale: z, filter: "blur(0px)" }}
              transition={{ duration: 0.5, ease: EASE_OUT }}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            >
              <canvas ref={shown} class="pointer-events-none absolute inset-0 size-full" aria-hidden="true" />

              {/* The wipe from the old photo to a Magic result */}
              <AnimatePresence>
                {wipe && (
                  <motion.div key={wipe.url.length} class="pointer-events-none absolute inset-0" initial={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    {wipe.same ? (
                      <>
                        <motion.img src={wipe.url} alt="" class="absolute inset-0 size-full" initial={{ clipPath: "inset(0 0 0 0%)" }} animate={{ clipPath: "inset(0 0 0 100%)" }} transition={{ duration: 0.9, ease: EASE_OUT }} onAnimationComplete={() => setWipe(null)} />
                        <motion.div class="absolute inset-y-0 w-0.5 bg-white" style={{ boxShadow: "0 0 18px 4px rgba(255,255,255,.6), 0 0 40px 10px var(--glow)" }} initial={{ left: "0%", opacity: 1 }} animate={{ left: "100%", opacity: [1, 1, 0] }} transition={{ duration: 0.9, ease: EASE_OUT }} />
                      </>
                    ) : (
                      <motion.img src={wipe.url} alt="" class="absolute inset-0 size-full object-contain" initial={{ opacity: 1, scale: 1 }} animate={{ opacity: 0, scale: 1.04 }} transition={{ duration: 0.6, ease: EASE_OUT }} onAnimationComplete={() => setWipe(null)} />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* The crop box */}
              <motion.div
                animate={overlay}
                class="absolute"
                style={{ left: cur.crop.x * k, top: cur.crop.y * k, width: cur.crop.w * k, height: cur.crop.h * k }}
              >
                <div class="pointer-events-none absolute inset-0 transition-[box-shadow] duration-500" style={{ boxShadow: `0 0 0 9999px rgba(9,9,11,${dim})` }} />
                <AnimatePresence>
                  {tab === "crop" && (
                    <motion.div class="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                      <div class="pointer-events-none absolute inset-0 border border-white/70" />
                      {/* Rule of thirds, only while moving it */}
                      <motion.div class="pointer-events-none absolute inset-0" animate={{ opacity: interacting ? 1 : 0 }} transition={{ duration: 0.2 }}>
                        <div class="absolute inset-y-0 left-1/3 w-px bg-white/40" />
                        <div class="absolute inset-y-0 left-2/3 w-px bg-white/40" />
                        <div class="absolute inset-x-0 top-1/3 h-px bg-white/40" />
                        <div class="absolute inset-x-0 top-2/3 h-px bg-white/40" />
                      </motion.div>
                      <div class="absolute inset-0 cursor-move" />
                      {HANDLES.map((h) => (
                        <CropHandle key={h} handle={h} />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>

              {/* Working: a shimmer sweeps over the photo */}
              <AnimatePresence>
                {busy && (
                  <motion.div class="pointer-events-none absolute inset-0 overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                    <motion.div class="absolute inset-0 bg-black/25" animate={reduce ? {} : { opacity: [0.6, 1, 0.6] }} transition={{ duration: 1.8, repeat: Infinity }} />
                    {!reduce && (
                      <motion.div
                        class="absolute inset-y-[-30%] w-[55%]"
                        style={{ background: "linear-gradient(100deg, transparent 0%, rgba(255,255,255,0) 20%, rgba(255,255,255,0.32) 50%, rgba(165,190,255,0.18) 60%, transparent 80%)", rotate: "12deg" }}
                        initial={{ left: "-60%" }}
                        animate={{ left: "120%" }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: [0.65, 0, 0.35, 1], repeatDelay: 0.15 }}
                      />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {/* Spot remove: the base photo, painted over */}
          <AnimatePresence>
            {size.w > 0 && brush && (
              <motion.div
                class="absolute cursor-none"
                style={{ left: (size.w - BW * kb) / 2, top: (size.h - BH * kb) / 2, width: BW * kb, height: BH * kb }}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.3, ease: EASE_OUT }}
                onPointerDown={paintDown}
                onPointerMove={paintMove}
                onPointerUp={paintUp}
                onPointerCancel={paintUp}
                onPointerLeave={() => setCursor(null)}
              >
                <canvas ref={brushCanvas} class="pointer-events-none absolute inset-0 size-full rounded-sm" aria-hidden="true" />
                <svg class="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${BW} ${BH}`} aria-hidden="true">
                  <g stroke="var(--accent)" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.55">
                    {strokes.map((s, i) =>
                      s.pts.length > 1 ? (
                        <path key={i} d={s.pts.map(([x, y], j) => `${j ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} stroke-width={s.size} />
                      ) : (
                        <circle key={i} cx={s.pts[0][0]} cy={s.pts[0][1]} r={s.size / 2} fill="var(--accent)" stroke="none" />
                      ),
                    )}
                  </g>
                </svg>
                {cursor && !busy && (
                  <div class="pointer-events-none absolute rounded-full border-2 border-white" style={{ left: cursor.x - brushSize / 2, top: cursor.y - brushSize / 2, width: brushSize, height: brushSize, boxShadow: "0 0 0 1px rgba(0,0,0,.4), 0 0 16px var(--glow)" }} />
                )}
                <AnimatePresence>
                  {busy && (
                    <motion.div class="pointer-events-none absolute inset-0 overflow-hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <div class="absolute inset-0 bg-black/30" />
                      {!reduce && (
                        <motion.div
                          class="absolute inset-y-[-30%] w-[55%]"
                          style={{ background: "linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.3) 50%, transparent 80%)", rotate: "12deg" }}
                          initial={{ left: "-60%" }}
                          animate={{ left: "120%" }}
                          transition={{ duration: 1.5, repeat: Infinity, ease: [0.65, 0, 0.35, 1] }}
                        />
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Hold to compare: the original photo */}
          <AnimatePresence>
            {comparing && (
              <motion.div class="pointer-events-none absolute inset-0 bg-[#09090b]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                <img src={src} alt="The original photo" class="absolute object-contain" style={{ left: PAD, top: PAD, width: `calc(100% - ${PAD * 2}px)`, height: `calc(100% - ${PAD * 2}px)` }} />
                <span class="absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur-md">Original</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* The size it will be saved at */}
          {!brush && (
            <div class="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-white/85 backdrop-blur-md">
              <span class="size-1.5 rounded-full" style={{ background: resTone, boxShadow: `0 0 8px ${resTone}` }} />
              {out.w} × {out.h}
            </div>
          )}

          {/* Status while a Magic tool works */}
          <AnimatePresence>
            {busy && (
              <motion.div
                class="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-3 rounded-full border border-white/12 bg-[rgba(18,20,28,0.82)] py-1.5 pr-1.5 pl-3.5 text-sm shadow-[0_18px_40px_-16px_rgba(0,0,0,0.8)] backdrop-blur-xl"
                initial={{ opacity: 0, y: 12, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                transition={SPRING}
                role="status"
              >
                <span class="size-4 flex-none animate-spin rounded-full border-2 border-white/15 border-t-[var(--accent)]" />
                {/* Keyed so the new text rises in; no exit wait (mode="wait" could leave it blank). */}
                <motion.span key={waking ? "w" : "b"} class="min-w-0 truncate font-medium" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
                  {waking ? "Waking the AI tools, the first edit takes up to a minute" : `${busy.label}…`}
                </motion.span>
                {busy.ai && (
                  <button class="flex-none rounded-full bg-white/10 px-3 py-1 text-xs font-semibold hover:bg-white/15" onClick={cancelBusy}>
                    Cancel
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Transient messages */}
          <AnimatePresence>
            {toast && (
              <motion.div
                key={toast.id}
                class="absolute top-3 left-1/2 z-10 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2.5 rounded-2xl border border-white/12 bg-[rgba(18,20,28,0.85)] py-2 pr-2 pl-3 text-sm shadow-[0_18px_40px_-16px_rgba(0,0,0,0.8)] backdrop-blur-xl"
                initial={{ opacity: 0, y: -12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.97 }}
                transition={SPRING}
                role="status"
              >
                <span class="grid size-5 flex-none place-items-center rounded-full bg-white/10" style={{ color: toast.tone === "good" ? "var(--green)" : toast.tone === "bad" ? "var(--red)" : toast.tone === "warn" ? "var(--yellow)" : "var(--accent)" }}>
                  {toast.tone === "good" ? <Icons.check size={12} /> : toast.tone === "info" ? <Icons.sparkles size={12} /> : <Icons.alert size={12} />}
                </span>
                <span class={toast.action ? "" : "pr-1.5"}>{toast.text}</span>
                {toast.action && (
                  <button class="flex-none rounded-full bg-white px-3 py-1 text-xs font-semibold text-black" onClick={() => (toast.action!.run(), setToast(null))}>
                    {toast.action.label}
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ---- Tools: a sheet above the tab bar on a phone, a sidebar on a desktop ---- */}
        <motion.aside
          class="relative z-10 flex flex-none flex-col-reverse border-t border-white/[0.07] bg-[#0d0e12]/90 backdrop-blur-xl md:w-[340px] md:flex-col md:border-t-0 md:border-l"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          transition={{ ...SPRING, delay: 0.08 }}
        >
          <nav class="flex flex-none items-center justify-around gap-1 px-3 py-2 md:justify-start md:border-b md:border-white/[0.07] md:px-4 md:py-3" aria-label="Tools">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <motion.button
                  key={t.id}
                  whileTap={{ scale: 0.92 }}
                  class={`relative flex min-w-20 flex-col items-center gap-1 rounded-2xl px-4 py-2 text-[11px] font-semibold transition-colors md:min-w-0 md:flex-1 ${active ? "text-white" : "text-white/50 hover:text-white/80"}`}
                  aria-pressed={active}
                  disabled={locked}
                  onClick={() => {
                    if (brush) setBrush(false);
                    setTab(t.id);
                  }}
                >
                  {active && <motion.span layoutId="editor-tab" class="absolute inset-0 rounded-2xl border border-white/10 bg-white/[0.08]" transition={SPRING} />}
                  <span class="relative" style={active ? { filter: "drop-shadow(0 0 8px var(--glow))" } : undefined}>
                    <t.Icon size={20} />
                  </span>
                  <span class="relative">{t.label}</span>
                </motion.button>
              );
            })}
          </nav>

          <div class="relative h-[156px] flex-none overflow-hidden md:h-auto md:flex-1">
            {/* A crossfade: the panels are stacked, so the new one rises in while the old one fades out. Not
                mode="wait": if the old panel's exit never reported finishing (seen on production, 2026-11-13),
                the new panel never mounted and the sidebar stayed blank. */}
            <AnimatePresence initial={false}>
              <motion.div
                key={brush ? "brush" : tab}
                class="absolute inset-0 overflow-y-auto px-4 pt-3 pb-2 md:pt-5"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6, pointerEvents: "none" }}
                transition={{ duration: 0.22, ease: EASE_OUT }}
              >
                {brush ? (
                  <BrushPanel size={brushSize} setSize={setBrushSize} strokes={strokes.length} busy={locked} onUndo={() => setStrokes((s) => s.slice(0, -1))} onClear={() => setStrokes([])} onBack={() => (setBrush(false), setStrokes([]))} onApply={applyErase} />
                ) : tab === "crop" ? (
                  <CropPanel
                    aspect={cur.aspect}
                    portrait={cur.portrait}
                    angle={cur.angle}
                    disabled={locked}
                    onAspect={pickAspect}
                    onTurn={turn}
                    onAngle={(a) => setLive({ angle: a })}
                    onAngleCommit={(a) => commit({ angle: a })}
                    onCentre={autoCentre}
                    onReset={resetGeometry}
                    onAngleStart={() => setInteracting(true)}
                    onAngleEnd={() => setInteracting(false)}
                  />
                ) : tab === "adjust" ? (
                  <AdjustPanel
                    adjust={cur.adjust}
                    selected={adjustKey}
                    onSelect={setAdjustKey}
                    disabled={locked}
                    onAuto={autoEnhance}
                    onInput={(v) => setLive({ adjust: { ...curRef.current.adjust, [adjustKey]: v } })}
                    onCommit={(v) => commit({ adjust: { ...curRef.current.adjust, [adjustKey]: v } })}
                    onReset={() => commit({ adjust: NO_ADJUST })}
                  />
                ) : (
                  <MagicPanel
                    busy={busy}
                    aiOff={aiOff}
                    done={cur.baseEdits}
                    full={Math.max(BW, BH) >= 2400}
                    onRun={(op) => runMagic(op)}
                    onBrush={() => {
                      setBrushSrc(flatten(curRef.current));
                      setStrokes([]);
                      setBrush(true);
                    }}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.aside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Pieces

function IconButton({ label, disabled, onClick, children, active }: { label: string; disabled?: boolean; onClick: () => void; children: ComponentChildren; active?: boolean }) {
  return (
    <motion.button
      whileTap={{ scale: 0.88 }}
      class={`grid size-9 place-items-center rounded-full transition-colors disabled:opacity-30 ${active ? "bg-white text-black" : "text-white/80 hover:bg-white/10 hover:text-white"}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </motion.button>
  );
}

/** A corner (an L) or an edge (a short bar), with a big invisible area to grab. */
function CropHandle({ handle }: { handle: Handle }) {
  const corner = handle.length === 2;
  const pos: Record<Handle, string> = {
    nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
    ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
    sw: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
    se: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
    n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
    s: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize",
    e: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
    w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  };
  const hit = corner ? "size-11" : handle === "n" || handle === "s" ? "h-11 w-[calc(100%-44px)] max-w-[60%]" : "w-11 h-[calc(100%-44px)] max-h-[60%]";
  const arm = "absolute bg-white rounded-full shadow-[0_0_0_0.5px_rgba(0,0,0,0.35),0_1px_6px_rgba(0,0,0,0.5)]";
  return (
    <div data-handle={handle} class={`absolute z-10 grid place-items-center ${hit} ${pos[handle]}`} style={{ touchAction: "none" }}>
      {corner ? (
        <span class="relative size-11">
          {/* The L sits on the crop's corner (the middle of this area), pointing inwards */}
          <span class={arm} style={{ width: 22, height: 3.5, top: 20.25, left: handle[1] === "w" ? 20.25 : 1.75 }} />
          <span class={arm} style={{ width: 3.5, height: 22, left: 20.25, top: handle[0] === "n" ? 20.25 : 1.75 }} />
        </span>
      ) : (
        <span class={arm} style={handle === "n" || handle === "s" ? { width: 26, height: 3.5, position: "relative" } : { width: 3.5, height: 26, position: "relative" }} />
      )}
    </div>
  );
}

function ScoreRing({ score }: { score: number | null }) {
  const c = score == null ? "rgba(255,255,255,0.35)" : tone(score);
  const mv = useMotionValue(score ?? 0);
  const [n, setN] = useState(score ?? 0);
  useEffect(() => mv.on("change", (v) => setN(Math.round(v))), []);
  useEffect(() => {
    if (score == null) return;
    const a = animate(mv, score, { duration: 0.8, ease: EASE_OUT });
    return () => a.stop();
  }, [score]);
  const r = 13;
  return (
    <div class="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pr-1 pl-1 sm:pr-3" title={score == null ? "Checking" : `Photo score ${score}: ${gradeWord(score)}`} aria-label={score == null ? "Checking the photo" : `Photo score ${score}, ${gradeWord(score)}`}>
      <span class="relative grid size-8 place-items-center">
        <svg width="32" height="32" viewBox="0 0 32 32" class="absolute inset-0 -rotate-90" aria-hidden="true">
          <circle cx="16" cy="16" r={r} fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="3" />
          <motion.circle cx="16" cy="16" r={r} fill="none" stroke={c} stroke-width="3" stroke-linecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: (score ?? 0) / 100 }} transition={{ duration: 0.9, ease: EASE_OUT }} style={{ filter: `drop-shadow(0 0 5px ${c})` }} />
        </svg>
        <span class="relative text-[11px] font-bold tabular-nums">{score == null ? "–" : n}</span>
      </span>
      {score != null && <span class="hidden text-xs font-semibold sm:inline" style={{ color: c }}>{gradeWord(score)}</span>}
    </div>
  );
}

function Pill({ active, onClick, children, disabled, group }: { active: boolean; onClick: () => void; children: ComponentChildren; disabled?: boolean; group: string }) {
  return (
    <motion.button whileTap={{ scale: 0.94 }} class={`relative flex-none rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${active ? "text-black" : "text-white/70 hover:text-white"}`} aria-pressed={active} disabled={disabled} onClick={onClick}>
      {active && <motion.span layoutId={group} class="absolute inset-0 rounded-full bg-white shadow-[0_0_18px_-4px_rgba(255,255,255,0.5)]" transition={SPRING} />}
      <span class="relative">{children}</span>
    </motion.button>
  );
}

function CropPanel(props: {
  aspect: AspectId;
  portrait: boolean;
  angle: number;
  disabled: boolean;
  onAspect: (a: AspectId) => void;
  onTurn: (by: 1 | -1) => void;
  onAngle: (a: number) => void;
  onAngleCommit: (a: number) => void;
  onAngleStart: () => void;
  onAngleEnd: () => void;
  onCentre: () => void;
  onReset: () => void;
}) {
  const label = (a: { id: AspectId; label: string }) => (props.aspect === a.id && props.portrait && (a.id === "4:3" || a.id === "16:9") ? a.label.split(":").reverse().join(":") : a.label);
  return (
    <div class="grid gap-3">
      <div class="-mx-4 flex gap-1 overflow-x-auto px-4 pb-0.5 md:flex-wrap" role="group" aria-label="Shape">
        {ASPECTS.map((a) => (
          <Pill key={a.id} group="editor-aspect" active={props.aspect === a.id} disabled={props.disabled} onClick={() => props.onAspect(a.id)}>
            {label(a)}
          </Pill>
        ))}
      </div>
      <Dial value={props.angle} disabled={props.disabled} onInput={props.onAngle} onCommit={props.onAngleCommit} onStart={props.onAngleStart} onEnd={props.onAngleEnd} />
      <div class="flex items-center justify-between gap-1">
        <IconButton label="Rotate left" disabled={props.disabled} onClick={() => props.onTurn(-1)}>
          <Icons.rotateCcw size={19} />
        </IconButton>
        <IconButton label="Rotate right" disabled={props.disabled} onClick={() => props.onTurn(1)}>
          <Icons.rotateCw size={19} />
        </IconButton>
        <IconButton label="Auto-centre on the item" disabled={props.disabled} onClick={props.onCentre}>
          <Icons.crosshair size={19} />
        </IconButton>
        <IconButton label="Reset crop and rotation" disabled={props.disabled} onClick={props.onReset}>
          <Icons.refresh size={18} />
        </IconButton>
      </div>
    </div>
  );
}

/** The straighten ruler: drag sideways to turn the photo by up to 45° either way; it clicks at zero. */
function Dial({ value, disabled, onInput, onCommit, onStart, onEnd }: { value: number; disabled: boolean; onInput: (v: number) => void; onCommit: (v: number) => void; onStart: () => void; onEnd: () => void }) {
  const PX = 7;
  const drag = useRef<{ x: number; v: number } | null>(null);
  const last = useRef(value);
  last.current = value;
  const set = (v: number) => {
    const snapped = Math.abs(v) < 0.6 ? 0 : Math.round(v * 10) / 10;
    if (snapped === 0 && last.current !== 0) buzz(6);
    last.current = snapped;
    onInput(snapped);
  };
  return (
    <div class="grid gap-0.5">
      <div class="flex items-center justify-center gap-1.5 text-[11px] font-semibold tabular-nums text-white/60">
        <span class={value ? "text-white" : ""}>{value > 0 ? "+" : ""}{value.toFixed(1)}°</span>
      </div>
      <div
        class={`relative h-9 cursor-ew-resize overflow-hidden touch-none ${disabled ? "opacity-40" : ""}`}
        style={{ maskImage: "linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent)", WebkitMaskImage: "linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent)" }}
        role="slider"
        tabIndex={0}
        aria-label="Straighten"
        aria-valuemin={-45}
        aria-valuemax={45}
        aria-valuenow={value}
        aria-valuetext={`${value.toFixed(1)} degrees`}
        onPointerDown={(e: PointerEvent) => {
          if (disabled) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, v: value };
          onStart();
        }}
        onPointerMove={(e: PointerEvent) => drag.current && set(clamp(drag.current.v - (e.clientX - drag.current.x) / PX, -45, 45))}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          onEnd();
          onCommit(last.current);
        }}
        onPointerCancel={() => ((drag.current = null), onEnd(), onCommit(last.current))}
        onDblClick={() => (onInput(0), onCommit(0))}
        onKeyDown={(e: KeyboardEvent) => {
          const d = e.key === "ArrowLeft" ? -0.5 : e.key === "ArrowRight" ? 0.5 : 0;
          if (!d) return;
          e.preventDefault();
          e.stopPropagation();
          const v = clamp(Math.round((value + d * (e.shiftKey ? 4 : 1)) * 10) / 10, -45, 45);
          onInput(v);
          onCommit(v);
        }}
      >
        <div class="absolute top-0 left-1/2 h-full" style={{ transform: `translateX(${-value * PX}px)` }}>
          {Array.from({ length: 91 }, (_, i) => i - 45).map((d) => (
            <span key={d} class={`absolute bottom-2 w-px -translate-x-1/2 rounded-full ${d % 15 === 0 ? "h-4 bg-white/75" : d % 5 === 0 ? "h-3 bg-white/45" : "h-2 bg-white/20"}`} style={{ left: d * PX }} />
          ))}
        </div>
        <span class="absolute bottom-1 left-1/2 h-6 w-0.5 -translate-x-1/2 rounded-full bg-[var(--accent)]" style={{ boxShadow: "0 0 10px var(--accent)" }} />
      </div>
    </div>
  );
}

/** One slider for the chosen adjustment: zero in the middle for two-way ones; double-tap resets it. */
function Slider({ value, min, max, label, disabled, onInput, onCommit }: { value: number; min: number; max: number; label: string; disabled?: boolean; onInput: (v: number) => void; onCommit: (v: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const val = useRef(value);
  val.current = value;
  const lastTap = useRef(0);
  const fromX = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.round(min + clamp((x - r.left) / r.width, 0, 1) * (max - min));
  };
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const zero = pct(clamp(0, min, max));
  const at = pct(value);
  const set = (v: number) => {
    // A gentle click when passing zero.
    if ((val.current < 0 && v >= 0) || (val.current > 0 && v <= 0)) buzz(5);
    val.current = v;
    onInput(v);
  };
  return (
    <div
      class={`relative h-10 touch-none select-none ${disabled ? "opacity-40" : "cursor-pointer"}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={(e: PointerEvent) => {
        if (disabled) return;
        const now = Date.now();
        if (now - lastTap.current < 300) {
          lastTap.current = 0;
          onInput(0);
          return onCommit(0);
        }
        lastTap.current = now;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDrag(true);
        set(fromX(e.clientX));
      }}
      onPointerMove={(e: PointerEvent) => drag && set(fromX(e.clientX))}
      onPointerUp={() => drag && (setDrag(false), onCommit(val.current))}
      onPointerCancel={() => drag && (setDrag(false), onCommit(val.current))}
      onKeyDown={(e: KeyboardEvent) => {
        const step = e.shiftKey ? 10 : 1;
        const next = e.key === "ArrowLeft" || e.key === "ArrowDown" ? value - step : e.key === "ArrowRight" || e.key === "ArrowUp" ? value + step : e.key === "Home" ? min : e.key === "End" ? max : null;
        if (next == null) return;
        e.preventDefault();
        e.stopPropagation();
        const v = clamp(next, min, max);
        onInput(v);
        onCommit(v);
      }}
    >
      <div ref={track} class="absolute inset-x-3 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/12">
        {min < 0 && <span class="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/35" style={{ left: `${zero}%` }} />}
        <div class="absolute inset-y-0 rounded-full bg-[var(--accent)]" style={{ left: `${Math.min(zero, at)}%`, width: `${Math.abs(at - zero)}%`, boxShadow: "0 0 12px var(--glow)" }} />
        <motion.div class="absolute top-1/2 size-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.6)]" style={{ left: `${at}%` }} animate={{ scale: drag ? 1.15 : 1 }} transition={SPRING} />
        <AnimatePresence>
          {drag && (
            <motion.span class="absolute -top-9 -translate-x-1/2 rounded-lg bg-white px-2 py-0.5 text-xs font-bold tabular-nums text-black shadow-lg" style={{ left: `${at}%` }} initial={{ opacity: 0, y: 6, scale: 0.8 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.85 }} transition={{ duration: 0.15 }}>
              {value > 0 && min < 0 ? "+" : ""}
              {value}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function AdjustPanel(props: { adjust: Adjust; selected: AdjustKey; disabled: boolean; onSelect: (k: AdjustKey) => void; onAuto: () => void; onInput: (v: number) => void; onCommit: (v: number) => void; onReset: () => void }) {
  const [min, max] = ADJUST_RANGE[props.selected];
  const sel = ADJUSTS.find((a) => a.key === props.selected)!;
  return (
    <div class="grid gap-2">
      <div class="-mx-4 flex items-start gap-1 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
        <ToolChip label="Auto" active={false} disabled={props.disabled} onClick={props.onAuto} accent>
          <Icons.wand size={19} />
        </ToolChip>
        <span class="mx-1 mt-3 h-8 w-px flex-none bg-white/10 md:mx-0.5" />
        {ADJUSTS.map((a) => (
          <ToolChip key={a.key} label={a.label} active={props.selected === a.key} disabled={props.disabled} onClick={() => props.onSelect(a.key)} value={props.adjust[a.key]}>
            <a.Icon size={19} />
          </ToolChip>
        ))}
      </div>
      <div class="flex items-center gap-2">
        <span class="w-20 flex-none text-xs font-semibold text-white/60">{sel.label}</span>
        <div class="flex-1">
          <Slider value={props.adjust[props.selected]} min={min} max={max} label={sel.label} disabled={props.disabled} onInput={props.onInput} onCommit={props.onCommit} />
        </div>
        <IconButton label="Reset adjustments" disabled={props.disabled || isNeutral(props.adjust)} onClick={props.onReset}>
          <Icons.refresh size={16} />
        </IconButton>
      </div>
    </div>
  );
}

/** A round tool button with a small label; a dot shows when its adjustment isn't zero. */
function ToolChip({ label, active, disabled, onClick, children, value, accent }: { label: string; active: boolean; disabled?: boolean; onClick: () => void; children: ComponentChildren; value?: number; accent?: boolean }) {
  return (
    <motion.button whileTap={{ scale: 0.9 }} class="flex w-16 flex-none flex-col items-center gap-1 py-0.5 disabled:opacity-40 md:w-[54px]" aria-pressed={active} aria-label={value ? `${label} ${value}` : label} disabled={disabled} onClick={onClick}>
      <span
        class={`relative grid size-11 place-items-center rounded-full border transition-colors ${active ? "border-white bg-white text-black" : accent ? "border-[var(--accent)]/50 bg-[var(--accent-soft)] text-[var(--accent)]" : "border-white/10 bg-white/[0.05] text-white/85"}`}
        style={active ? { boxShadow: "0 0 20px -4px rgba(255,255,255,0.5)" } : accent ? { boxShadow: "0 0 18px -6px var(--glow)" } : undefined}
      >
        {children}
        {value ? <span class="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[#0d0e12] bg-[var(--accent)]" /> : null}
      </span>
      <span class={`text-[10.5px] font-semibold ${active ? "text-white" : "text-white/55"}`}>{value ? `${value > 0 && label !== "Sharpness" ? "+" : ""}${value}` : label}</span>
    </motion.button>
  );
}

function MagicPanel({ busy, aiOff, done, full, onRun, onBrush }: { busy: Busy | null; aiOff: boolean; done: string[]; full: boolean; onRun: (op: Busy["op"]) => void; onBrush: () => void }) {
  const tiles: { id: string; title: string; sub: string; Icon: (p: { size?: number }) => any; ai: boolean; run: () => void; off?: string; doneWith?: string }[] = [
    { id: "remove_background", title: "Remove background", sub: "Pure white behind the item", Icon: Icons.wand, ai: true, run: () => onRun("remove_background"), doneWith: "ai_background" },
    { id: "erase", title: "Spot remove", sub: "Brush away clutter", Icon: Icons.eraser, ai: true, run: onBrush },
    { id: "upscale", title: "Upscale", sub: full ? "Restore detail and sharpness" : "Sharper and bigger, up to 2400px", Icon: Icons.upscale, ai: true, run: () => onRun("upscale"), doneWith: "ai_upscale" },
    { id: "tidy", title: "Tidy background", sub: "On this device, no AI", Icon: Icons.sparkles, ai: false, run: () => onRun("tidy"), doneWith: "background" },
  ];
  return (
    <div class="grid gap-2">
      {aiOff && <p class="text-xs text-white/50">AI tools aren't set up yet. Tidy background still works on this device.</p>}
      <div class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0">
        {tiles.map((t) => {
          const disabled = Boolean(busy) || (t.ai && aiOff) || Boolean(t.off);
          const working = busy?.op === t.id;
          const isDone = t.doneWith ? done.includes(t.doneWith) : false;
          return (
            <motion.button
              key={t.id}
              whileTap={{ scale: 0.95 }}
              whileHover={disabled ? undefined : { y: -2 }}
              class={`group relative flex w-[132px] flex-none flex-col items-start gap-2 overflow-hidden rounded-2xl border p-3 text-left transition-colors md:w-auto ${working ? "border-[var(--accent)]/60 bg-[var(--accent-soft)]" : "border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.07]"} disabled:opacity-40`}
              disabled={disabled}
              onClick={t.run}
            >
              <span class="relative grid size-9 place-items-center rounded-xl text-white" style={{ background: t.ai ? "linear-gradient(135deg, var(--accent), #9b7bff)" : "rgba(255,255,255,0.1)", boxShadow: t.ai ? "0 0 20px -6px var(--glow)" : undefined }}>
                <t.Icon size={18} />
              </span>
              <span>
                <span class="flex items-center gap-1.5 text-[13px] font-semibold">
                  {t.title}
                  {isDone && <Icons.check size={13} class="text-[var(--green)]" />}
                </span>
                <span class="block text-[11px] leading-tight text-white/50">{t.sub}</span>
              </span>
              {t.ai && <span class="absolute top-2.5 right-2.5 rounded-full bg-white/10 px-1.5 py-px text-[9px] font-bold tracking-wide text-white/70">AI</span>}
              {working && (
                <motion.span class="pointer-events-none absolute inset-y-0 w-1/2" style={{ background: "linear-gradient(100deg, transparent, rgba(255,255,255,0.18), transparent)" }} initial={{ left: "-50%" }} animate={{ left: "120%" }} transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }} />
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

function BrushPanel({ size, setSize, strokes, busy, onUndo, onClear, onBack, onApply }: { size: number; setSize: (n: number) => void; strokes: number; busy: boolean; onUndo: () => void; onClear: () => void; onBack: () => void; onApply: () => void }) {
  return (
    <div class="grid gap-2">
      <p class="text-xs text-white/60">Paint over clutter around the item. Never marks or wear on the item itself: buyers must see it as it is.</p>
      <div class="flex items-center gap-2">
        <Icons.brush size={16} class="flex-none text-white/60" />
        <div class="flex-1">
          <Slider value={size} min={8} max={90} label="Brush size" disabled={busy} onInput={setSize} onCommit={setSize} />
        </div>
        <span class="grid size-9 flex-none place-items-center">
          <span class="rounded-full border border-white/60 bg-[var(--accent)]/40" style={{ width: Math.max(6, size / 2.6), height: Math.max(6, size / 2.6) }} />
        </span>
      </div>
      <div class="flex items-center gap-1">
        <IconButton label="Back to Magic" disabled={busy} onClick={onBack}>
          <Icons.chevronLeft size={19} />
        </IconButton>
        <IconButton label="Undo last stroke" disabled={busy || !strokes} onClick={onUndo}>
          <Icons.undo size={17} />
        </IconButton>
        <IconButton label="Clear strokes" disabled={busy || !strokes} onClick={onClear}>
          <Icons.x size={17} />
        </IconButton>
        <motion.button whileTap={{ scale: 0.95 }} class="ml-auto flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-white shadow-[0_0_24px_-6px_var(--glow)] disabled:opacity-35 disabled:shadow-none" disabled={busy || !strokes} onClick={onApply}>
          <Icons.eraser size={15} /> Remove
        </motion.button>
      </div>
    </div>
  );
}
