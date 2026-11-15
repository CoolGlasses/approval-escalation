# Marketplace listing copy — Deployment Approval Escalation (DRAFT)

- Name: Deployment Approval Escalation
- Short description (no trailing punctuation): "Reminders, escalation, and expiry for GitHub deployment approvals that wait in silence"
- Primary category: Project management
  - Chosen over "Continuous integration": the buyer is a release /
    platform team managing a people-workflow (who owes a decision),
    and the sibling products already sit in CI. If the listing form
    offers "Deployment tools", that is an equally honest primary —
    decide at submission; do not list under CI just for traffic.
- Secondary category: Continuous integration
- Support URL: https://github.com/CoolGlasses/approval-escalation
- Privacy policy URL: https://github.com/CoolGlasses/approval-escalation/blob/main/PRIVACY.md
- Terms URL: https://github.com/CoolGlasses/approval-escalation/blob/main/TERMS.md
- Contact email (all leads): coacha810@gmail.com
- Free plan: "Free" — $0. Description: "Approval reminders,
  escalation, optional auto-reject, and a weekly digest for pending
  GitHub deployment approvals."
  Bullets:
  - Reviewer reminders when an approval waits past your threshold
  - Escalation to a fallback team when it waits longer still
  - Optional auto-reject at a configured expiry — off by default
  - Weekly digest: approvals waited, median wait, expiries

## Intro description

GitHub environment approvals get exactly one notification. After
that, a deployment can sit waiting for days — invisible to everyone
who isn't staring at the run — until GitHub fails it automatically
at 30 days. Deployment Approval Escalation watches every pending
approval across your repositories and gives the wait a lifecycle:
remind the reviewers, escalate to a fallback team, and, only if you
configure it, reject the deployment at an expiry you choose.

## Detailed description

See README.md in the repository for the full behaviour specification:
the remind / escalate / auto-reject tiers and their defaults (4h /
24h / off), the per-repo policy file
(`.github/approval-escalation.yml`), the single tracking issue per
repo that reminders and escalations land on, and the weekly digest
issue with approvals waited, median wait, and expiries. The app
reconciles against the GitHub API on a schedule, so missed webhooks
never lose an approval, and it never approves a deployment itself —
approvals stay human. Paid tiers (higher repo counts, longer digest
history) arrive with the paid listing; the free plan is the full
reminder and escalation behaviour.
