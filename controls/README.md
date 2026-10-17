# Standalone control experiments

These experiments isolate candidate triggers. They did not independently reproduce the multiplication captured in Nuvo.

| Experiment | Observed result |
| --- | --- |
| One PR workflow, native frontend job and backend commit-status reporter; amend base and restack child | At +3.388 seconds: one plain pending row per required name. |
| Add one unrelated PR workflow | At +3.586 seconds: one backend placeholder and one actual frontend check. |
| Put native frontend/backend jobs behind a 30-second prerequisite | At +3.124 seconds: one plain pending row per required name. |

The control's first updated child head is `8879865ffd3885dcaa0e73ace7ba90f9af95e1ca`. Its API snapshot contains two actual frontend runs: one cancelled and one active. Graphite displayed one actual frontend entry in the observed subsequent snapshot. This distinguishes actual reruns from the unlinked pending copies observed in Nuvo.

The small backend reporter intentionally reports workflow events directly. Cancellation of a superseded workflow can temporarily report backend failure; this is a limitation of this control, not evidence of the Graphite placeholder bug. Nuvo's reporter includes additional reconciliation logic.

The gated variant is retained on the `repro-base` / `repro-top` branches. Its workflow name differs from the original workflow, and the reporter deletion has not landed on the default branch; a default-branch reporter may still process workflow events. Treat it as an exploratory control rather than a production CI design.

- [Ungated screenshot](../evidence/personal-immediate-update.jpg) and [visible DOM](../evidence/personal-immediate-update-dom.txt).
- [Gated screenshot](../evidence/personal-gated-immediate.jpg) and [visible DOM](../evidence/personal-gated-immediate-dom.txt).
- [Ungated GitHub API response](../evidence/personal-ungated-github.json).

The verified source-repository steps and timing are in the main README. The public repository is a complete evidence bundle, not a claim that the isolated fixture is a sufficient trigger.
