# Reviewed campaign drafts

This phase stores and edits drafts only. No sender, Start endpoint, worker, automatic follow-up or media upload is enabled.

## Review flow

1. Ask Claude to select up to 20 leads and show a separate message for each in chat. Review and revise in chat first.
2. Explicitly ask Claude to add the final batch to CRM. `save_campaign_drafts` saves the whole batch with a name, an Australian recipient time zone, and contractor IDs/messages.
3. Open Campaigns in CRM, select the batch and edit individual messages if needed. Click Save draft edits.
4. Starting delivery is a separate future step. Saving never sends.

Remote and stdio MCP expose `list_campaigns`, `get_campaign` and `save_campaign_drafts`. For replacement, get the latest campaign and submit its ID and revision. Conflicting edits are rejected. A retry of creation can create another draft batch: list campaigns before retrying a request with an uncertain outcome. Draft batches never trigger sends.

Schedules default to Monday–Friday, 20 messages/day and 08:00–20:00 in an explicitly supplied Australian time zone. Smaller daily limits are supported. The schedule helper applies daylight saving by date. Each of the 20 slots is 36 minutes wide; the future delivery worker must enforce persistent slot claims, a global daily cap and minimum spacing across campaigns, without catching up missed slots in a burst. The helper alone is not a rate limiter.

Saving rejects missing/deleted leads, invalid/duplicate numbers, opt-outs and existing replies. All validation completes before a single database write; replacements use revision compare-and-swap. Before each future send the delivery system must recheck phone changes, registration, consent, suppression/replies, campaign state and schedule. A saved draft is not evidence of marketing consent. No safe-account guarantee is implied by scheduling.

The sender remains unimplemented: uncertain delivery outcomes must never be retried blindly; a successful gateway result must be durably reconciled with the CRM before moving on. Native Interested/Stop buttons and media require separate gateway payload validation and end-to-end tests.
