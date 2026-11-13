// Runs the on-device background tidy (tidy.ts) off the main thread, so the editor's animations stay smooth while
// it works. One message in (the pixels and options), one out (the result or why it refused).

import { tidy, type TidyOptions } from "./tidy";

interface Job {
  id: number;
  data: Uint8ClampedArray;
  w: number;
  h: number;
  opts: TidyOptions;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, data, w, h, opts } = e.data;
  try {
    const r = tidy({ data, w, h }, opts);
    if ("refused" in r) return self.postMessage({ id, refused: r.refused });
    const out = r.image.data;
    (self as unknown as Worker).postMessage({ id, data: out, w: r.image.w, h: r.image.h, edits: r.edits }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
