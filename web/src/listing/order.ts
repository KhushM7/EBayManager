// Ordering helpers for Arrange photos (arrange.tsx). Pure, so they're tested (test/listing-frame.test.ts).

/** The list with one item moved from one place to another. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/**
 * Where the item at `i` shows while the item at `from` is held over slot `over`: the held one takes `over`, and
 * the ones between slide one place towards the gap it left. Nothing in the real order changes until the drop.
 */
export function slotFor(i: number, from: number, over: number): number {
  if (i === from) return over;
  if (from < over && i > from && i <= over) return i - 1;
  if (from > over && i >= over && i < from) return i + 1;
  return i;
}

/**
 * The slot nearest a point, by centre. Slots are measured once when a drag starts, so the answer never depends on
 * tiles that are moving (what made the old version flick tiles back and forth).
 */
export function closestSlot(centres: { x: number; y: number }[], p: { x: number; y: number }): number {
  let best = 0;
  let bestD = Infinity;
  centres.forEach((c, i) => {
    const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (d < bestD) (best = i), (bestD = d);
  });
  return best;
}
