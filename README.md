# Allocation and Same-Day Affirmation Workflow with an Operations Console

A block trade is not one thing settling; it is dozens of client-account
allocations, each racing its own same-day affirmation cutoff. This project
fans a simulated block trade into allocations, drives each through an
explicit `allocated -> confirmed -> affirmed -> instructed` state machine
against a trade-date cutoff clock, escalates anything unaffirmed at the
cutoff, and puts a React console in front of it that names the exact field
blocking every at-risk allocation. Every number below was measured on this
machine, not targeted: the two seeded benchmarks (250,000-allocation rebuild
match, 40-of-40 cutoff escalation with 0 false escalations) both cleared on
their first run.

## Why this exists

A real allocation and affirmation desk cannot answer "is this allocation on
track" from live application state alone; it has to be able to prove, after
the fact, that what it is showing an operator is what actually happened. The
part of this project worth building is not the state machine (four states,
one linear path); it is the append-only event log that makes the state
machine's output auditable: every transition is a fact appended once, never
an in-place update, and the served "live" state is provably just a cache of
that log, not a second source of truth that can quietly drift from it.

## Honest framing, up front

- **This is a simulated allocation workflow, not a connection to any real
  custodian, broker, or clearing system.** There is no real trade, no real
  account, no real cutoff enforced by an outside party. `syntheticSeed.ts`
  generates every block trade, account, and lifecycle event used below.
- **Postgres is not installed as a service on this machine.** The backend
  defaults to `pg-mem`, a real, in-process SQL engine: the exact same SQL in
  `schema.ts` and `eventStore.ts` runs against it as would run against real
  PostgreSQL, parsed and executed, not bypassed. Set `DATABASE_URL` to point
  at a real Postgres 14+ instance to run the same code against one; nothing
  in this README was measured that way, for the same reason as the sibling
  repos in this portfolio that make the same call.
- **The React console is a genuinely separate process from the API**,
  talking to it only over HTTP, exactly as it would in production; the
  Playwright test below starts both, on OS-assigned ports, and drives a real
  headless Chromium browser against the real rendered page.
- **Machine and toolchain.** AMD Ryzen 7 7800X3D, 8 physical / 16 logical
  cores, Windows 11 Home. Node.js v22.17.1, TypeScript 5.7, Express 4.21,
  Vite 5.4, React 18.3, Vitest 2.1, Playwright 1.48 (bundled Chromium,
  headless).

## Architecture

```
backend/src/
  domain/
    types.ts            AllocationEvent union, AllocationView, AllocationState
    stateMachine.ts      the FAST reducer: applies one event to a view, O(1)
    fanOut.ts            splits one block trade into one ALLOCATION_CREATED per account
    blockingField.ts     names the single field blocking an allocation right now
    cutoff.ts            shouldEscalate: pure decision, past cutoff and not yet affirmed
    cutoffSweep.ts       scans live views, produces the CUTOFF_ESCALATED events to append
  store/
    schema.ts            the append-only allocation_events table (real SQL)
    eventStore.ts        appendEvent / appendEventsBatch / getAllEventsOrdered (real SQL)
    liveProjector.ts      LiveStateProjector: the served in-memory read model
    rebuildOracle.ts      rebuildFromLog: a SEPARATE, O(events)-per-allocation reducer,
                          diffed field-by-field against the live projector
    pool.ts               pg-mem by default, real Postgres via DATABASE_URL
  api/server.ts          Express routes: block-trades, lifecycle events, cutoff-sweep,
                          allocations, allocations/at-risk, demo/seed
  seed/syntheticSeed.ts   deterministic (seeded LCG) synthetic population generators,
                          incl. the two generators the benchmarks below are built on
  scripts/
    bench_rebuild_250k.ts    the 250,000-allocation rebuild-vs-live benchmark
    bench_escalation.ts      the 40-seeded-breach / 5,000-clean escalation benchmark
  tests/                 29 Vitest tests (domain, rebuild-oracle diff, API via supertest)
frontend/
  src/App.tsx            the console: fetches /allocations/at-risk, names the blocking field
  tests/console.spec.ts   Playwright end-to-end test, starts both real servers itself
```

### Why the event log is the source of truth, not the live projector

`LiveStateProjector` is a plain in-memory `Map`, folded forward one event at
a time by `stateMachine.applyEvent`. Nothing stops that class from having a
bug that silently drifts from what the log actually records. `rebuildOracle.ts`
is a second, independently written reducer that instead re-derives an
allocation's state by re-scanning its entire history from scratch every time
it is asked, an intentionally slower, intentionally more obviously correct
implementation. `diffAgainstLive` compares the two, field by field, over the
whole population; that diff, not a spot check, is what the "rebuilt state
matched live state" claim actually means.

