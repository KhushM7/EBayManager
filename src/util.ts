// Small pure helpers shared across the server code.

/** Rounds to pennies. */
export const r2 = (x: number) => Math.round(x * 100) / 100;

/** One value or an array (as XML parses), always as an array. */
export const list = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** A number from a parsed XML value (plain or with attributes, as { "#text": … }), or null. */
export const num = (v: any): number | null => {
  const n = Number(typeof v === "object" && v != null ? v["#text"] : v);
  return v == null || !Number.isFinite(n) ? null : n;
};

/** Plain text from an HTML description: scripts and styles dropped, tags removed, spaces collapsed. */
export const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
