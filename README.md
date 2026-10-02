# krx-ticker

A scheduler: two self-restarting chains of `workflow_dispatch` runs, ~10 minutes
apart, that dispatch workflows in another repository during set time windows —
some on every tick, some once per window (`JOBS` in `chains.mjs`).

## Setup

1. Environment `tick-10m` with a 10-minute wait timer.
2. Secret `POLLER_DISPATCH_TOKEN` (Actions read/write on the target); the
   target's numeric repository id goes in `TARGET_REPO_ID` in `tick.yml`, its
   workflows' numeric ids in `JOBS`.
3. Actions → tick → Run workflow once, inputs empty.
