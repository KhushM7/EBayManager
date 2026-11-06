// Shared UI kit: icons, motion presets and the small animated pieces every screen uses (count-up numbers,
// self-drawing sparklines, filling rings, toasts). Choreography values are documented in
// docs/design-system.md; keep them in step with the CSS tokens in style.css.

import { animate, motion, useInView, useMotionValue, useReducedMotion, type Variants } from "framer-motion";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

// ---------------------------------------------------------------- Motion presets

export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];
export const SPRING = { type: "spring", stiffness: 420, damping: 32, mass: 0.9 } as const;
export const SPRING_SOFT = { type: "spring", stiffness: 260, damping: 30 } as const;

/** Page enter/exit: a short fade and a 12px rise, like a native push. */
export const page: Variants = {
  initial: { opacity: 0, y: 12, filter: "blur(4px)" },
  enter: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.42, ease: EASE_OUT } },
  exit: { opacity: 0, y: -6, filter: "blur(2px)", transition: { duration: 0.18, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
};

/** Lists: children rise in 50ms apart. */
export const list: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } } };
export const item: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.42, ease: EASE_OUT } },
};

/** The physical press: every tappable thing scales to 0.95. */
export const press = { whileTap: { scale: 0.95 }, transition: { duration: 0.12 } } as const;

// ---------------------------------------------------------------- Icons (one outline set, 1.75 stroke)

type IconProps = { size?: number; class?: string };
const svg = (d: ComponentChildren) =>
  function Icon({ size = 20, class: cls }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class={cls} aria-hidden="true">
        {d}
      </svg>
    );
  };

