# WhatsApp integration — stage 1

Implemented: authenticated single-number registration checks, stored separately
from the existing advertised-WhatsApp field. No messages are sent by this feature.
Existing contractor records and MCP tools are preserved. The new table is created
automatically in local SQLite and Turso; existing tables need no column migration.

## Connect your gateway

Run your own WA-AKG server with a connected WhatsApp session. On the CRM backend
(Vercel environment settings or your local server environment), set:

```
WA_AKG_URL=https://your-gateway-host
WA_AKG_API_KEY=your-gateway-api-key
WA_AKG_SESSION_ID=your-connected-session-id
```

Use HTTPS for a remotely hosted gateway. Use the gateway origin, not a URL ending
in `/api`. These settings never go in frontend variables or the Git repository.
Redeploy/restart the CRM after setting them. A browser tab or a Vercel function
cannot keep the persistent WA-AKG connection running; the gateway needs its own
running host. Local MCP processes need these environment settings separately.

Open a contractor drawer and choose **Check WhatsApp**. The selected number is
sent to your gateway; no test message is sent. Number priority is explicit
WhatsApp number, otherwise mobile, otherwise landline. Invalid explicit numbers
are flagged rather than silently replaced with another number. Australian
national numbers and explicit international formats are accepted.

API: `POST /api/contractors/:id/whatsapp-check` with the existing login JWT.
Configuration status: `GET /api/whatsapp/config` (authenticated, no secrets).
MCP: `check_whatsapp({id})` on both local stdio and remote endpoints.
Search API also accepts `whatsapp_verification=available`, `not_found`, `invalid`,
`check_failed`, or `not_checked`.

## Result interpretation

| Result | Meaning |
|---|---|
| Not checked | No matching stored check for the current number |
| WhatsApp available | Gateway returned a positive registration result at check time |
| WhatsApp not found — unconfirmed | Gateway returned false; hold sending and recheck/manual review |
| Invalid or missing number | Input cannot be safely normalised |
| Check failed — retry later | Connection, authentication, timeout, or response problem |

The upstream check route was inspected at WA-AKG main during implementation:
`src/app/api/chat/[sessionId]/check/route.ts`. It returns
`{status:true,data:{results:[{number,exists,jid,error?}]}}`.
It collapses an empty Baileys result into `exists:false`, so this CRM deliberately
does not treat a negative result as confirmed permanent non-registration.
Errors are never classified as non-registration. Changing a contractor's phone
invalidates the displayed result. An unavailable gateway does not overwrite a
previous check. Registration is not proof of marketing consent or delivery.

## Still required for a live campaign

- A running gateway and paired session; test positive, negative and timeout cases.
- Consent records and suppression rules, a durable queue with daily/timezone limits.
- An AI API or a tested local model for generation at send time. The existing
  Claude MCP connector alone is not a scheduler-triggered model endpoint.
- Outbound message adapter, authenticated inbound webhooks, reply/STOP handling,
  deduplication and button compatibility tests.

Do not enable live campaigns from this stage. Nothing here starts one, installs
WA-AKG on your host, pairs an account, checks your real contractor list, or deploys
to Vercel. No software or delay setting guarantees protection from WhatsApp bans.