### Why the reducer cascades multiple states in one event

Facts do not arrive in state-machine order. A custodian affirmation can
reach the system before the matching broker confirmation does.
`stateMachine.ts`'s `advanceAsFarAsPossible` re-checks every gate on every
event, so an allocation whose confirmation arrives last still walks
`allocated -> confirmed -> affirmed` in that one event, instead of getting
stuck one step behind because the state machine only checked the gate that
event's own type "usually" advances.

### Why the console is a separate at-risk endpoint, not a client-side filter

`GET /allocations/at-risk` computes `isAtRisk` and `blockingField` on the
server, from the same `domain/blockingField.ts` functions the backend itself
would use to decide whether to escalate. The console never re-derives that
logic in the browser; it only ever displays what the API already decided,
so the console and the escalation sweep can never disagree about which
allocations are at risk or why.

## Validation

### Reference-oracle diff (the audit-trail claim, made falsifiable)

`bench_rebuild_250k.ts` generates 250,000 synthetic allocations across a
realistic mostly-clean mix of lifecycle scenarios (55% instructed, 15%
affirmed-not-instructed, 12% confirmed-not-affirmed, 8% no confirmation, 5%
quantity mismatch, 5% price mismatch; `syntheticSeed.ts`'s default weights),
applies every event to `LiveStateProjector` exactly as the API does, then
independently rebuilds the same population from the raw event array alone
via `rebuildFromLog`, and diffs the two.

```
$ npx tsx scripts/bench_rebuild_250k.ts
allocations generated: 250000
events generated: 792442
-- claim: status rebuilt from the append-only event log alone matched live state on all 250,000 allocations --
matches: 250000 / 250000
mismatches: 0
elapsed: 906 ms
```

Full output: `docs/bench_rebuild_250k_output.txt`.

### Cutoff escalation (seeded breaches and a seeded clean control)

`bench_escalation.ts` deterministically builds exactly 40 allocations that
reach activity time still short of "affirmed" (a genuine breach once the
cutoff passes: 10 each of no confirmation, confirmed-not-affirmed, quantity
mismatch, price mismatch) and 5,000 allocations that reach "affirmed" or
"instructed" well before the cutoff, then runs `computeCutoffEscalations`
once, just after the cutoff, exactly as the API's `/cutoff-sweep` endpoint
would.

```
$ npx tsx scripts/bench_escalation.ts
seeded breaches: 40
seeded clean: 5000
-- claim: 40 of 40 seeded cutoff breaches escalated --
breaches escalated: 40 / 40
-- claim: 0 false escalations --
clean allocations falsely escalated: 0 / 5000
```

Full output: `docs/bench_escalation_output.txt`.

### Tests

29 backend Vitest tests: 3 fan-out tests (including the pro-rata remainder
split), 7 state-machine tests (including the out-of-order cascade above and
the append-only duplicate-creation guard), 12 blocking-field/cutoff tests
(one per named blocking field, plus the "never re-escalate" and "never
escalate once affirmed" invariants), 2 reference-oracle diff tests, and 5
API tests via `supertest` against a real `pg-mem`-backed app instance,
covering fan-out, the full lifecycle, the at-risk feed, the cutoff sweep,
and the 404 on an unknown allocation.

```
$ npx vitest run
 Test Files  5 passed (5)
      Tests  29 passed (29)
```

Full transcript: `docs/backend_test_output.txt`.

One Playwright end-to-end test (`frontend/tests/console.spec.ts`): starts
the real backend and a real Vite dev server, each on an OS-assigned port,
seeds four fixed demo allocations through `/demo/seed` (one missing a broker
confirmation but not yet past cutoff, one past-cutoff quantity mismatch, one
past-cutoff missing affirmation, one clean instructed allocation), drives a
real headless Chromium browser to the console, and asserts the two at-risk
rows show exactly `quantity mismatch vs client instruction` and `missing
affirmation from custodian`, and that the clean allocation never appears.

```
$ npx playwright test
  1 passed (3.1s)
```

Full transcript: `docs/playwright_test_output.txt`.

## Findings: CORS, not the domain logic, was the first real failure

The first Playwright run failed with every at-risk row missing, not a
wrong-content failure but zero rows and a visible "Failed to load: Failed to
fetch" alert on the page itself.

**Wrong hypothesis first.** The two servers had both started (their own
stdout confirmed both bound ports), and the API's own Vitest suite already
proved `/allocations/at-risk` worked, so the first hypothesis was a race
between the frontend polling and the backend finishing its `/demo/seed`
write. That hypothesis did not survive a look at the actual error: a fetch
race produces a slow load or a stale result, not `Failed to fetch`, which is
the browser's own network-layer rejection before a response is ever read.

**The measurement that discriminated.** Playwright's own page snapshot on
failure captured the console's rendered `alert` text verbatim:
`Failed to load: Failed to fetch`, with no HTTP status attached, the
signature of a request blocked before the server's response body was ever
delivered to the page.

**Root cause.** The Vite dev server and the Express API are two different
origins by construction (each gets an OS-assigned port so neither test run
ever assumes a free one); Express had no `Access-Control-Allow-Origin`
header at all, so the browser's own CORS policy silently discarded the
response before React ever saw it.

**Fix.** A permissive CORS header, `Access-Control-Allow-Origin: *`, added
to every response in `api/server.ts`. Every route behind it serves synthetic
demo data; a wildcard origin puts nothing real at risk here.

**Why the method mattered.** A unit test of `App.tsx`'s render logic in
isolation (mocking `fetch`) would never have caught this: the bug lived
entirely in the boundary between two real processes, which is exactly the
boundary a component test does not cross and an end-to-end Playwright test
does.

## Measured results

AMD Ryzen 7 7800X3D, 8 physical / 16 logical cores, Windows 11 Home,
Node.js v22.17.1.

| Metric | Measured | Claim |
|---|---|---|
| **Status rebuilt from the log alone matched live state** | **250,000 / 250,000** | all 250,000 allocations |
| Rebuild-vs-live comparison wall time | 906 ms | (not claimed; included so the number above is not read as untimed) |
| **Seeded cutoff breaches escalated** | **40 / 40** | 40 of 40 |
| **False escalations on 5,000 clean allocations** | **0** | 0 |
| Backend tests passing | 29 / 29 | (not a resume bullet; supports every claim above) |
| Console end-to-end test | 1 / 1 passing | React console naming the exact field blocking every at-risk allocation |

"Matched live state" means: for every allocation id that exists in either
the live projector or the from-scratch rebuild, every field of the two views
is equal (`viewsEqual` in `rebuildOracle.ts`), not just that both paths agree
on which allocations exist. "False escalation" means a clean, on-time
allocation (one that reached `affirmed` or `instructed` before its own
cutoff) was still escalated by the sweep; the sweep's own logic (`shouldEscalate`)
makes this structurally hard to get wrong (an already-affirmed allocation is
excluded by state, not by timing), which is exactly why the 0/5,000 result
here is a confirmation of that design rather than a surprise.

## Building and running

```bash
cd backend
npm install
npm test                                   # 29 Vitest tests, pg-mem, ~1s
npx tsx scripts/bench_rebuild_250k.ts      # the 250,000-allocation rebuild benchmark
npx tsx scripts/bench_escalation.ts        # the 40-seeded-breach escalation benchmark
npm run build                              # tsc -b
PORT=0 node dist/index.js                  # prints LISTENING_ON <port>; PORT=0 asks the OS for a free port
```

```bash
cd frontend
npm install
npm run dev                                 # VITE_API_BASE points it at a running backend, see below
npx playwright test                         # starts both real servers itself, on free ports
```

Running the console against a specific backend port manually:

```bash
VITE_API_BASE=http://127.0.0.1:<backend-port> npx vite --port 0
```

Against real PostgreSQL instead of `pg-mem`:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/allocation_workflow
```

## Sibling comparison

[`securities-settlement-matching`](https://github.com/Manas103/securities-settlement-matching)
is the other trade-lifecycle project in this application's role folder, and
the two are deliberately complementary rather than overlapping: that project
proves correctness by diffing a fast matcher against a reference oracle over
a fixed synthetic dataset (48/48 seeded breaks, 0 false matches); this
project proves auditability by diffing a fast live projector against an
independently-derived rebuild of the same append-only log
(250,000/250,000 fields matched). Different failure mode, on purpose: a
matching engine's risk is a wrong answer on data it has already seen; an
audit trail's risk is a served answer that has quietly drifted from what the
log actually recorded, which is the one a from-scratch rebuild, not a spot
check, is built to catch.

## Limitations

- **In-memory live projector.** `LiveStateProjector` lives in Node process
  memory; a restart loses the served read model, which would need to be
  rebuilt from the durable event log before serving traffic again (the
  rebuild path this project already has, just not wired to run on startup).
- **The cutoff sweep is triggered on demand (`POST /cutoff-sweep`), not on a
  scheduler.** A real deployment would call it on a timer; nothing in this
  project's measured claims depends on how often that timer fires, only on
  what the sweep does once it runs.
- **CORS is wide open (`*`).** Acceptable for a synthetic local demo console
  talking to a synthetic local API; not a pattern to carry into a real
  deployment serving anything non-public.
- **No throughput claim.** The 906 ms rebuild-benchmark time is a single-run
  wall-clock number on a shared development machine, not a controlled
  throughput benchmark.
