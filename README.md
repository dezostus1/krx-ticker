# krx-ticker

A scheduler: two self-restarting chains of `workflow_dispatch` runs, ~10 minutes
apart, that start jobs during set time windows — some once per 10-minute slot,
some once per window (`JOBS` in `chains.mjs`). A job runs either here, in
`job.yml` (a script of the target repository, run from a clone made with a
deploy key), or as a workflow of the target repository.

## Setup

1. Environment `tick-10m` with a 10-minute wait timer.
2. Secret `POLLER_DISPATCH_TOKEN` (Actions read/write on the target); the
   target's numeric repository id goes in `TARGET_REPO_ID` in `tick.yml`, its
   workflows' numeric ids in `JOBS`.
3. For `job.yml`, repository secrets: `TARGET_REPO` (owner/name), `TARGET_KEY`
   (the private half of a deploy key with write access to the target),
   `JOB_SECRETS` (a JSON object of NAME → value: the job's environment, each
   value masked in the log).
4. Actions → tick → Run workflow once, inputs empty.
