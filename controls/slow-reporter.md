# Slow CI with the Nuvo status reporter

The personal repository now runs synthetic jobs for about four minutes. `Repro CI` waits 90 seconds before scheduling `frontend-checks` and three backend jobs; those jobs then wait another 90–120 seconds. `Repro Tests` produces the test matrix and auxiliary statuses that the Nuvo reporter expects. Every job only sleeps or runs a no-op.

The reporter preserves the Nuvo implementation from commit `22125b35c8`: the only substitutions are `Nuvo CI` → `Repro CI`, `Nuvo Tests` → `Repro Tests`, and the CI workflow path → `.github/workflows/checks.yml`. It handles `workflow_run` requested/in_progress/completed events, groups competing runs by validation context, follows a surviving run after duplicate cancellation, reads revision stamps, rechecks run state before publishing, and writes statuses to the PR head SHA. The workflow serializes writes by producer workflow and head SHA and checks out its trusted default-branch revision.

`frontend-checks` is a native Actions check. `backend-checks` is exclusively a commit status from the reporter. The other reported contexts are `pytest`, `services-pytest`, `core-tests`, and `pre-merge-tests`. The two existing required-check rules remain unchanged.

The reporter must first be merged to the default branch: a reporter edited only in a PR does not change the `workflow_run` implementation GitHub executes. During the infrastructure PR, the previous default-branch reporter supplies its existing backend status; experiments begin after the new reporter has landed.

For an on/off comparison on an experimental stack, remove only `# ci-aggregate-checks: v1` from both producer workflows. This makes the same reporter return without publishing statuses. Backend then intentionally remains unsatisfied; this control tests display behavior and must not be merged. Restore the exact marker to re-enable publishing. Keep the same delays, required rules, and workflow jobs.

Capture the already-open Graphite child page within ten seconds of a stack submission, then capture again as status updates arrive. Compare the visible rows with the GitHub API and with the same page after reload. A cancelled real workflow run is not a duplicated synthetic pending row.

Results will be recorded after the live experiment; adding this setup does not establish that the reporter causes the bug.
