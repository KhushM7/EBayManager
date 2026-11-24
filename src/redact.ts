// Removes secrets and personal details from text before it is logged. Pure: no I/O.

const RULES: [RegExp, string][] = [
  [/Bearer\s+[\w.~+/=#^-]+/gi, "Bearer [token]"],
  [/v\^1\.1#[^\s"'<>]+/g, "[token]"],
  [/sk-ant-[\w-]+/g, "[key]"],
  [/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]*/g, "[token]"],
  [/((?:access_?token|refresh_?token|token|secret|api_?key|key|code|signature|sig|password|eBayAuthToken)["']?\s*[:=>]\s*["']?)[^\s"'&<>,}]{6,}/gi, "$1[removed]"],
  [/\/s\/[\w-]{6,}/g, "/s/[removed]"],
  [/(\/decide\/[^\s?]+)\?\S+/g, "$1?[removed]"],
  [/<(Buyer|UserID|SenderID|RecipientID|Email|Body|BuyerMessage|SellerResponse)>[\s\S]*?<\/\1>/gi, "<$1>[removed]</$1>"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/\b(?:\+44\s?7|07)\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/g, "[phone]"],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi, "[postcode]"],
];

export function redact(s: string, max = 1000): string {
  let out = String(s);
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}
