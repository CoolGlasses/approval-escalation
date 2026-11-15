# Deployment Approval Escalation — Terms of Service

_Last updated: November 15, 2026_

## The service

Deployment Approval Escalation is a GitHub App that watches pending
deployment approvals in repositories where it is installed. It reminds
required reviewers after a configurable wait, escalates to configured
fallback mentions after a longer wait, optionally rejects pending
deployments at a configured expiry, and publishes a weekly digest
issue.

## Behaviour you are opting into

Installing the App is your decision that this behaviour fits your
repository. In particular:

- Reminders and escalations are comments on a single tracking issue
  the App maintains in the repository, @mentioning the people and
  teams named by the run's required reviewers and by your policy.
- Each tier fires at most once per pending deployment.
- **Auto-reject is off by default.** It acts only when a repository
  sets `auto_reject_after_hours` in `.github/approval-escalation.yml`,
  and only past that threshold.
- The App never approves a deployment. Approvals remain a human act.

To stop all actions, uninstall the App — the effect is immediate.

## Availability

The service is provided as-is, without uptime guarantees. The operator
may change or discontinue features with notice in the repository.

## Liability

To the maximum extent permitted by law, the operator is not liable for
indirect or consequential damages arising from use of the App,
including deployments rejected under an auto-reject policy the
repository itself configured.

## Contact

coacha810@gmail.com
