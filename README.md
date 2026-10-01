# krx-ticker

A scheduler: two self-restarting chains of `workflow_dispatch` runs, ~10 minutes
apart, that dispatch a workflow in another repository during set time windows.

## Setup

1. Environment `tick-10m` with a 10-minute wait timer.
2. Secrets `POLLER_DISPATCH_TOKEN` (Actions read/write on the target) and
   `TARGET_REPO` (`owner/name`).
3. Actions → tick → Run workflow once, inputs empty.
