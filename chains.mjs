#!/usr/bin/env node
// Decisions for tick.yml. Node stdlib only.
//
//   node chains.mjs plan --runs runs.json --me <run id> --now <epoch s>
//     runs.json = gh run list --json databaseId,status,displayTitle,createdAt
//     prints one action per line: "cancel <run id> <chain>" / "dispatch <chain>"
//   node chains.mjs due --now <epoch s>
//     prints one line per job whose window is open: "<job> <workflow id> <window start, epoch s>"
//   node chains.mjs poke --job <job> --since <epoch s> --runs target.json --now <epoch s>
//     target.json = [{createdAt, displayTitle, status, conclusion}] of that job's workflow
//     prints "poke" or "skip <reason>" (no --job: the 10-minute job)
//   node chains.mjs body --job <job>
//     prints the dispatch request body: {"ref":"main","inputs":{…}}

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHAINS = ['A', 'B'];
// A dispatched tick waits 10 min for the environment timer, then needs a
// runner: pending longer than this means GitHub lost it.
export const ZOMBIE_AFTER_S = 900;
// createdAt is the dispatch time, so a healthy running tick is already 10+ min
// old; with runner pick-up and the 5-minute job timeout, one still "in
// progress" 20 min after dispatch is not coming back.
export const RUNNING_MAX_AGE_S = 1200;
// An `every` job was started this recently: skip.
export const POKE_GAP_S = 480;
// A `once` job is given up for its window after this many failed runs.
export const MAX_TRIES = 3;

/**
 * What the ticker starts in the target repository, and when; workflows by numeric id, like the
 * repository. Windows are [from, to) as HHMM in the job's time zone, optionally limited to ISO
 * weekdays (1 = Monday) or days of the month.
 * - every: on every tick inside a window, unless a counted run started < POKE_GAP_S ago;
 * - once:  once per window — skipped while a run created since the window opened is active or
 *          has succeeded (runs titled "dry-run" do not count), given up after MAX_TRIES failures.
 * The target's own cron slots sit inside these windows, so a cron run that does fire counts.
 */
export const JOBS = [
  {
    name: 'ten-minute', workflow: 365292156, rule: 'every', inputs: { mode: 'auto' }, tz: 'Asia/Seoul',
    windows: [
      { days: [1, 2, 3, 4, 5], from: 850, to: 1551 },
      { from: 2005, to: 2020 },
      { from: 600, to: 615 },
    ],
  },
  { name: 'nightly', workflow: 373038400, rule: 'once', inputs: { dry_run: 'false' }, tz: 'UTC', windows: [{ days: [1, 2, 3, 4, 5], from: 2130, to: 2340 }] },
  { name: 'morning', workflow: 372734760, rule: 'once', inputs: {}, tz: 'UTC', windows: [{ from: 530, to: 900 }] },
  { name: 'monthly', workflow: 373038402, rule: 'once', inputs: { dry_run: 'false' }, tz: 'UTC', windows: [{ monthDays: [1], from: 315, to: 600 }] },
];
export const jobOf = (name) => {
  const job = JOBS.find((j) => j.name === name);
  if (!job) throw new Error(`unknown job ${name}`);
  return job;
};

const PENDING = new Set(['waiting', 'queued', 'pending', 'requested']);
const ageOf = (run, now) => now - Math.floor(Date.parse(run.createdAt) / 1000);
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Weekday (1 = Monday), day of the month, hour, minute, second of `now` in `tz`. */
export function localTime(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now * 1000)).map((p) => [p.type, p.value]));
  return { dow: WEEKDAY[parts.weekday], day: Number(parts.day), h: Number(parts.hour), m: Number(parts.minute), s: Number(parts.second) };
}

