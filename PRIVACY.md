# Deployment Approval Escalation — Privacy Policy

_Last updated: November 15, 2026_

Deployment Approval Escalation is a GitHub App that reminds, escalates,
and optionally expires pending deployment approvals. This policy
describes exactly what it handles.

## What the App receives

When installed on a repository, GitHub sends the App `workflow_run`
and `workflow_job` webhook events for that repository. From those
events and the GitHub API, the App processes:

- Workflow run metadata: run IDs, workflow names, branch names, head
  commit SHAs, statuses, conclusions, and timestamps.
- Pending deployment records for those runs: environment names and
  IDs, the required reviewers (GitHub user logins and team slugs), and
  when the wait began.
- The repository's `.github/approval-escalation.yml` policy file, when
  one exists.
- Repository and installation identifiers: repository ID, owner login,
  repository name, and the App installation ID.

## What the App never receives or stores

- **No source code contents.** It reads the one policy file named
  above, never file bodies beyond it.
- **No secrets, environment variables, or artifacts.** In particular
  it never sees environment secrets — only that an environment exists
  and is waiting.
- **No approval decisions' contents** beyond the outcome (approved,
  rejected, expired) needed for its digest statistics.

## How the data is used

Metadata is used for one purpose: tracking how long each pending
deployment has been waiting so the App can remind reviewers, escalate
to the configured fallback mentions, optionally auto-reject at a
configured expiry, and publish a weekly digest issue in the
repository itself.

## Retention and deletion

Per-deployment state is retained while the App is installed.
Uninstalling the App stops all processing; stored state for the
installation is deleted on request to the support contact below.

## Contact

Support and privacy questions: coacha810@gmail.com
Source: https://github.com/CoolGlasses/approval-escalation
