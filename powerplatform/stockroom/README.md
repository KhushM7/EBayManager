# Stock Room: the Power Apps canvas app

EBayManager starts when someone decides to list a thing. Stock Room covers the step before: anyone in the
family logs things around the house they might sell, with a photo, where it is and whose it is, and marks each
**Sell**, **Keep** or **Ask K**. A flow sends the ones marked Sell to EBayManager as **drafts only**. A draft
is not a listing or a proposal: someone still takes it through the New listing wizard (photos, condition,
price, postage) and a person approves the label before anything reaches eBay.

Not built yet: this is the recipe.

## 1. Dataverse tables

Make them in a solution named `Stock Room` (Power Apps → Solutions → New solution), so they can be exported.

**Owner** (`sr_owner`)
| Column | Type | Notes |
| --- | --- | --- |
| Name | Text (primary) | "Mum", "Dad", "K" |
| Email | Email | for reminders; never sent to EBayManager |

**Location** (`sr_location`)
| Column | Type | Notes |
| --- | --- | --- |
| Name | Text (primary) | "Garage, box 3" |
| Room | Choice | Garage, Loft, Kitchen, Living room, Bedroom, Other |

**Item** (`sr_item`)
| Column | Type | Notes |
| --- | --- | --- |
| Name | Text (primary, 80) | what it is, in the family's words |
| Photo | Image | tick "Can store full images" |
| Condition | Choice | New, Like new, Used: works, Used: marks, Not working |
| Location | Lookup → Location | |
| Owner | Lookup → Owner | |
| Decision | Choice | Undecided (default), Sell, Keep, Ask K |
| Notes | Multiline text | stays in Stock Room; not sent |
| Sent to EBayManager | Yes/No | default No; set by the flow |
| Draft id | Text | set by the flow |
| Send result | Text | what EBayManager answered |

## 2. The app

Power Apps → Create → Start with data → pick **Item** (a three-screen app: browse, detail, edit), phone layout.
Then:

- **Browse screen gallery `Items`**: `SortByColumns(Filter(Items, StartsWith(Name, SearchBox.Text)), "createdon", SortOrder.Descending)`. Show the photo, the name, and a label `Text(ThisItem.Decision)`. Colour the label: `Switch(ThisItem.Decision, 'Decision (Items)'.Sell, Color.SeaGreen, 'Decision (Items)'.'Ask K', Color.DarkOrange, Color.Gray)`.
- **Filter chips** above the gallery (a horizontal gallery over `Choices('Decision (Items)')`), with the gallery filter extended: `Filter(Items, IsBlank(SelectedDecision) || Decision = SelectedDecision)`.
- **Edit form**: fields Name, Photo, Condition, Location, Owner, Decision, Notes. The Photo card's default control takes a picture or a file. Hide `Sent to EBayManager`, `Draft id` and `Send result` on the edit form; show them read-only on the detail screen.
- **Save button** `OnSelect`: `SubmitForm(EditForm1)`; form `OnSuccess`: `Notify(If(EditForm1.LastSubmit.Decision = 'Decision (Items)'.Sell, "Saved. It will appear in EBayManager's drafts in a minute.", "Saved."), NotificationType.Success); Back()`.
- **Lock a sent item**: Decision card `DisplayMode`: `If(ThisItem.'Sent to EBayManager', DisplayMode.View, DisplayMode.Edit)`, so a sent item isn't sent twice by flipping it back and forth (the app also refuses a second draft for the same row).
- **Detail screen** label when sent: `"Sent to EBayManager as a draft. Finish it in the app: New listing."`

Share the app with the family (each needs a licence that covers Dataverse; the Developer Plan environment is
for K alone, so sharing is a licensing question for K, see the main doc).

## 3. The flow: send "Sell" items as drafts

Needs the intake connector (`../connector/ebaymanager-intake.swagger.json`, key `INTAKE_API_KEY`).

1. Trigger Dataverse → **When a row is added, modified or deleted**: change type Added or Modified, table Items, scope Organization, select columns `sr_decision`, filter rows `sr_decision eq <the Sell value> and sr_senttoebaymanager eq false`.
2. Dataverse → **Download a file or an image**: table Items, row id from the trigger, column Photo, and tick full size. Under **Configure run after** on the next step, tick both "is successful" and "has failed", so an item with no photo still goes.
3. EBayManager Stock Room intake → **Send an item as a draft**
   - Row id: the trigger's Item id (`sr_itemid`)
   - Item name: Name
   - Owner: the Owner lookup's name; Location: the Location lookup's name; Condition: the Condition label
   - Photo (base64): `if(equals(actions('Download_a_file_or_an_image')?['status'], 'Succeeded'), base64(body('Download_a_file_or_an_image')), '')`
4. If step 3 fails because of the photo (status 400; EBayManager takes a JPEG of at least 500 pixels on its long side and at most 6 MB), a parallel branch set to run after "has failed" repeats step 3 with the photo empty. The person adds photos in the wizard anyway.
5. Dataverse → **Update a row**: Sent to EBayManager Yes, Draft id `body('Send_an_item_as_a_draft')?['draftId']`, Send result `body('Send_an_item_as_a_draft')?['status']`.

What EBayManager does with it (`src/intake.ts`): makes one draft named for the item, with the room, condition
and owner in the draft's label (shown only in the drafts list), and stores the photo after the same checks as
any upload, metadata stripped. It does not treat what the family typed as facts about the item: the wizard
asks whoever lists it. Limits: 30 drafts a day, 50 open drafts in all, one draft per Stock Room row.

## Check it

- Add an item marked Keep: nothing appears in EBayManager.
- Change it to Sell: within a minute a draft appears under New listing → drafts, with the photo. The item shows Sent.
- Change the name and save again: no second draft.
- EBayManager's Inbox and Activity show nothing new: a draft is not a proposal.
