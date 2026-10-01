#!/usr/bin/env node
// Decisions for tick.yml. Node stdlib only.
//
//   node chains.mjs plan --runs runs.json --me <run id> --now <epoch s>
//     runs.json = gh run list --json databaseId,status,displayTitle,createdAt
//     prints one action per line: "cancel <run id> <chain>" / "dispatch <chain>"
//   node chains.mjs poke --runs target.json --now <epoch s>
//     target.json = gh run list --json createdAt,displayTitle (target workflow)
//     prints "poke" or "skip <reason>"

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
// The target was started this recently: skip.
export const POKE_GAP_S = 480;

const PENDING = new Set(['waiting', 'queued', 'pending', 'requested']);
const ageOf = (run, now) => now - Math.floor(Date.parse(run.createdAt) / 1000);

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

// Target run titles are "<workflow> <mode>"; only these modes (or none) count.
const COUNTED_MODES = new Set([undefined, 'auto', 'schedule', 'snapshot', 'all']);

/** Poke unless a counted target run started < POKE_GAP_S ago. */
export function pokeDecision(targetRuns, { now }) {
  const last = targetRuns
    .filter((r) => COUNTED_MODES.has((r.displayTitle ?? '').trim().split(/\s+/)[1]))
    .map((r) => ageOf(r, now))
    .sort((a, b) => a - b)[0];
  if (last != null && last < POKE_GAP_S) return { poke: false, reason: `target already started ${last}s ago` };
  return { poke: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const runs = JSON.parse(fs.readFileSync(arg('runs'), 'utf8'));
  const now = Number(arg('now') ?? Math.floor(Date.now() / 1000));
  const cmd = process.argv[2];
  if (cmd === 'plan') {
    for (const a of planChains(runs, { me: Number(arg('me')), now })) console.log(a.action === 'cancel' ? `cancel ${a.id} ${a.chain}` : `dispatch ${a.chain}`);
  } else if (cmd === 'poke') {
    const d = pokeDecision(runs, { now });
    console.log(d.poke ? 'poke' : `skip ${d.reason}`);
  } else {
    console.error('usage: chains.mjs plan|poke --runs <file> [--me <id>] [--now <epoch s>]');
    process.exit(2);
  }
}
