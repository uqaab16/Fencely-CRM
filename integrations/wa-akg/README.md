# Gateway dependency update

`security-update.patch` applies only to WA-AKG source commit
`936b26bf7c96bb5776e00224c3803c1bf39c7c71`. It changes `package.json` and
`package-lock.json`; it does not alter OpenClaw, secrets, databases or running
containers. Apply it inside the separate gateway checkout, not inside this CRM.

Updates: Next.js/eslint-config-next 16.4.2, next-auth 5.0.0-beta.32
(@auth/core 0.41.3), Sharp 0.35.5, systeminformation 5.33.16, plus compatible
transitive dependency updates. Sticker-only overrides use Axios 1.20.0 and
image-size 2.0.4. No global force audit fix was used.

Validated locally with Node 24.19.0: Prisma generation, full production build
including TypeScript, 23 existing locale tests (`node --import tsx --test
src/i18n/__tests__/*.test.ts`), and sticker conversion from both a generated PNG
buffer and a loopback HTTP URL. No live WhatsApp account was connected.

Production dependency audit at preparation: **0 critical, 0 high, 4 moderate**.
Remaining moderate chains: typography/postcss-selector-parser and
wa-sticker-formatter/file-type (malformed ASF parser input). This is not a clean
audit or a guarantee of security. Keep initial deployment private; limit media
features and review these dependencies before production exposure.

Patch SHA-256:
`f91fb3a14c4057c7b5779b786ef00783ca8cdd8a306d8b84fb83eda0534e2773`

Apply only after confirming the source SHA and running `git apply --check`.
Build a new tag (for example `fencely-wa:security-v1`) with the resource-limited
`fencely-builder`; retain `fencely-wa:936b26b` as a rollback image. Audit the final
image again because its Dockerfile prunes and reinstalls runtime tooling.
Runtime login, QR pairing, number checks and actual messaging remain untested.
