import type { Env } from "../env";
import { trading } from "./trading";
import { list, num } from "../util";

// Account history for the first-day audit (docs/listing-assistant.md), read with Trading read verbs only:
// recently sold and ended-unsold listings, K's past answers to buyers, and the seller record. Buyer IDs are
// used only in memory and never stored.

const DAY = 86_400_000;

export interface EndedListing {
  itemId: string;
  title: string;
  price: number | null;
  startTime: string | null;
  endTime: string | null;
  watchers: number;
  views: number | null;
  questions: number;
}

export interface RecentSale {
  itemId: string;
  title: string;
  price: number | null;
  soldAt: string | null;
  startTime: string | null;
}

export function toUnsold(doc: any): EndedListing[] {
  return list<any>(doc?.UnsoldList?.ItemArray?.Item).map((i) => ({
    itemId: String(i.ItemID),
    title: String(i.Title ?? ""),
    price: num(i.SellingStatus?.CurrentPrice) ?? num(i.BuyItNowPrice) ?? num(i.StartPrice),
    startTime: i.ListingDetails?.StartTime ?? null,
    endTime: i.ListingDetails?.EndTime ?? null,
    watchers: Number(i.WatchCount ?? 0),
    views: num(i.HitCount),
    questions: Number(i.QuestionCount ?? 0),
  }));
}

export function toSold(doc: any): RecentSale[] {
  return list<any>(doc?.SoldList?.OrderTransactionArray?.OrderTransaction).flatMap((ot) => {
    const txs = ot.Transaction ? list<any>(ot.Transaction) : list<any>(ot.Order?.TransactionArray?.Transaction);
    return txs.map((t) => ({
      itemId: String(t.Item?.ItemID ?? ""),
      title: String(t.Item?.Title ?? ""),
      price: num(t.TransactionPrice) ?? num(t.Item?.SellingStatus?.CurrentPrice),
      soldAt: t.CreatedDate ?? t.PaidTime ?? null,
      startTime: t.Item?.ListingDetails?.StartTime ?? null,
    }));
  });
}

/** Sold and ended-unsold listings from the last 60 days (eBay's limit for these lists). */
export async function getSoldAndUnsold(env: Env): Promise<{ sold: RecentSale[]; unsold: EndedListing[] }> {
  const sold: RecentSale[] = [];
  const unsold: EndedListing[] = [];
  for (let page = 1; page <= 5; page++) {
    const pg = `<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`;
    const doc = await trading(
      env,
      "GetMyeBaySelling",
      `<SoldList><Include>true</Include><DurationInDays>60</DurationInDays>${pg}</SoldList>
       <UnsoldList><Include>true</Include><DurationInDays>60</DurationInDays>${pg}</UnsoldList>
       <DetailLevel>ReturnAll</DetailLevel>`,
    );
    sold.push(...toSold(doc));
    unsold.push(...toUnsold(doc));
    const pages = Math.max(Number(doc.SoldList?.PaginationResult?.TotalNumberOfPages ?? 1), Number(doc.UnsoldList?.PaginationResult?.TotalNumberOfPages ?? 1));
    if (page >= pages) break;
  }
  return { sold, unsold };
}

/** One of K's past answers to a buyer, with what the buyer asked. No buyer IDs. */
export interface PastReply {
  question: string;
  reply: string;
  itemTitle: string;
  at: string | null;
}

export function toAnswered(doc: any): PastReply[] {
  return list<any>(doc?.MemberMessage?.MemberMessageExchange)
    .map((x) => ({
      question: String(x.Question?.Body ?? ""),
      reply: list<any>(x.Response).map(String).join("\n").trim(),
      itemTitle: String(x.Item?.Title ?? ""),
      at: x.LastModifiedDate ?? x.CreationDate ?? null,
    }))
    .filter((r) => r.reply);
}

/** K's answers to buyer questions over the last year (eBay keeps about that long), newest windows first. */
export async function getAnsweredQuestions(env: Env, maxReplies = 80): Promise<PastReply[]> {
  const out: PastReply[] = [];
  const now = Date.now();
  // eBay limits each lookup's date range, so walk back in 30-day windows.
  for (let w = 0; w < 12 && out.length < maxReplies; w++) {
    const end = new Date(now - w * 30 * DAY);
    const start = new Date(now - (w + 1) * 30 * DAY);
    const doc = await trading(
      env,
      "GetMemberMessages",
      `<MailMessageType>AskSellerQuestion</MailMessageType><MessageStatus>Answered</MessageStatus>
       <StartCreationTime>${start.toISOString()}</StartCreationTime><EndCreationTime>${end.toISOString()}</EndCreationTime>
       <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>`,
    );
    out.push(...toAnswered(doc));
  }
  return out.slice(0, maxReplies);
}

/** The words K typed in a sent eBay message: eBay wraps them in its own template. */
export function messageText(html: string): string {
  const typed = html.match(/<div[^>]*id="UserInputtedText"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? html;
  return typed
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** K's sent messages (the Sent folder) over the last year, for messages that weren't question answers. */
export async function getSentMessages(env: Env, max = 40): Promise<PastReply[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 365 * DAY);
  const headers = await trading(
    env,
    "GetMyMessages",
    `<FolderID>1</FolderID><DetailLevel>ReturnHeaders</DetailLevel>
     <StartTime>${start.toISOString()}</StartTime><EndTime>${end.toISOString()}</EndTime>`,
  );
  const ids = list<any>(headers?.Messages?.Message)
    .map((m) => String(m.MessageID))
    .slice(0, max);
  const out: PastReply[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const doc = await trading(
      env,
      "GetMyMessages",
      `<MessageIDs>${ids
        .slice(i, i + 10)
        .map((id) => `<MessageID>${id.replace(/\D/g, "")}</MessageID>`)
        .join("")}</MessageIDs><DetailLevel>ReturnMessages</DetailLevel>`,
    );
    for (const m of list<any>(doc?.Messages?.Message)) {
      const reply = messageText(String(m.Text ?? m.Content ?? ""));
      if (reply) out.push({ question: "", reply: reply.slice(0, 1500), itemTitle: String(m.ItemTitle ?? m.Subject ?? ""), at: m.ReceiveDate ?? null });
    }
  }
  return out;
}

export interface SellerRecord {
  userId: string;
  feedbackScore: number | null;
  positivePercent: number | null;
  registeredAt: string | null;
  /** Private, Commercial or Undefined. A business seller pays final value fees the engine doesn't yet count. */
  businessType: string | null;
  storeOwner: boolean;
}

export function toSeller(doc: any): SellerRecord {
  const u = doc?.User ?? {};
  return {
    userId: String(u.UserID ?? ""),
    feedbackScore: num(u.FeedbackScore),
    positivePercent: num(u.PositiveFeedbackPercent),
    registeredAt: u.RegistrationDate ?? null,
    businessType: u.SellerInfo?.SellerBusinessType ?? null,
    storeOwner: String(u.SellerInfo?.StoreOwner) === "true",
  };
}

export async function getSeller(env: Env): Promise<SellerRecord> {
  return toSeller(await trading(env, "GetUser", `<DetailLevel>ReturnAll</DetailLevel>`));
}
