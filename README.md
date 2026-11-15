# Deployment Approval Escalation

GitHub environment approvals wait in silence. A deployment job parks
on an environment's required reviewers, GitHub notifies them **once**,
and then nothing happens — no reminder, no escalation, no org-wide
view of what is stuck — until the run **automatically fails 30 days
later**. Teams hand-roll per-repo cleanup workflows to cope. This app
is the cross-repo version nobody sells:

- **Remind** the required reviewers when an approval has waited too long.
- **Escalate** to a fallback team when it waits longer still.
- **Auto-reject** at a configured expiry (opt-in), so dead runs stop hanging.
- **Digest** the week: approvals that waited, the median wait, expiries.

Approvals themselves stay human. The app never approves anything.

## How it works

Two halves share one JSON store:

1. **Webhook server** (`src/server.js`) — receives `workflow_run` and
   `workflow_job` events. When a run or job looks parked, it asks the
   API what is actually pending for that run
   (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments`)
   and tracks each pending deployment: environment, required
   reviewers, waiting-since.
2. **Sweep** (`src/sweep.js`, cron) — the timer wheel. It first
   *reconciles* every installed repo against the API (so missed
   webhooks self-heal, and deployments GitHub stops reporting are
   closed out as resolved), then evaluates every waiting row against
   the repo's policy and acts.

### Actions

| Tier | Default | What happens |
|------|---------|--------------|
| Remind | 4h waiting | A comment on the repo's single tracking issue ("Deployment approvals waiting") @mentioning the pending reviewers for that run. One comment per run per tier — never a drip. |
| Escalate | 24h waiting | A new comment on the same issue @mentioning the configured `escalation_mentions`. Subsumes a missed reminder. |
| Auto-reject | off | Only when `auto_reject_after_hours` is set: the pending deployment is rejected via the pending-deployments review endpoint, the row is closed as `auto_rejected`, and the rejection is noted on the tracking issue. |
| Digest | weekly | One digest issue per repo per ISO week, created once and updated in place: approvals that waited and resolved, median wait, auto-reject count, and what is still waiting. |

When a run leaves waiting — approved, rejected, or completed — its
rows close out with the outcome recorded for the digest.

## Per-repo policy

Optional file `.github/approval-escalation.yml` in each repo (read via
the Contents API; absent or broken = defaults):

```yaml
remind_after_hours: 4          # default 4
escalate_after_hours: 24       # default 24
escalation_mentions:           # users and/or org/team slugs
  - acme/release-leads
  - alice
auto_reject_after_hours: 48    # default: unset = off
digest_weekday: Monday         # default Monday
```

## GitHub App registration (future, gated step)

- **Permissions:** Actions: read · Issues: write · Contents: read ·
  Metadata: read.
  - ⚠️ One caveat to verify at registration: GitHub's fine-grained
    permission documentation describes the pending-deployments
    **review** POST as requiring Actions **write**. If that holds for
    GitHub App installation tokens, enabling `auto_reject_after_hours`
    needs Actions upgraded to read & write; reminders, escalation,
    reconciliation, and digests are read-only on Actions. The live
    smoke test must settle this before auto-reject is advertised.
- **Events:** `workflow_run`, `workflow_job` (installation
  bookkeeping rides the standard app events).
- **Webhook URL:** `https://<host>/approval-escalation/webhooks`
  (reverse proxy strips the prefix; the service itself serves
  `/webhooks` and `/health`).

## Deployment notes

Zero-dependency Node ≥ 18; co-locates on the existing droplet next to
SameTree / QueueLite / the Janitor:

```bash
cp .env.example .env   # APP_ID, PRIVATE_KEY_PATH, WEBHOOK_SECRET, PORT=8933
npm start              # webhook server on :8933
```

Reverse proxy: route `/approval-escalation/` → `127.0.0.1:8933`,
prefix stripped. Cron:

```cron
*/15 * * * *  cd /opt/approval-escalation && node src/sweep.js
30 7 * * 1    cd /opt/approval-escalation && node src/sweep.js digest
```

State lives in `data/store.json` (override with
`APPROVAL_ESCALATION_STORE`). The server and the sweep share it
safely: every mutation is a lockfile-held transaction that reloads
from disk and writes back atomically — the discipline SameTree's
commit 7d982cc established after its store race.

## Development

```bash
npm test   # node --test; policy engine, store race regression,
           # webhook signatures, reconciler parsing (fixtures, no
           # network — the GitHub client is mocked throughout)
```

## License

MIT
