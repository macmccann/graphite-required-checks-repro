#!/usr/bin/env bash
# Run in an isolated checkout of nuvo-tech/nuvo with the experiment stack tracked.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
remote=$(git remote get-url origin)
case "$remote" in
  git@github.com:nuvo-tech/nuvo.git|https://github.com/nuvo-tech/nuvo.git) ;;
  *) echo 'Run this in the isolated Nuvo experiment checkout.' >&2; exit 1 ;;
esac
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Use a clean isolated checkout so the experiment cannot include other changes.' >&2
  exit 1
fi
gt checkout --no-interactive codex/graphite-required-checks-repro-base
printf 'Display experiment update at %s\n' "$(date -u +%FT%TZ)" >> .github/required-checks-repro/base.txt
gt modify --no-interactive -a -m 'chore: reproduce required check display on a base pull request'
gt submit --no-interactive --stack --no-edit --no-ai
python3 - <<'PY'
from datetime import datetime, timezone
print('SUBMIT_FINISHED_AT=' + datetime.now(timezone.utc).isoformat(), flush=True)
print('Capture the already-open Graphite PR page NOW (within ten seconds).', flush=True)
PY
