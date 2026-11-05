// "New listing": a step-by-step flow for someone new to selling (docs/listing-assistant.md). Photos are the
// person's own and are graded in the browser (photocheck.ts), never generated. Claude writes the description
// only from facts the person confirms, and the finished listing becomes a proposal like every other change:
// nothing is published until it's approved.
//
// Server side (Phase 10, not built yet) — the contract the wizard calls, documented in docs/listing-assistant.md:
//   POST /api/listing-assistant/describe  { title, condition, facts, flaws, photoCount } → { description, questions }
//   POST /api/listing-assistant/price     { title, condition }                            → { recommended, low, high, basis, postage }
//   POST /api/listing-assistant/propose   { title, condition, facts, flaws, description, price, postage, collectionOnly }
//                                         → { proposalId }

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, SignedOut } from "./api";
import { CameraAssistant, Findings } from "./camera";
import { money } from "./format";
import { gradePhoto, type PhotoGrade } from "./photocheck";
import type { ScreenProps } from "./screens";
import { EASE_OUT, Icons, SPRING, Toasts, useToasts } from "./ui";

interface Photo {
  id: string;
  url: string;
  file: File;
  grade: PhotoGrade | null;
  scanning: boolean;
}
interface Draft {
  title: string;
  condition: string;
  brand: string;
  model: string;
  flaws: string;
  description: string;
  price: string;
  collectionOnly: boolean;
}
interface PriceAdvice {
  recommended: number;
  low: number;
  high: number;
  basis: string;
  postage: { service: string; price: number } | null;
}

const EMPTY: Draft = { title: "", condition: "", brand: "", model: "", flaws: "", description: "", price: "", collectionOnly: false };
const KEY = "ebm.newListingDraft";
const CONDITIONS = [
  ["new", "New, unopened", "Never used, in its original packaging"],
  ["like_new", "Like new", "Used once or twice, no marks"],
  ["used_good", "Used, good", "Works fully, light signs of use"],
  ["used_fair", "Used, fair", "Works, with visible marks or wear"],
  ["parts", "For parts", "Doesn't work fully, sold as it is"],
] as const;

const STEPS = [
  { id: "photos", title: "Show it off", sub: "Take or upload real photos. We'll check each one and tell you exactly what to retake." },
  { id: "details", title: "What is it?", sub: "Only what you know for sure. Claude never guesses a fact about your item." },
  { id: "describe", title: "Tell its story", sub: "Claude writes the description from your photos and facts. You can edit every word." },
  { id: "price", title: "Set your price", sub: "Based on what the same item, in the same condition, actually sells for." },
  { id: "review", title: "Ready to list", sub: "Nothing is published until it's approved, like every other change." },
] as const;

const load = (): Draft => {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return EMPTY;
  }
};

/** Claude writing: a shimmering skeleton with a sparkle, inside a slowly turning glowing border. */
function Writing() {
  return (
    <div class="glow-border rounded-2xl bg-surface p-5" role="status" aria-label="Claude is writing the description">
      <div class="mb-4 flex items-center gap-2 text-sm font-semibold text-accent">
        <motion.span animate={{ rotate: [0, 18, -12, 0], scale: [1, 1.2, 1] }} transition={{ duration: 1.6, repeat: Infinity }}>
          <Icons.sparkles size={18} />
        </motion.span>
        Claude is writing…
      </div>
      {[92, 100, 84, 96, 60].map((w, i) => (
        <motion.div key={i} class="skeleton mb-2.5 h-3.5" style={{ width: `${w}%` }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.12 }} />
      ))}
    </div>
  );
}

/** Reveals text word by word, like it's being typed. */
function Typewriter({ text, onDone }: { text: string; onDone: () => void }) {
  const words = text.split(/(\s+)/);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= words.length) return void onDone();
    const t = setTimeout(() => setN((x) => Math.min(words.length, x + 3)), 28);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <p class="whitespace-pre-wrap text-[15px] leading-relaxed text-ink-2">
      {words.slice(0, n).join("")}
      <span class="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-accent" />
    </p>
  );
}