export const Icons = {
  inbox: svg(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>),
  grid: svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  chart: svg(<><path d="M3 3v18h18" /><path d="m7 15 4-4 3 3 5-6" /></>),
  pulse: svg(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />),
  clock: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  settings: svg(<><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>),
  plus: svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  eye: svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  heart: svg(<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z" />),
  tag: svg(<><path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.82 8.82a2 2 0 0 0 2.83 0l7.17-7.17a2 2 0 0 0 0-2.83z" /><circle cx="7.5" cy="7.5" r="1.5" /></>),
  calendar: svg(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>),
  camera: svg(<><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3.5" /></>),
  sparkles: svg(<><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" /></>),
  check: svg(<path d="M20 6 9 17l-5-5" />),
  x: svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>),
  arrowRight: svg(<><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>),
  arrowLeft: svg(<><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>),
  refresh: svg(<><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>),
  chevron: svg(<path d="m6 9 6 6 6-6" />),
  box: svg(<><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5" /><path d="M12 13v8" /></>),
  truck: svg(<><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" /></>),
  message: svg(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />),
  upload: svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></>),
  sun: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  focus: svg(<><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="3" /></>),
  alert: svg(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>),
  trash: svg(<><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>),
};

// ---------------------------------------------------------------- Count-up number

/** A number that ticks up from zero the first time it scrolls into view. */
export function CountUp({ value, format = (n) => String(Math.round(n)), duration = 1.1, class: cls }: { value: number; format?: (n: number) => string; duration?: number; class?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref as any, { once: true, margin: "-40px" });
  const reduce = useReducedMotion();
  const mv = useMotionValue(0);
  const [text, setText] = useState(format(reduce ? value : 0));
  useEffect(() => mv.on("change", (v) => setText(format(v))), [format]);
  useEffect(() => {
    if (!seen) return;
    if (reduce) return void setText(format(value));
    const c = animate(mv, value, { duration, ease: EASE_OUT });
    return () => c.stop();
  }, [seen, value]);
  return (
    <span ref={ref} class={`num ${cls ?? ""}`} aria-label={format(value)}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------- Sparkline

/** A small line that draws itself on load; the area under it fades in after. */
export function Sparkline({ values, width = 120, height = 36, color = "var(--chart)", class: cls }: { values: number[]; width?: number; height?: number; color?: string; class?: string }) {
  const id = useRef(`sp${Math.random().toString(36).slice(2, 8)}`).current;
  if (values.length < 2) return <svg width={width} height={height} class={cls} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${d} L${width} ${height} L0 ${height} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} class={cls} aria-hidden="true" style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color={color} stop-opacity="0.28" />
          <stop offset="1" stop-color={color} stop-opacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={area} fill={`url(#${id})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7, duration: 0.6 }} />
      <motion.path d={d} fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease: EASE_OUT }} />
      <motion.circle cx={lx} cy={ly} r="3" fill={color} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 1.1, ...SPRING }} />
    </svg>
  );
}

// ---------------------------------------------------------------- Ring

/** A thin ring that fills to `value` (0–1) when it comes into view; the label sits in the middle. */
export function Ring({ value, size = 120, stroke = 10, color = "var(--green)", children }: { value: number | null; size?: number; stroke?: number; color?: string; children?: ComponentChildren }) {
  const ref = useRef<SVGSVGElement>(null);
  const seen = useInView(ref as any, { once: true });
  const r = (size - stroke) / 2;
  const v = Math.max(0, Math.min(1, value ?? 0));
  return (
    <div class="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg ref={ref} width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" stroke-width={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          stroke-width={stroke}
          stroke-linecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: seen ? v : 0 }}
          transition={{ duration: 1.3, ease: EASE_OUT, delay: 0.15 }}
          style={{ filter: `drop-shadow(0 0 8px ${color})` }}
        />
      </svg>
      <div class="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Toast

export interface ToastMsg {
  id: number;
  tone: "info" | "good" | "warn" | "bad";
  text: string;
}
const toneClass: Record<ToastMsg["tone"], string> = {
  info: "text-blue",
  good: "text-green",
  warn: "text-yellow",
  bad: "text-red",
};
export function Toasts({ items }: { items: ToastMsg[] }) {
  return (
    <div class="pointer-events-none fixed inset-x-0 top-14 z-[70] flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
      {items.map((t) => (
        <motion.div
          key={t.id}
          layout
          initial={{ opacity: 0, y: -16, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.96 }}
          transition={SPRING}
          class="pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl border border-line-strong bg-glass px-4 py-3 text-sm font-medium text-ink shadow-float backdrop-blur-xl"
        >
          <span class={`grid size-6 flex-none place-items-center rounded-full bg-surface-3 ${toneClass[t.tone]}`}>
            {t.tone === "good" ? <Icons.check size={14} /> : t.tone === "info" ? <Icons.sparkles size={14} /> : <Icons.alert size={14} />}
          </span>
          {t.text}
        </motion.div>
      ))}
    </div>
  );
}
export function useToasts() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const push = (tone: ToastMsg["tone"], text: string, ms = 3600) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), ms);
  };
  return { items, push };
}

// ---------------------------------------------------------------- Price delta pill

/** Old price → new price as a pill. The new price always shows; each time the card opens, it rolls in from
 *  the old one, so the size of the change is felt, not only read. */
export function PriceDelta({ from, to, open = true, format }: { from: number | null; to: number; open?: boolean; format: (n: number) => string }) {
  const mv = useMotionValue(to);
  const [text, setText] = useState(format(to));
  useEffect(() => mv.on("change", (v) => setText(format(v))), []);
  useEffect(() => {
    if (!open || from == null) return void mv.set(to);
    mv.set(from);
    const c = animate(mv, to, { duration: 0.8, ease: EASE_OUT, delay: 0.1 });
    return () => c.stop();
  }, [open, to, from]);
  const down = from != null && to < from;
  const pct = from ? Math.round(((to - from) / from) * 100) : null;
  return (
    <span class="inline-flex items-center gap-2 font-semibold tabular-nums">
      {from != null && <span class="rounded-full bg-surface-3 px-2.5 py-1 text-sm text-muted line-through decoration-1">{format(from)}</span>}
      {from != null && <Icons.arrowRight size={16} class="text-muted" />}
      <span class={`rounded-full px-3 py-1 text-lg ${down ? "bg-red-soft text-red" : "bg-green-soft text-green"}`} style={{ boxShadow: `0 0 24px -8px ${down ? "var(--red)" : "var(--green)"}` }}>
        {text}
      </span>
      {pct != null && pct !== 0 && <span class="text-xs text-muted">{pct > 0 ? `+${pct}` : pct}%</span>}
    </span>
  );
}

/** The quiet section label used inside bento cards. */
export function CardLabel({ icon, children, right }: { icon?: ComponentChildren; children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <div class="mb-3 flex items-center justify-between gap-3">
      <span class="flex items-center gap-2 text-sm font-semibold text-muted">
        {icon}
        {children}
      </span>
      {right}
    </div>
  );
}
