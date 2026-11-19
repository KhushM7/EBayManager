# The Power Automate flows

Three scheduled cloud flows over the read-only connector (`../connector/`). They read and they tell people.
None of them decides anything: there is no action in the connector that could, and every button opens
EBayManager, where a signed-in person approves or rejects as always.

**Built and tested against Sandbox (2026-11-19):** the weekly digest and the approval nudges, in K's developer
environment, sending from Outlook.com. **Not built:** the Teams card, because the work account has no Teams licence
(see Flow 3). Expressions are written as Power Automate expects them; check each step's name matches (an
expression names its step, with spaces as underscores).

## Sending email: use Outlook.com

The recipe first said Office 365 Outlook. On a Developer Plan tenant that doesn't work and neither does the obvious
fallback:

- **Office 365 Outlook** needs an Exchange mailbox, and a work account made in K's own Entra directory has none.
- **Mail** ("Send an email notification (V3)", free) creates its connection, then every send fails with 401: *"The
  Mail connector is currently restricted for new tenants."*
- **Outlook.com** → **Send an email (V2)** works. It signs in with K's personal @outlook.com account (a pop-up K
  completes) and sends from that address. It's a standard connector, so it costs nothing.

## Working in the new designer

Things that differed from what the recipe assumes (2026-11-19):

- **Expressions:** focus the field, type `/` and choose **Insert expression** (or the *fx* button beside the field),
  type the expression *without* the leading `@`, then **Add**. Leave no space after commas: with `, ` the editor
  said "The expression has a problem" for an expression that was fine without the spaces.
- **Filter array:** **Edit in advanced mode**, then type the condition *with* its leading `@` straight into the box.
- **The To box** is a people picker that won't take an expression. Open the gear beside it, choose **Use dynamic
  content**, then insert the expression.
- **A rich-text Body** (Outlook.com) takes an expression from the *fx* button; typing `/` there inserted nothing.
  For the HTML bodies below, one `concat()` expression builds the whole body.
- Renaming a step (click its title in the panel) changes the name expressions use: `People`, `Due`.
- Outputs from the connector show as `body/subject`, `body/html` and so on in the dynamic content list.

Before starting: import the read-only connector and make its connection (see `../connector/README.md`).

## Who is who

The API never sends an email address. It says who a change is waiting for by name: `owner`, or the name of the
person who made the draft (a Stock Room item reads like `Mum (Stock Room)`). Each flow turns a name into an
address with one **Compose** step named `People`:

```json
{ "owner": "k@example.com", "K": "k@example.com", "Mum (Stock Room)": "mum@example.com", "Dad (Stock Room)": "dad@example.com" }
```

and reads it with `coalesce(outputs('People')?[items('Apply_to_each')?['for']], outputs('People')?['owner'])`,
so anyone not in the list falls back to the owner.

## Flow 1. Approval nudges

A proposal expires after 7 days. This reminds the right person when it has waited 48 hours, and again in its
last 24 hours. It runs hourly and each test is one hour wide, so each reminder is sent once.

1. Trigger **Recurrence**: every 1 hour.
2. **Compose** `People` (above).
3. EBayManager (read-only) → **List changes waiting for a decision**.
4. **Filter array** `Due`, from `body('List_changes_waiting_for_a_decision')?['items']`, advanced mode:
   ```
   @or(
     and(greaterOrEquals(item()?['hours_waiting'], 48), less(item()?['hours_waiting'], 49)),
     and(lessOrEquals(item()?['hours_left'], 24), greater(item()?['hours_left'], 23))
   )
   ```
