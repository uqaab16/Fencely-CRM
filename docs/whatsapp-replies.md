# Signed WhatsApp reply webhooks

Adds `POST /api/whatsapp/webhook` for WA-AKG's signed `message.received`
envelopes. No outbound messages, AI generation or campaign scheduler are added.

## Configuration

Set two server-side Vercel Production environment variables and deploy:

- `WA_WEBHOOK_SECRET`: a NEW random secret of at least 32 characters. Use the
  same value in WA-AKG's Secret Key (HMAC Verification) field. Keep it separate
  from the gateway API key and private worker bridge secret. Never publish it.
- `WA_WEBHOOK_SESSION_ID`: the connected gateway's sessionId, not its DB row ID.

In WA-AKG > Webhooks & API > Add Webhook:

- Name: CRM reply sync.
- URL: your CRM HTTPS origin followed by `/api/whatsapp/webhook`.
- Secret Key: the new webhook secret.
- Subscribed Events: Message Received ONLY. Disable Message Sent and all others.

Save only after the endpoint is deployed. The gateway's signed Test action is
supported; test events make no database changes. Then use your own test lead to
send an ordinary reply, an Interested button response, and finally Stop. Reopen
the CRM drawer after each event to see the new stage and timeline entry.

## Behavior

HMAC SHA-256 verifies the EXACT raw body against X-Webhook-Signature before any
reply writes. Requests over 256 KiB, missing/invalid signatures, stale or invalid
24-hour envelope timestamps, and unexpected sessions are rejected. Only incoming
personal chats with resolved telephone JIDs are accepted. Groups, outgoing
messages, broadcasts/newsletters and unresolved @lid identifiers are ignored;
no phone number is guessed. Failed verification returns no CRM data.

Known numbers are matched using the same selected-number priority as number
checks: explicit WhatsApp number, otherwise mobile, otherwise landline. All
records matching that normalized number receive the event. Unknown ordinary
senders do not create leads. Unknown STOP senders still create a number-wide
suppression so a later import cannot erase that opt-out.

- Ordinary reply: early pipeline stages advance to Replied. Later stages remain.
- Exact `interested` text or matching button ID: Interested, preserving Trial/Demo,
  Customer and Do Not Contact stages.
- Exact opt-out phrases/IDs: Stop, Unsubscribe, Remove me, Do not contact me,
  Not interested, No more messages, or Please stop messaging/contacting me.
  Matching is case-insensitive with optional final punctuation. Substrings such
  as 'stop by tomorrow' are NOT treated as an opt-out. All replies still pause
  automatic follow-ups for manual review; there is no AI intent classifier.
- STOP persists in a separate number-wide suppression table and sets matching
  records to Do Not Contact. Late/concurrent Interested or ordinary replies do
  not reverse it. A manual stage edit does not remove the suppression.

The message timeline deduplicates on (sessionId,messageId). Processing steps are
idempotent: retries resume incomplete work, not duplicate messages. Reply body is
limited to 4,000 characters; attachments are not fetched or stored by this CRM.
Incoming messages never change last_contacted or pretend a message was sent.
Reply receipt clears next_followup and completes automatically named 'Follow up
with ...' tasks. Other manual task titles remain open. Deleting a contractor
removes its inbox links, while opt-out data remains number-wide.

The drawer shows the reply/opt-out state and incoming text in its timeline.
The durable `getWhatsAppOutreachState(number)` is the gate a future sender MUST
consult immediately before sending. This release has no automated sender;
WA-AKG's own manual Chat/Broadcast controls are not intercepted by the CRM.

## Reliability and privacy limits

The reviewed gateway dispatches webhooks in the background and logs failures;
it does not automatically retry this send path. Review failed delivery logs and
use its retry feature. If the endpoint is down or a JID is unresolved, a reply
may not reach the CRM. Automatic reconciliation remains future work. A future
campaign must fail closed when reply delivery cannot be trusted.

Only subscribe the selected outreach account and Message Received. Known-lead
incoming texts will be stored in the CRM and gateway delivery logs. Do not
subscribe unrelated accounts or group/contact/media events.

Validated locally: 29 Node tests pass, including exact-byte HMAC verification,
wrong session, stale timestamp, group/outgoing/LID filtering, button IDs,
concurrent reply/STOP precedence, duplicate receipts, multiple matching leads,
unknown STOP, task handling, stage preservation, and HTTP size/auth boundaries.
Frontend production build passes. No live webhook or real lead message has been
sent by the assistant; signed gateway and user-owned lead tests are required.
