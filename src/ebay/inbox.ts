import type { Env } from "../env";
import { trading } from "./trading";

// Buyer questions and Best Offers, read with Trading read verbs only. Replies and offer responses are
// proposals applied by the write gate (src/ebay/write.ts).

export interface Question {
  messageId: string;
  itemId: string;
  itemTitle: string;
  sender: string;
  body: string;
  receivedAt: number;
}

export interface Offer {
  bestOfferId: string;
  itemId: string;
  itemTitle: string;
  listPrice: number | null;
  price: number;
  buyer: string;
  buyerMessage: string;
  expiresAt: number | null;
}

const num = (v: any) => (v == null ? null : Number(v?.["#text"] ?? v));

export function toQuestions(doc: any): Question[] {
  const exchanges = [doc.MemberMessage?.MemberMessageExchange ?? []].flat();
  return exchanges
    .filter((x: any) => x.Question?.MessageID)
    .map((x: any) => ({
      messageId: String(x.Question.MessageID),
      itemId: String(x.Item?.ItemID ?? ""),
      itemTitle: String(x.Item?.Title ?? ""),
      sender: String(x.Question.SenderID ?? ""),
      body: String(x.Question.Body ?? ""),
      receivedAt: Date.parse(x.CreationDate ?? x.Question.CreationDate ?? "") || Date.now(),
    }));
}

export function toOffers(doc: any): Offer[] {
  const items = [doc.ItemBestOffersArray?.ItemBestOffers ?? []].flat();
  return items.flatMap((ib: any) =>
    [ib.BestOfferArray?.BestOffer ?? []].flat().map((o: any) => ({
      bestOfferId: String(o.BestOfferID),
      itemId: String(ib.Item?.ItemID ?? ""),
      itemTitle: String(ib.Item?.Title ?? ""),
      listPrice: num(ib.Item?.BuyItNowPrice ?? ib.Item?.SellingStatus?.CurrentPrice),
      price: Number(num(o.Price) ?? 0),
      buyer: String(o.Buyer?.UserID ?? ""),
      buyerMessage: String(o.BuyerMessage ?? ""),
      expiresAt: Date.parse(o.ExpirationTime ?? "") || null,
    })),
  );
}

/** Unanswered "ask the seller a question" messages from the last 30 days. */
export async function getUnansweredQuestions(env: Env): Promise<Question[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const doc = await trading(
    env,
    "GetMemberMessages",
    `<MailMessageType>AskSellerQuestion</MailMessageType><MessageStatus>Unanswered</MessageStatus>
     <StartCreationTime>${start.toISOString()}</StartCreationTime><EndCreationTime>${end.toISOString()}</EndCreationTime>
     <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>`,
  );
  return toQuestions(doc);
}

/** Active Best Offers across all listings. */
export async function getActiveOffers(env: Env): Promise<Offer[]> {
  const doc = await trading(env, "GetBestOffers", `<BestOfferStatus>Active</BestOfferStatus><DetailLevel>ReturnAll</DetailLevel>`);
  return toOffers(doc);
}