5. **Apply to each** over `body('Due')`:
   - Outlook.com → **Send an email (V2)**
     - To: `coalesce(outputs('People')?[items('Apply_to_each')?['for']],outputs('People')?['owner'])`
     - Subject: `concat('Waiting for you: ',items('Apply_to_each')?['kind_label'],' - ',coalesce(items('Apply_to_each')?['item_title'],'eBay'))`
     - Body, as one expression:
       ```
       concat('<p>',items('Apply_to_each')?['kind_label'],' for <strong>',coalesce(items('Apply_to_each')?['item_title'],'eBay'),'</strong> is waiting for a decision.</p><p>',coalesce(items('Apply_to_each')?['reason'],''),'</p><p>It expires in about ',formatNumber(items('Apply_to_each')?['hours_left'],'0'),' hours. Nothing changes on eBay unless you approve it.</p><p><a href=',coalesce(items('Apply_to_each')?['approve_url'],items('Apply_to_each')?['open_url']),'>Open it in EBayManager</a></p>')
       ```
       which writes the same as this template:
       ```html
       <p>@{items('Apply_to_each')?['kind_label']} for <strong>@{items('Apply_to_each')?['item_title']}</strong> is waiting for a decision.</p>
       <p>@{items('Apply_to_each')?['reason']}</p>
       <p>It expires in about @{formatNumber(items('Apply_to_each')?['hours_left'], '0')} hours. Nothing changes on eBay unless you approve it.</p>
       <p><a href="@{coalesce(items('Apply_to_each')?['approve_url'], items('Apply_to_each')?['open_url'])}">Open it in EBayManager</a></p>
       ```

The link is the app (Sandbox) or the same signed, expiring approval page a push notification opens (the real
account, where it also needs a signed-in device). Opening it shows the change; the person presses the button there.

## Flow 2. Weekly family digest

1. Trigger **Recurrence**: every 1 week, on Sunday, at 18:00, time zone London.
2. EBayManager (read-only) → **Get the digest**, Days `7`.
3. Outlook.com → **Send an email (V2)**
   - To: the family's addresses
   - Subject: **subject** from Get the digest (dynamic content, shown as `body/subject`)
   - Body: **html** from Get the digest (dynamic content, `body/html`)

The digest is written by the app in plain English: what sold, what is waiting and for whom, what was suggested
and why. It carries no buyer names or messages. Replies to buyers are counted but never quoted.

## Flow 3. Teams card for K

**Not built (2026-11-19):** posting as the Flow bot needs a Teams licence, and the work account has none (Teams sends
it back to the sign-in page). Microsoft 365 or Teams Essentials would cost money, so this waits for K's decision.
The recipe below is unchanged and untested.

New proposals appear as an adaptive card in K's Teams chat with the Flow bot.

1. Trigger **Recurrence**: every 15 minutes.
2. EBayManager (read-only) → **List changes waiting for a decision**.
3. **Filter array** `New`, from `body('List_changes_waiting_for_a_decision')?['items']`, advanced mode:
   ```
   @less(item()?['hours_waiting'], 0.25)
   ```
4. **Apply to each** over `body('New')`:
   - Microsoft Teams → **Post card in a chat or channel**: post as Flow bot, post in Chat with Flow bot, recipient K. Adaptive card: the contents of `teams-card.json`.

The card's buttons are `Action.OpenUrl` only. There is no `Action.Submit` or `Action.Execute`, so the flow
never receives a decision and has nothing to record or apply.

A proposal made within a few seconds of a run's edge can show twice or be missed; the push notification from
the app is still the main alert, and Flow 1 catches anything left waiting.

## Check each flow

What was checked on 2026-11-19, against Sandbox:

- **Weekly digest:** run by hand. Get the digest returned the week (0 sales, 3 waiting, 9 suggested, Claude cost)
  with no buyer details, and the email reached K's Gmail.
- **Approval nudges:** run by hand with the real filter. Two changes were waiting (the first had waited 91 hours, 77 left), neither in a
  reminder window, so nothing was sent, as intended. Then, for one test run, the filter was widened to every waiting
  change. Two emails arrived with the right subject, reason, hours left and the app link (Sandbox gives no signed
  link). `Sandbox test key` isn't in `People`, so it fell back to the owner's address. The real filter was then
  put back and saved.

- Run it by hand (Test → Manually). On Sandbox, file a proposal first so something is waiting.
- Turn off the read-only connection and run again: the flow should fail at the connector step and send nothing.
- Confirm in EBayManager's Activity page that running a flow adds no entry: flows don't touch the write gate.
