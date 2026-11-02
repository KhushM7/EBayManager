import { MIN_DAYS_BETWEEN_PRICE_CHANGES } from "./rules";

// Listing health, scored by rules with no Claude involved. Only flagged listings go on to the nightly triage.

export interface ListingFacts {
  itemId: string;
  title: string;
  price: number;
  watchCount: number;
  startTime: string;
  views7d: number | null;
  impressions7d: number | null;
  pendingProposals: number;
  lastPriceChangeAt: number | null;
}

export interface Flag {
  flag: "stale" | "watched_not_selling" | "low_views" | "low_click_through";
  detail: string;
}

const DAY = 86_400_000;

export function healthFlags(l: ListingFacts, now = Date.now()): Flag[] {
  // Leave alone anything K is already deciding on, or whose price just changed.
  if (l.pendingProposals > 0) return [];
  if (l.lastPriceChangeAt && now - l.lastPriceChangeAt < MIN_DAYS_BETWEEN_PRICE_CHANGES * DAY) return [];

  const days = Math.floor((now - Date.parse(l.startTime)) / DAY);
  const flags: Flag[] = [];
  if (days >= 30 && l.watchCount === 0) flags.push({ flag: "stale", detail: `Listed ${days} days with no watchers.` });
  if (days >= 14 && l.watchCount >= 3)
    flags.push({ flag: "watched_not_selling", detail: `${l.watchCount} watchers but no sale after ${days} days.` });
  if (l.views7d != null && days >= 7 && l.views7d < 5) flags.push({ flag: "low_views", detail: `Only ${l.views7d} views in the last 7 days.` });
  if (l.views7d != null && l.impressions7d != null && l.impressions7d >= 200 && l.views7d / l.impressions7d < 0.005)
    flags.push({
      flag: "low_click_through",
      detail: `Shown ${l.impressions7d} times in search but opened ${l.views7d} times in 7 days.`,
    });
  return flags;
}
