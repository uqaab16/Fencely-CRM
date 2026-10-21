# Reviewed WhatsApp campaigns

## User flow

1. Ask Claude to select up to 20 eligible leads and show a separate customised message for each **in chat**. Review and revise in chat first.
2. Explicitly ask Claude to add the final batch to CRM. `save_campaign_drafts` saves the batch with a name, Australian recipient time zone and contractor IDs/messages. Saving never sends.
3. Open Campaigns in CRM, choose the batch, review/edit messages and choose the recipient time zone and 12-hour window. Save draft edits.
4. Confirm recipient permission and click Start. Start also saves outstanding draft edits before starting. MCP cannot start campaigns. Started batches are locked against editing; Pause/Resume controls stop/start remaining work.
5. Refresh/reopen the batch to see queued, checking, sending, sent, skipped or uncertain per recipient. Sent means the gateway accepted it, not delivered/read. Successful sends appear in the lead timeline and update last_contacted/stage without undoing replies/opt-outs.

Schedules default to Monday–Friday, 20/day and 08:00–20:00 in the explicitly selected Australian time zone. Use separate batches for different recipient time zones. Daylight saving follows the actual date. At most one attempt is reserved per campaign time slot. A shared global guard enforces a minimum 36-minute gap and at most 20 attempts in a rolling 24 hours across all campaigns, even with different time zones. There is no catch-up burst after downtime. A batch with 20 messages may take more than one weekday to finish if started late or interrupted.

## Draft and permission boundaries

Remote/stdio MCP expose `list_campaigns`, `get_campaign`, `save_campaign_drafts` only. Show all messages for review in chat before saving. Replacement saves require the latest ID/revision. Conflicting edits are rejected. Creation retries after an uncertain response can create a second draft: list before retrying. Duplicate drafts never send without a separate CRM Start.

All draft recipients are validated before a single save write. Missing/deleted leads, invalid/duplicate numbers, existing replies and durable opt-outs are rejected. Start records the logged-in user's permission confirmation and revision; a checked box is a user assertion, not independent proof of consent. Number registration is not permission. No account-safety guarantee is implied by limits, personalisation or delays.

## Delivery boundary

A separate outbound-only Python worker polls CRM. Its secret is different from the registration bridge, webhook and gateway credentials. It opens no listener/port and uses the existing gateway on loopback. It claims one recipient, checks registration locally and obtains a single-use CRM permit. Authorization rechecks schedule, campaign state, raw phone snapshot, replies, suppressions, global capacity and prior attempts to the same number. Registration errors/not-found skip sending without declaring permanent non-registration. It sends the reviewed text with Interested/Stop quick-reply buttons and an empty footer. A link can be part of reviewed text; media upload/automatic follow-ups are not implemented.

Pause/STOP received before the permit prevent the attempt. A permit expires after ten seconds; an already authorized/in-flight WhatsApp request cannot be recalled. Inbound webhook delivery can fail or arrive late, so this cannot guarantee instantaneous opt-out detection. The existing gateway webhook logs must be monitored/retried if needed.

The worker writes and fsyncs a local receipt journal **before authorization**. It invokes the gateway at most once; timeouts, invalid responses and crashes become uncertain outcomes and never cause automatic send retries. Only CRM acknowledgement is retried on restart. Unknown sends pause their campaign. New dispatches are globally blocked while any send awaits its receipt. A lost journal/disk during an in-flight send needs manual reconciliation: do not reset the queue or blindly resend. A conflicted receipt is retained and blocks worker progress until reviewed. Unknown attempts cannot be retried through the UI.

## Deployment (sending remains disabled by default)

Merge/build the application first. Existing number-check worker, OpenClaw, Traefik and gateway containers require no restart or changes.

1. Generate a new 32+ character sender secret in `/opt/fencely-wa/crm-sender-secret`, permissions 0600. Never use an existing secret or publish it.
2. Set Vercel Production `WA_SENDER_SECRET` to that value, `WA_SEND_MODE=test`, and `WA_SENDER_TEST_NUMBERS` to only user-owned test numbers in international digits (comma separated, no spaces/leading + needed). Redeploy. Leave real outreach disabled during validation.
3. Download `integrations/wa-akg/campaign-worker.py` and `fencely-sender.service` from the reviewed commit, verify SHA-256, and install the unit in `/etc/systemd/system/`. It reuses the existing private `worker.env` with CRM_ORIGIN and WA_AKG_SESSION_ID. The systemd StateDirectory provides `/var/lib/fencely-sender` with mode 0700; worker memory/CPU are capped at 128MB/10%. No existing services are modified.
4. Enable/start only `fencely-sender`. Confirm logs/status, then make a fresh draft with a permitted personal test number that has not already replied/opted out. Existing STOP test numbers remain suppressed; do not erase suppression to bypass this.
5. Test one real gateway send, buttons, CRM receipt/timeline, Pause and no duplicate on worker restart. Node/Python automated tests do not prove actual gateway delivery.
6. Only after test review and explicit real-campaign approval should production mode be changed to `live`. Start still requires CRM permission confirmation. Keep disabled/test mode otherwise.

To stop dispatches, Pause campaigns and stop `fencely-sender`; then set WA_SEND_MODE=disabled and redeploy as needed. Preserve the receipt journal until outstanding sends are reconciled. Registration checks can continue independently.

## Verification

`npm test`, `python3 tests/campaign-worker-test.py`, and `cd web && npm run build`.
