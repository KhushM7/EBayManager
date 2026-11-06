// The Smart Camera Assistant overlay: the person's own photo with a framing grid and corner guides, a laser
// line sweeping over it while photocheck.ts measures it, then the item's detected frame and a grade. The
// photo itself is never changed or generated; this is only a reading of it.

import { AnimatePresence, motion } from "framer-motion";
import { gradeWord, type PhotoGrade } from "./photocheck";
import { EASE_OUT, Icons, SPRING } from "./ui";

const tone = (score: number) => (score >= 85 ? "var(--green)" : score >= 65 ? "var(--blue)" : score >= 40 ? "var(--yellow)" : "var(--red)");

export function CameraAssistant({ url, grade, scanning, onRemove, label }: { url: string; grade: PhotoGrade | null; scanning: boolean; onRemove?: () => void; label?: string }) {
  const c = grade ? tone(grade.score) : "var(--accent)";
  return (
    <figure class="relative m-0 overflow-hidden rounded-2xl border border-line bg-surface-3" style={{ aspectRatio: "4 / 3" }}>
      <img src={url} alt={label ?? "Your photo"} class="absolute inset-0 size-full object-cover" />
      {/* Framing grid (rule of thirds) and corner guides */}
      <div class="pointer-events-none absolute inset-0" aria-hidden="true">
        <div class="absolute inset-y-0 left-1/3 w-px bg-white/25" />
        <div class="absolute inset-y-0 left-2/3 w-px bg-white/25" />
        <div class="absolute inset-x-0 top-1/3 h-px bg-white/25" />
        <div class="absolute inset-x-0 top-2/3 h-px bg-white/25" />
        {["top-3 left-3 border-t-2 border-l-2", "top-3 right-3 border-t-2 border-r-2", "bottom-3 left-3 border-b-2 border-l-2", "bottom-3 right-3 border-b-2 border-r-2"].map((p) => (
          <span class={`absolute size-6 rounded-[4px] border-white/80 ${p}`} />
        ))}
      </div>

      {/* Scanning: a laser line sweeps down and back while the photo is measured */}
      <AnimatePresence>
        {scanning && (
          <motion.div class="pointer-events-none absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true">
            <div class="absolute inset-0 bg-black/25" />
            <motion.div
              class="absolute inset-x-0 h-24"
              style={{ background: "linear-gradient(to bottom, transparent, color-mix(in srgb, var(--accent) 35%, transparent))" }}
              initial={{ top: "-25%" }}
              animate={{ top: ["-25%", "100%"] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: [0.65, 0, 0.35, 1] }}
            >
              <div class="absolute inset-x-0 bottom-0 h-0.5 bg-accent" style={{ boxShadow: "0 0 12px 2px var(--accent), 0 0 32px 6px var(--glow)" }} />
            </motion.div>
            <div class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/50 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-md">
              <span class="size-2 animate-pulse rounded-full bg-accent" /> Checking light, focus and framing
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Result: the detected frame of the item, and the grade */}
      {grade && !scanning && (
        <>
          <motion.div
            class="pointer-events-none absolute rounded-lg border-2"
            style={{ borderColor: c, boxShadow: `0 0 0 9999px rgba(0,0,0,.18), 0 0 24px -4px ${c}` }}
            initial={{ left: "10%", top: "10%", width: "80%", height: "80%", opacity: 0 }}
            animate={{ left: `${grade.box.x * 100}%`, top: `${grade.box.y * 100}%`, width: `${grade.box.w * 100}%`, height: `${grade.box.h * 100}%`, opacity: 1 }}
            transition={{ duration: 0.6, ease: EASE_OUT }}
            aria-hidden="true"
          />
          <motion.div class="absolute top-3 left-3 flex items-center gap-2 rounded-full border border-white/15 bg-black/55 py-1 pr-3 pl-1 text-xs font-semibold text-white backdrop-blur-md" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ ...SPRING, delay: 0.25 }}>
            <span class="grid size-6 place-items-center rounded-full text-[11px] font-bold text-black" style={{ background: c }}>
              {grade.score}
            </span>
            {gradeWord(grade.score)}
          </motion.div>
        </>
      )}

      {onRemove && (
        <motion.button whileTap={{ scale: 0.9 }} class="absolute top-3 right-3 grid size-8 place-items-center rounded-full border border-white/15 bg-black/55 text-white backdrop-blur-md" onClick={onRemove} aria-label="Remove photo">
          <Icons.x size={16} />
        </motion.button>
      )}
    </figure>
  );
}

/** The findings under a photo, worst first, as small chips. */
export function Findings({ grade }: { grade: PhotoGrade }) {
  const order = { bad: 0, warn: 1, good: 2 } as const;
  return (
    <ul class="mt-2 grid gap-1.5 p-0">
      {[...grade.findings]
        .sort((a, b) => order[a.tone] - order[b.tone])
        .map((f, i) => (
          <motion.li
            key={f.code}
            class={`flex list-none items-start gap-2 rounded-xl px-3 py-2 text-sm ${f.tone === "good" ? "bg-green-soft text-green" : f.tone === "bad" ? "bg-red-soft text-red" : "bg-yellow-soft text-yellow"}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.07, ease: EASE_OUT }}
          >
            <span class="mt-0.5 flex-none">{f.tone === "good" ? <Icons.check size={15} /> : <Icons.alert size={15} />}</span>
            <span class="text-ink-2">{f.text}</span>
          </motion.li>
        ))}
    </ul>
  );
}
