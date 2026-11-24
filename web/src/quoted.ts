// What to show of a message: an email client's quoted tail goes behind a button, and email addresses are masked.
// Pure text in, pure text out; nothing the buyer wrote is deleted.

export interface Shown {
  body: string;
  /** The quoted tail, for "Show quoted text"; null when there is none. */
  quoted: string | null;
}

const MAX = 20_000;
const ADDRESS = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}/g;
const DATE = /\b(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

const tidy = (s: string) =>
  s
    .replace(ADDRESS, "[email hidden]")
    .replace(/[ \t ]{2,}/g, " ")
    .replace(/ +$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Where "On <date>, <name> <address> wrote:" starts, or -1. It must hold a date, a digit and an address. */
function wroteMarker(s: string): number {
  for (const m of s.matchAll(/(^|\s)(On\s)/g)) {
    const start = m.index + m[1].length;
    const tail = s.slice(start, start + 300);
    const end = tail.search(/wrote:/i);
    if (end < 0) continue;
    const head = tail.slice(0, end);
    const address = head.search(/[\w.+-]{1,64}@[\w-]{1,63}\./);
    if (address < 0 || head.length - address > 90) continue;
    const before = head.slice(0, address);
    if (DATE.test(before.slice(0, 80)) && /\d/.test(before.slice(0, 80)) && !/[.!?]\s+[A-Z][a-z]+\s[a-z]/.test(before)) return start;
  }
  return -1;
}

export function showable(text: string): Shown {
  const s = text.slice(0, MAX).replace(/\r\n?/g, "\n");
  const lines = s.split("\n");
  // Replies written between quoted lines: cutting would lose them.
  const firstQuote = lines.findIndex((l) => l.startsWith(">"));
  const interleaved = firstQuote >= 0 && lines.slice(firstQuote).some((l) => l.trim() && !l.startsWith(">"));

  let cut = -1;
  if (!interleaved) {
    cut = wroteMarker(s);
    const outlook = s.search(/^(?:-{2,}\s?Original Message\s?-{2,}|From: .+\n(?:Sent|Date): .+)$/im);
    if (outlook >= 0 && (cut < 0 || outlook < cut)) cut = outlook;
    if (cut < 0 && firstQuote >= 0) cut = lines.slice(0, firstQuote).join("\n").length;
  }
  if (cut < 0 || !s.slice(0, cut).trim()) return { body: tidy(s), quoted: null };
  return { body: tidy(s.slice(0, cut)), quoted: tidy(s.slice(cut)) };
}

/** One line for the list. */
export const preview = (text: string) => showable(text).body.replace(/\s+/g, " ").slice(0, 200);
