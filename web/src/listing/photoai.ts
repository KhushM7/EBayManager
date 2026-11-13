// The photo editor's AI tools: background removal, spot removal of clutter and upscaling, run on the app's own
// AI service (POST /api/photo-ai/{op}). The service starts only when one of these is used, so the first edit after
// a while can take up to a minute while it wakes. Never used to hide flaws on the item (docs/add-listing.md).

import { SignedOut } from "../api";

export type AiOp = "remove_background" | "erase" | "upscale";

export class PhotoAiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Set once the service says it isn't configured, so the tools show as unavailable for the rest of the visit. */
let notSetUp = false;
export const aiNotSetUp = () => notSetUp;

export async function photoAi(op: AiOp, image: Blob, opts: { mask?: Blob; signal?: AbortSignal } = {}): Promise<{ blob: Blob; edit: string }> {
  const form = new FormData();
  form.append("image", image, "photo.jpg");
  if (opts.mask) form.append("mask", opts.mask, "mask.png");
  let res: Response;
  try {
    res = await fetch(`/api/photo-ai/${op}`, { method: "POST", credentials: "same-origin", headers: { "X-EbayManager": "1" }, body: form, signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new PhotoAiError("Couldn't reach the AI tools. Check your connection and try again.", 0);
  }
  if (res.status === 401) throw new SignedOut();
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (res.status === 503 && data.code === "not_set_up") notSetUp = true;
    const fallback = res.status >= 500 ? "The AI tools didn't answer. Nothing was changed: try again in a moment." : `That didn't work (${res.status}).`;
    throw new PhotoAiError(data.error ?? fallback, res.status, data.code);
  }
  const fallbackEdit = op === "remove_background" ? "ai_background" : op === "erase" ? "ai_erase" : "ai_upscale";
  return { blob: await res.blob(), edit: res.headers.get("X-Edit") ?? fallbackEdit };
}
