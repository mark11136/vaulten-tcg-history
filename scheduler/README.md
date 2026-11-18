# Independent free refresh scheduler

The `vaulten-history-scheduler` Cloudflare Worker dispatches the existing `mark11136/vaulten-tcg-history` GitHub workflow on `main` at **01:13, 07:13, 13:13 and 19:13 UTC**. It always sends `bootstrap=false` and `redeploy=false`. The validated source collection, cache, 24-hour request ledger, publication checks and real source timestamps remain in GitHub Actions. There is no public HTTP dispatch route; workers.dev and preview URLs are disabled. This Worker is separate from the Pages project's public JWKS Function.

## Credential and recovery

Only the encrypted Cloudflare Secret **GITHUB_DISPATCH_TOKEN** stores the fine-grained GitHub token. Its access is restricted to **mark11136/vaulten-tcg-history**, **Actions: read and write**, plus GitHub's mandatory Metadata: read. Contents and Workflows write permissions are not needed. Never put the value in this directory, Git, a plain variable or a log, and never export/reuse the GitHub CLI's broader credential.

The token configured on 2026-11-18 expires on **2027-11-17**. Renew it before that date with the same repository restriction and permissions, replace only the encrypted secret, and verify the result. A revoked or expired token makes the scheduled invocation fail visibly; it must not be treated as a source-data delay.

Deploy or restore this small Worker through the already authorized Cloudflare dashboard, using `worker.mjs` and the settings in `wrangler.jsonc`. Keep the existing account on the Free plan. An API-based deployment would require Workers Scripts Write or an equivalent Worker editor role; the existing Pages-only credential must not be assumed to provide it. The Free plan allows 100,000 invocations per day and 10ms CPU per invocation. The scheduler performs one small request four times a day; price processing stays on GitHub.

## Verification and failure handling

A manual scheduled-handler test verifies the Worker, secret and dispatch path. To verify the automatic clock, observe a **real configured Cloudflare scheduled invocation** and its matching successful GitHub run ID. Cron configuration can take up to 15 minutes to propagate; choose an initial test slot at least 16 minutes after saving it. Delete any temporary verification trigger afterward. Keep only the four recurring times above.

Cloudflare-triggered runs appear in GitHub as **workflow_dispatch**, not `schedule`. Match the Cloudflare log's `runId` with the GitHub run; its sanitized log also records `scheduledTime`, HTTP status and acceptance. The GitHub workflow must remain active. Disabling the whole workflow also prevents the Cloudflare dispatcher from working.

Use one primary recurring scheduler. Retain GitHub's `workflow_dispatch` for manual recovery with `bootstrap=false`, `redeploy=false`. If the source marker is unchanged, success correctly skips publication and preserves the original source timestamp. The scheduler does not generate prices, copy forward missing observations, or pretend an unchanged source was updated.

Network, HTTP and malformed-confirmation failures are redacted. Each request has a 15-second timeout and no immediate retry loop. The next scheduled slot retries; existing GitHub concurrency, cache and source-marker no-op controls protect duplicate dispatches. Neither clock nor API promises exactly-once delivery or an absolute delivery guarantee.

## Local tests

From the repository root, `npm test` includes the scheduler tests without using credentials or a network. A local bundle check is `node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config scheduler/wrangler.jsonc`; this must not be confused with a production deployment.

Official references:
- https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/