export function NewListing({ onSignedOut, go }: ScreenProps) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [d, setD] = useState<Draft>(load);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [writing, setWriting] = useState(false);
  const [typing, setTyping] = useState<string | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [advice, setAdvice] = useState<PriceAdvice | null>(null);
  const [pricing, setPricing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const toasts = useToasts();
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(d));
    } catch {}
  }, [d]);
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), []);
  const set = (k: keyof Draft, v: any) => setD((x) => ({ ...x, [k]: v }));

  const fail = (e: unknown, fallback: string) => {
    if (e instanceof SignedOut) return onSignedOut();
    const m = (e as Error).message;
    toasts.push("bad", /not found|404/i.test(m) ? fallback : m, 5200);
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const added = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, 12 - photos.length)
      .map((file) => ({ id: Math.random().toString(36).slice(2), url: URL.createObjectURL(file), file, grade: null, scanning: true }));
    setPhotos((p) => [...p, ...added]);
    for (const ph of added) {
      const started = Date.now();
      gradePhoto(ph.file)
        .then(async (grade) => {
          // Hold the scan on screen briefly so the sweep reads as a check, not a flicker.
          await new Promise((r) => setTimeout(r, Math.max(0, 1300 - (Date.now() - started))));
          setPhotos((p) => p.map((x) => (x.id === ph.id ? { ...x, grade, scanning: false } : x)));
          const worst = grade.findings.find((f) => f.tone === "bad") ?? grade.findings.find((f) => f.tone === "warn");
          if (worst) toasts.push(worst.tone === "bad" ? "bad" : "warn", worst.text, 4200);
        })
        .catch(() => setPhotos((p) => p.map((x) => (x.id === ph.id ? { ...x, scanning: false } : x))));
    }
  };

  const describe = async () => {
    setWriting(true);
    setTyping(null);
    try {
      const out = await api<{ description: string; questions?: string[] }>("/listing-assistant/describe", {
        body: { title: d.title, condition: d.condition, facts: { brand: d.brand, model: d.model }, flaws: d.flaws, photoCount: photos.length },
      });
      setQuestions(out.questions ?? []);
      setTyping(out.description);
    } catch (e) {
      fail(e, "The description writer isn't on the server yet (Phase 10). You can write it yourself for now.");
    } finally {
      setWriting(false);
    }
  };

  const price = async () => {
    setPricing(true);
    try {
      const out = await api<PriceAdvice>("/listing-assistant/price", { body: { title: d.title, condition: d.condition } });
      setAdvice(out);
      if (!d.price) set("price", out.recommended.toFixed(2));
    } catch (e) {
      fail(e, "Price advice for new listings isn't on the server yet (Phase 10). Set a price yourself for now.");
    } finally {
      setPricing(false);
    }
  };

  const propose = async () => {
    setSending(true);
    try {
      const out = await api<{ proposalId: string }>("/listing-assistant/propose", {
        body: { title: d.title, condition: d.condition, facts: { brand: d.brand, model: d.model }, flaws: d.flaws, description: d.description, price: Number(d.price), postage: advice?.postage ?? null, collectionOnly: d.collectionOnly },
      });
      setSent(out.proposalId);
      try {
        localStorage.removeItem(KEY);
      } catch {}
    } catch (e) {
      fail(e, "Publishing new listings isn't on the server yet (Phase 10). Your draft is saved on this device.");
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (STEPS[step].id === "price" && !advice && !pricing && d.title) price();
  }, [step]);

  const graded = photos.filter((p) => p.grade);
  const avg = graded.length ? Math.round(graded.reduce((s, p) => s + p.grade!.score, 0) / graded.length) : 0;
  const canNext = [photos.length > 0 && !photos.some((p) => p.scanning), d.title.trim().length >= 3 && Boolean(d.condition), d.description.trim().length > 0, Number(d.price) > 0, true][step];
  const move = (by: number) => (setDir(by), setStep((s) => Math.max(0, Math.min(STEPS.length - 1, s + by))), scrollTo({ top: 0, behavior: "smooth" }));

  if (sent)
    return (
      <div class="mx-auto grid max-w-md place-items-center gap-5 py-16 text-center">
        <motion.div class="grid size-24 place-items-center rounded-full bg-green text-[#04130d]" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={SPRING} style={{ boxShadow: "0 0 60px -10px var(--green)" }}>
          <Icons.check size={44} />
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, ease: EASE_OUT }}>
          <h1>Sent for approval</h1>
          <p class="mt-2 text-muted">Your listing is waiting in the Inbox. It goes live on eBay once it's approved.</p>
        </motion.div>
        <button class="btn btn-primary" onClick={() => go("/")}>
          Open the Inbox <Icons.arrowRight size={16} />
        </button>
      </div>
    );

  const s = STEPS[step];
  return (
    <div class="pb-28">
      {/* Progress: one segment per step */}
      <div class="mb-6 flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((x, i) => (
          <div key={x.id} class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
            <motion.div class="h-full rounded-full bg-accent" initial={false} animate={{ width: i < step ? "100%" : i === step ? "50%" : "0%" }} transition={{ duration: 0.5, ease: EASE_OUT }} style={{ boxShadow: "0 0 12px var(--glow)" }} />
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait" custom={dir}>
        <motion.div key={s.id} custom={dir} initial={{ opacity: 0, x: dir * 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -40 }} transition={{ duration: 0.38, ease: EASE_OUT }} class="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div>
            <p class="text-sm font-semibold text-accent">Step {step + 1} of {STEPS.length}</p>
            <h1 class="mt-1 text-3xl sm:text-4xl">{s.title}</h1>
            <p class="mt-3 max-w-md text-muted">{s.sub}</p>
            {s.id === "photos" && (
              <ul class="mt-6 grid gap-2.5 p-0 text-sm text-ink-2">
                {[
                  [Icons.sun, "Daylight from a window, no flash"],
                  [Icons.focus, "Item fills the frame, straight on"],
                  [Icons.box, "Plain white or light grey background"],
                  [Icons.camera, "Front, back, labels and every flaw"],
                ].map(([I, t]: any) => (
                  <li class="flex list-none items-center gap-3">
                    <span class="grid size-8 place-items-center rounded-lg bg-surface-2 text-muted">
                      <I size={16} />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            )}
            {s.id === "photos" && graded.length > 0 && (
              <div class="card mt-6 flex items-center gap-4">
                <span class="text-3xl font-bold tabular-nums" style={{ color: avg >= 85 ? "var(--green)" : avg >= 65 ? "var(--blue)" : "var(--yellow)" }}>
                  {avg}
                </span>
                <span class="text-sm text-muted">
                  Average photo score across {graded.length} {graded.length === 1 ? "photo" : "photos"}. Aim for 85 or more.
                </span>
              </div>
            )}
          </div>

          <div>
            {s.id === "photos" && (
              <>
                <input ref={fileRef} type="file" accept="image/*" multiple class="hidden" onChange={(e) => (addFiles(e.currentTarget.files), (e.currentTarget.value = ""))} />
                <input ref={camRef} type="file" accept="image/*" capture="environment" class="hidden" onChange={(e) => (addFiles(e.currentTarget.files), (e.currentTarget.value = ""))} />
                {photos.length === 0 ? (
                  <motion.div
                    class="flex flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed border-line-strong bg-surface/60 px-6 py-16 text-center"
                    onDragOver={(e: DragEvent) => e.preventDefault()}
                    onDrop={(e: DragEvent) => (e.preventDefault(), addFiles(e.dataTransfer?.files ?? null))}
                    whileHover={{ borderColor: "var(--accent)" }}
                  >
                    <motion.span class="grid size-16 place-items-center rounded-2xl bg-accent-soft text-accent" animate={{ y: [0, -6, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}>
                      <Icons.camera size={28} />
                    </motion.span>
                    <div>
                      <p class="font-semibold">Add your first photo</p>
                      <p class="text-sm text-muted">Drag photos here, or use your camera</p>
                    </div>
                    <div class="flex flex-wrap justify-center gap-2">
                      <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" onClick={() => camRef.current?.click()}>
                        <Icons.camera size={16} /> Take a photo
                      </motion.button>
                      <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" onClick={() => fileRef.current?.click()}>
                        <Icons.upload size={16} /> Upload
                      </motion.button>
                    </div>
                  </motion.div>
                ) : (
                  <>
                    <div class="grid gap-5 sm:grid-cols-2">
                      <AnimatePresence>
                        {photos.map((p, i) => (
                          <motion.div key={p.id} layout initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.35, ease: EASE_OUT }}>
                            <CameraAssistant url={p.url} grade={p.grade} scanning={p.scanning} label={`Photo ${i + 1}`} onRemove={() => (URL.revokeObjectURL(p.url), setPhotos((x) => x.filter((y) => y.id !== p.id)))} />
                            {p.grade && <Findings grade={p.grade} />}
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                    {photos.length < 12 && (
                      <div class="mt-5 flex flex-wrap gap-2">
                        <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" onClick={() => camRef.current?.click()}>
                          <Icons.camera size={16} /> Take another
                        </motion.button>
                        <motion.button whileTap={{ scale: 0.95 }} class="btn btn-text" onClick={() => fileRef.current?.click()}>
                          <Icons.upload size={16} /> Upload more
                        </motion.button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {s.id === "details" && (
              <div class="grid gap-5">
                <label class="grid gap-1.5 text-sm font-semibold text-ink-2">
                  Title
                  <input value={d.title} maxLength={80} placeholder="e.g. Sony WH-1000XM4 wireless headphones, black" onInput={(e) => set("title", e.currentTarget.value)} />
                  <span class="text-xs font-normal text-muted">{80 - d.title.length} characters left. Brand, model and what it is.</span>
                </label>
                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="grid gap-1.5 text-sm font-semibold text-ink-2">
                    Brand <span class="sr-only">(optional)</span>
                    <input value={d.brand} placeholder="Only if you're sure" onInput={(e) => set("brand", e.currentTarget.value)} />
                  </label>
                  <label class="grid gap-1.5 text-sm font-semibold text-ink-2">
                    Model or number
                    <input value={d.model} placeholder="From the label, if there is one" onInput={(e) => set("model", e.currentTarget.value)} />
                  </label>
                </div>
                <fieldset class="m-0 grid gap-2 border-0 p-0">
                  <legend class="mb-2 text-sm font-semibold text-ink-2">Condition</legend>
                  {CONDITIONS.map(([id, label, hint]) => (
                    <motion.label
                      key={id}
                      whileTap={{ scale: 0.98 }}
                      class={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${d.condition === id ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong"}`}
                    >
                      <input type="radio" name="condition" class="sr-only" checked={d.condition === id} onChange={() => set("condition", id)} />
                      <span class={`grid size-5 flex-none place-items-center rounded-full border-2 ${d.condition === id ? "border-accent" : "border-line-strong"}`}>
                        {d.condition === id && <motion.span layoutId="cond-dot" class="size-2.5 rounded-full bg-accent" transition={SPRING} />}
                      </span>
                      <span>
                        <span class="block font-semibold">{label}</span>
                        <span class="text-sm text-muted">{hint}</span>
                      </span>
                    </motion.label>
                  ))}
                </fieldset>
                <label class="grid gap-1.5 text-sm font-semibold text-ink-2">
                  Any marks, faults or missing parts?
                  <textarea rows={3} value={d.flaws} placeholder="Be honest: it saves returns. Leave blank if there are none." onInput={(e) => set("flaws", e.currentTarget.value)} />
                </label>
              </div>
            )}

            {s.id === "describe" && (
              <div class="grid gap-4">
                {!d.description && !writing && !typing && (
                  <motion.button whileTap={{ scale: 0.97 }} whileHover={{ y: -2 }} class="glow-border flex items-center gap-4 rounded-2xl bg-surface p-5 text-left" onClick={describe}>
                    <span class="grid size-12 flex-none place-items-center rounded-xl bg-accent-soft text-accent">
                      <Icons.sparkles size={22} />
                    </span>
                    <span>
                      <span class="block font-semibold">Write it with Claude</span>
                      <span class="text-sm text-muted">From your {photos.length} {photos.length === 1 ? "photo" : "photos"} and the facts you gave. About 2 cents.</span>
                    </span>
                  </motion.button>
                )}
                {writing && <Writing />}
                {typing && (
                  <div class="card">
                    <Typewriter text={typing} onDone={() => (set("description", typing), setTyping(null))} />
                  </div>
                )}
                {!writing && !typing && (
                  <label class="grid gap-1.5 text-sm font-semibold text-ink-2">
                    Description
                    <textarea rows={10} value={d.description} placeholder="Or write it yourself: what it is, its condition, what's included." onInput={(e) => set("description", e.currentTarget.value)} />
                  </label>
                )}
                {questions.length > 0 && (
                  <div class="evidence">
                    <p class="mb-2 flex items-center gap-2 text-sm font-semibold">
                      <Icons.message size={16} /> Claude needs to check with you
                    </p>
                    <ul class="m-0 grid gap-1 pl-5 text-sm">
                      {questions.map((q) => (
                        <li>{q}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {d.description && !writing && !typing && (
                  <button class="btn-link w-fit text-sm" onClick={describe}>
                    <Icons.refresh size={14} /> Write it again
                  </button>
                )}
              </div>
            )}

            {s.id === "price" && (
              <div class="grid gap-5">
                {pricing && (
                  <div class="card">
                    <div class="skeleton h-4 w-32" />
                    <div class="skeleton mt-4 h-10 w-48" />
                    <div class="skeleton mt-4 h-2 w-full" />
                  </div>
                )}
                {advice && (
                  <motion.div class="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE_OUT }}>
                    <p class="text-sm font-semibold text-muted">Recommended</p>
                    <p class="mt-1 text-4xl font-bold tracking-tight tabular-nums">{money(advice.recommended)}</p>
                    <div class="relative mt-5 h-2 rounded-full bg-surface-3">
                      <motion.div
                        class="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
                        initial={{ left: "0%" }}
                        animate={{ left: `${((Number(d.price || advice.recommended) - advice.low) / Math.max(0.01, advice.high - advice.low)) * 100}%` }}
                        transition={SPRING}
                        style={{ boxShadow: "0 0 14px var(--glow)" }}
                      />
                    </div>
                    <div class="mt-2 flex justify-between text-xs text-muted tabular-nums">
                      <span>Sells fast {money(advice.low)}</span>
                      <span>Patient {money(advice.high)}</span>
                    </div>
                    <p class="mt-4 text-sm text-ink-2">{advice.basis}</p>
                  </motion.div>
                )}
                <label class="grid gap-1.5 text-sm font-semibold text-ink-2">
                  Your price (£)
                  <input type="number" inputMode="decimal" min="0.99" step="0.01" value={d.price} onInput={(e) => set("price", e.currentTarget.value)} />
                </label>
                <label class="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
                  <span>
                    <span class="block font-semibold">Collection only</span>
                    <span class="text-sm text-muted">{d.collectionOnly ? "Buyers collect it from you" : advice?.postage ? `Posted with ${advice.postage.service}, about ${money(advice.postage.price)}` : "You'll post it"}</span>
                  </span>
                  <input type="checkbox" checked={d.collectionOnly} onChange={() => set("collectionOnly", !d.collectionOnly)} />
                </label>
                <p class="text-sm text-muted">Returns accepted, buyer pays return postage.</p>
              </div>
            )}

            {s.id === "review" && (
              <div class="card overflow-hidden p-0">
                {photos[0] && <img src={photos[0].url} alt="" class="aspect-[16/10] w-full object-cover" />}
                <div class="p-5">
                  <div class="flex items-start justify-between gap-4">
                    <h2 class="text-lg">{d.title || "Untitled"}</h2>
                    <span class="text-2xl font-bold tabular-nums">{money(Number(d.price) || 0)}</span>
                  </div>
                  <div class="mt-3 flex flex-wrap gap-2 text-xs">
                    <span class="rounded-full bg-surface-3 px-2.5 py-1 font-semibold">{CONDITIONS.find((c) => c[0] === d.condition)?.[1] ?? "Condition not set"}</span>
                    <span class="rounded-full bg-surface-3 px-2.5 py-1 font-semibold">
                      {photos.length} {photos.length === 1 ? "photo" : "photos"}
                    </span>
                    <span class="rounded-full bg-surface-3 px-2.5 py-1 font-semibold">{d.collectionOnly ? "Collection only" : "Posted"}</span>
                  </div>
                  <p class="mt-4 line-clamp-6 whitespace-pre-wrap text-sm text-ink-2">{d.description}</p>
                  {d.flaws && <p class="mt-3 text-sm text-muted">Flaws noted: {d.flaws}</p>}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>

      {/* The step bar: always reachable with a thumb */}
      <div class="fixed inset-x-0 z-40 px-4 min-[861px]:pl-[calc(var(--sidebar)+16px)]" style={{ bottom: "calc(var(--tabbar) + 16px)" }}>
        <div class="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-2xl border border-line-strong bg-glass p-2 shadow-float backdrop-blur-xl">
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-text" disabled={step === 0} onClick={() => move(-1)}>
            <Icons.arrowLeft size={16} /> Back
          </motion.button>
          <span class="text-sm text-muted">{s.title}</span>
          {step < STEPS.length - 1 ? (
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={!canNext} onClick={() => move(1)}>
              Next <Icons.arrowRight size={16} />
            </motion.button>
          ) : (
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-approve" disabled={sending} onClick={propose}>
              {sending ? "Sending…" : "Send for approval"}
            </motion.button>
          )}
        </div>
      </div>
      <AnimatePresence>
        <Toasts items={toasts.items} />
      </AnimatePresence>
    </div>
  );
}