/** The jobs whose window is open at `now`: [{job, since}] — since = the window's start, epoch s. */
export function dueJobs(now, jobs = JOBS) {
  const out = [];
  for (const job of jobs) {
    const t = localTime(now, job.tz);
    const hm = t.h * 100 + t.m;
    const w = job.windows.find((x) => hm >= x.from && hm < x.to
      && (!x.days || x.days.includes(t.dow)) && (!x.monthDays || x.monthDays.includes(t.day)));
    if (!w) continue;
    const intoWindow = (t.h * 60 + t.m - (Math.floor(w.from / 100) * 60 + (w.from % 100))) * 60 + t.s;
    out.push({ job, since: now - intoWindow });
  }
  return out;
}

/** Keep every chain alive: cancel its zombies, dispatch it when nothing of it is pending or running. */
export function planChains(runs, { me, now }) {
  const actions = [];
  for (const chain of CHAINS) {
    const mine = runs.filter((r) => r.displayTitle === `tick ${chain}` && r.databaseId !== me);
    let alive = 0;
    for (const r of mine) {
      const age = ageOf(r, now);
      if (PENDING.has(r.status)) {
        if (age < ZOMBIE_AFTER_S) alive++;
        else actions.push({ action: 'cancel', id: r.databaseId, chain });
      } else if (r.status === 'in_progress' && age < RUNNING_MAX_AGE_S) alive++;
    }
    if (!alive) actions.push({ action: 'dispatch', chain });
  }
  return actions;
}

// `every` job titles are "<workflow> <mode>"; only these modes (or none) count.
const COUNTED_MODES = new Set([undefined, 'auto', 'schedule', 'snapshot', 'all']);

/** Whether to dispatch `job` now, given its recent runs (newest first or any order). */
export function pokeDecision(targetRuns, { now, job = JOBS[0], since = null }) {
  if (job.rule === 'once') {
    const mine = targetRuns.filter((r) => Math.floor(Date.parse(r.createdAt) / 1000) >= since && !/dry.?run/i.test(r.displayTitle ?? ''));
    if (mine.some((r) => r.status !== 'completed')) return { poke: false, reason: 'a run of this window is still going' };
    if (mine.some((r) => r.conclusion === 'success')) return { poke: false, reason: 'done in this window' };
    if (mine.length >= MAX_TRIES) return { poke: false, reason: `gave up: ${mine.length} failed runs in this window` };
    return { poke: true };
  }
  const last = targetRuns
    .filter((r) => COUNTED_MODES.has((r.displayTitle ?? '').trim().split(/\s+/)[1]))
    .map((r) => ageOf(r, now))
    .sort((a, b) => a - b)[0];
  if (last != null && last < POKE_GAP_S) return { poke: false, reason: `target already started ${last}s ago` };
  return { poke: true };
}

/** The workflow_dispatch request body for `job`. */
export const dispatchBody = (job) => ({ ref: 'main', inputs: job.inputs });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const now = Number(arg('now') ?? Math.floor(Date.now() / 1000));
  const cmd = process.argv[2];
  if (cmd === 'plan') {
    const runs = JSON.parse(fs.readFileSync(arg('runs'), 'utf8'));
    for (const a of planChains(runs, { me: Number(arg('me')), now })) console.log(a.action === 'cancel' ? `cancel ${a.id} ${a.chain}` : `dispatch ${a.chain}`);
  } else if (cmd === 'due') {
    for (const { job, since } of dueJobs(now)) console.log(`${job.name} ${job.workflow} ${since}`);
  } else if (cmd === 'poke') {
    const runs = JSON.parse(fs.readFileSync(arg('runs'), 'utf8'));
    const job = arg('job') ? jobOf(arg('job')) : JOBS[0];
    const d = pokeDecision(runs, { now, job, since: arg('since') ? Number(arg('since')) : null });
    console.log(d.poke ? 'poke' : `skip ${d.reason}`);
  } else if (cmd === 'body') {
    console.log(JSON.stringify(dispatchBody(jobOf(arg('job')))));
  } else {
    console.error('usage: chains.mjs plan|due|poke|body … (see the header)');
    process.exit(2);
  }
}
