# Trade Order Lifecycle with Pre-Trade Compliance, Pro-Rata Allocation and Same-Day Affirmation

A block trade is not one thing settling; it is an order created against a
position book, checked against pre-trade compliance rules, released, filled,
split pro-rata across dozens of client-account allocations, and then each of
those allocations races its own same-day affirmation cutoff. This project
covers the whole chain on one append-only event log: order creation,
pre-trade compliance (restricted-list, concentration, cash-sufficiency),
release, fill, pro-rata allocation, and the existing
`allocated -> confirmed -> affirmed -> instructed` state machine against a
trade-date cutoff clock, escalating anything unaffirmed at the cutoff. A
React console sits in front of both halves: the exact field blocking every
at-risk allocation, and the exact rule and input that rejected a blocked
order. Every number below was measured on this machine, not targeted: all
four seeded benchmarks (250,000-allocation rebuild match, 40-of-40 cutoff
escalation with 0 false escalations, 40-of-40 pre-trade breaches blocked with
0 false blocks over 5,000 clean orders, and pro-rata share conservation over
250,000 allocations) cleared on their first run; the one place a real bug was
found and fixed is in Findings below.

## Why this exists

A real allocation and affirmation desk cannot answer "is this allocation on
track" from live application state alone; it has to be able to prove, after
the fact, that what it is showing an operator is what actually happened. The
part of this project worth building is not the state machine (four states,
one linear path); it is the append-only event log that makes the state
machine's output auditable: every transition is a fact appended once, never
an in-place update, and the served "live" state is provably just a cache of
that log, not a second source of truth that can quietly drift from it.

The same discipline extends backward, to before an allocation exists at all.
An order that reaches a client account has already cleared a compliance
gate and been split across accounts by a rule that cannot lose or invent a
share; those two facts belong on the same auditable log as everything that
happens to the allocation afterward, not in a separate system that has to be
reconciled against this one by hand.

## Honest framing, up front

- **This is a simulated order and allocation workflow, not a connection to
  any real custodian, broker, order management system, or clearing system.**
  There is no real trade, no real account, no real cutoff enforced by an
  outside party. `syntheticSeed.ts` and `orderSeed.ts` generate every order,
  block trade, account, position, and lifecycle event used below.
- **The position book behind pre-trade compliance is a simplified synthetic
  book (`domain/positionBook.ts`), not a real custodian or PMS position
  record.** It carries exactly the two numbers the three pre-trade rules
  need per account, cash and per-symbol holding value, and nothing else (no
  lots, no historical prices).
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
    orderTypes.ts        OrderEvent union (creation through fill), OrderView, OrderState
    positionBook.ts      AccountPosition: the two numbers pre-trade compliance needs
    preTradeCompliance.ts  restricted-list, cash-sufficiency, concentration; each
                          rejection names the exact rule and failing input
    proRataAllocator.ts  allocateProRata: largest-remainder pro-rata split, share-exact
    lifecycleEvent.ts    the union of OrderEvent and AllocationEvent that the store persists
  store/
    schema.ts            the append-only allocation_events table (real SQL, now stores
                          both order and allocation events by discriminated type)
    eventStore.ts        appendEvent / appendEventsBatch / getAllEventsOrdered (real SQL)
    liveProjector.ts      LiveStateProjector (allocations) and LiveOrderProjector (orders):
                          the served in-memory read models
    rebuildOracle.ts      rebuildFromLog / rebuildOrdersFromLog: SEPARATE, from-scratch
                          reducers, each diffed field-by-field against its live projector
    pool.ts               pg-mem by default, real Postgres via DATABASE_URL
  api/server.ts          Express routes: orders (create/pretrade-check/release/fill),
                          block-trades, lifecycle events, cutoff-sweep, allocations,
                          allocations/at-risk, demo/seed, demo/seed-orders
  seed/
    syntheticSeed.ts      deterministic (seeded LCG) synthetic allocation-side generators;
                          exports the one pseudoRandom LCG every other generator reuses
    orderSeed.ts          generateSeededBreachOrders (40, one per rule violation) and
                          generateCleanOrders (5,000 that pass every rule)
  scripts/
    bench_rebuild_250k.ts               the 250,000-allocation rebuild-vs-live benchmark
    bench_escalation.ts                 the 40-seeded-breach / 5,000-clean escalation benchmark
    bench_pretrade_compliance.ts        the 40-of-40 blocked / 0-false-blocks-over-5,000 benchmark
    bench_prorata_allocation_250k.ts    the 250,000-allocation share-conservation benchmark
  tests/                 60 Vitest tests (domain, both rebuild-oracle diffs, API via supertest)
frontend/
  src/App.tsx            the console: /allocations/at-risk (blocking field) and /orders
                          (order state and, for a rejected order, the exact rule and input)
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

### Why every pre-trade rejection carries the failing input, not just a rule name

A rejection that says only "CONCENTRATION" sends an operator back to the
position book to reconstruct what actually happened. `checkConcentration`
instead computes and reports the resulting percentage and the limit it
would have breached; `checkCashSufficiency` reports the exact shortfall in
dollars. This mirrors `blockingField.ts`'s existing convention on the
allocation side of this same repo: a caller is never told just "no", only
what to look at.

### Why the pro-rata allocator uses the largest-remainder method, not independent rounding

Rounding each account's share independently (`Math.round(filled * weight /
total)`) is the obvious first implementation, and it does not conserve
shares: the rounded pieces do not, in general, sum back to the filled
quantity. `allocateProRata` instead gives every account the floor of its
exact share, then hands out the leftover whole shares, an exact integer by
construction, one each to the accounts with the largest fractional
remainder. Conservation holds by construction, not by luck; see Findings for
the property test that caught the first implementation failing this.

### Why the order and allocation halves share one event table

`lifecycleEvent.ts`'s `LifecycleEvent` union and `streamIdOf` function are
the entire bridge between the two halves: `schema.ts` and `eventStore.ts`
persist whichever kind of event they are given, keyed on whichever id it
carries. This is what makes "one audit trail from order to allocation" true
in the schema, not just in the README's prose: `rebuildOrdersFromLog` can
rebuild every order's state from the same table `rebuildFromLog` rebuilds
every allocation's state from, because both reducers simply ignore the
event types that are not theirs.

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

### Pre-trade compliance (40 seeded breaches, one rule each, and a 5,000-order clean control)

`bench_pretrade_compliance.ts` runs `generateSeededBreachOrders` (14
restricted-list, 13 cash-sufficiency, 13 concentration, 40 total, each
order built with enough margin on the two rules it is not meant to fail that
only its intended rule can ever fire) and `generateCleanOrders(seed, 5000)`
through `runPreTradeChecks` exactly as the API's `/orders/:id/pretrade-check`
route would.

```
$ npx tsx scripts/bench_pretrade_compliance.ts
=== Trade Order Lifecycle -- pre-trade compliance benchmark ===
seeded breaches: 40
seeded clean: 5000

-- claim: 40 of 40 seeded breaches blocked --
breaches blocked: 40 / 40
breaches blocked naming the exact intended rule: 40 / 40

-- claim: 0 false blocks over 5,000 clean orders --
clean orders falsely blocked: 0 / 5000
```

Full output: `docs/bench_pretrade_compliance_output.txt`.

### Pro-rata allocation conservation (250,000 allocations)

`bench_prorata_allocation_250k.ts` generates orders with 2 to 49 randomized
client-account weights and a randomized filled quantity until the running
total of individual (order, account) allocations reaches 250,000, calling
`allocateProRata` once per order and checking that the sum of every
account's allocated quantity exactly equals the filled quantity, for every
single order, not on average.

```
$ npx tsx scripts/bench_prorata_allocation_250k.ts
=== Trade Order Lifecycle -- pro-rata allocation conservation benchmark ===
orders generated: 9845
allocations generated: 250002

-- claim: pro-rata allocator conserved every share across 250,000 allocations --
conservation failures: 0 / 9845 orders
non-integer allocation failures: 0
negative allocation failures: 0
```

Full output: `docs/bench_prorata_allocation_250k_output.txt`.

### Tests

60 backend Vitest tests: 3 fan-out tests (including the pro-rata remainder
split), 7 state-machine tests (including the out-of-order cascade above and
the append-only duplicate-creation guard), 12 blocking-field/cutoff tests
(one per named blocking field, plus the "never re-escalate" and "never
escalate once affirmed" invariants), 2 allocation reference-oracle diff
tests, 2 order reference-oracle diff tests, 6 order-lifecycle tests, 13
pre-trade compliance tests (each rule's pass and fail path, plus the seeded
breach and clean generators), 10 pro-rata allocator tests (fixed examples
plus a 500-trial randomized property test for share conservation), and 5 API
tests via `supertest` against a real `pg-mem`-backed app instance, covering
fan-out, the full allocation lifecycle, the at-risk feed, the cutoff sweep,
and the 404 on an unknown allocation.

```
$ npx vitest run
 Test Files  9 passed (9)
      Tests  60 passed (60)
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

## Findings: independent rounding does not conserve shares

**Symptom.** The first `allocateProRata` implementation rounded each
account's share independently, `Math.round(filledQuantity * weight /
totalWeight)`. The property test in `tests/proRataAllocator.test.ts`
(500 randomized `(accounts, weights, filledQuantity)` configurations)
failed on a visible minority of trials with the sum of the rounded shares
one or two shares off from the filled quantity, in either direction.

**Wrong hypothesis first.** The first guess was a floating-point precision
issue in the weight division itself, since `weight / totalWeight` is not
always exact in binary floating point. That hypothesis did not survive
inspection of the failing cases: the per-account errors were exactly plus
or minus one whole share, not a fractional residue, which is the signature
of independent rounding rather than of floating-point error.

**The measurement that discriminated.** Summing the *unrounded* exact shares
for a failing trial always reproduced the filled quantity exactly (as it
must, since the weights are a partition); summing the *rounded* shares did
not. That isolated the bug to the rounding step itself, not to the division
that produced the shares being rounded.

**Root cause.** `Math.round` on N independent numbers has no relationship
to each other's rounding direction; nothing prevents all N roundings from
going up, or all N from going down, and the accumulated error is unbounded
in the number of accounts.

**Fix.** The largest-remainder method now in `proRataAllocator.ts`: floor
every account's exact share, then hand out the leftover whole shares
(`filledQuantity - sum(floors)`, an exact integer by construction, since
`filledQuantity` was validated as an integer and every floor is an integer)
one each to the accounts with the largest fractional remainder. The 500-trial
property test and the 250,000-allocation scale benchmark both now pass with
zero conservation failures.

**Why the method mattered.** A single fixed example (three equal accounts
splitting a quantity divisible by three) would never have exposed this: the
bug only appears when the weights and quantity conspire to round in the same
direction more often than not, which is exactly what a randomized property
test across many weight shapes is built to find and a handful of hand-picked
examples is not.

## Measured results

AMD Ryzen 7 7800X3D, 8 physical / 16 logical cores, Windows 11 Home,
Node.js v22.17.1.

| Metric | Measured | Claim |
|---|---|---|
| **Status rebuilt from the log alone matched live state** | **250,000 / 250,000** | all 250,000 allocations |
| Rebuild-vs-live comparison wall time | 811 ms (re-measured for this build; original run was 906 ms, both well within this repo's usual run-to-run noise) | (not claimed; included so the number above is not read as untimed) |
| **Seeded cutoff breaches escalated** | **40 / 40** | 40 of 40 |
| **False escalations on 5,000 clean allocations** | **0** | 0 |
| **Seeded pre-trade breaches blocked, naming the exact intended rule** | **40 / 40** | 40 of 40 seeded breaches blocked |
| **False blocks on 5,000 clean orders** | **0** | 0 |
| **Shares conserved across the pro-rata allocation benchmark** | **250,002 / 250,002 allocations, 9,845 / 9,845 orders** | every share conserved across 250,000 allocations |
| Backend tests passing | 60 / 60 | (not a resume bullet; supports every claim above) |
| Console end-to-end test | 1 / 1 passing | React console naming the exact field blocking every at-risk allocation and, for orders, the exact rejecting rule |

"Matched live state" means: for every allocation id that exists in either
the live projector or the from-scratch rebuild, every field of the two views
is equal (`viewsEqual` in `rebuildOracle.ts`), not just that both paths agree
on which allocations exist. "False escalation" means a clean, on-time
allocation (one that reached `affirmed` or `instructed` before its own
cutoff) was still escalated by the sweep; the sweep's own logic (`shouldEscalate`)
makes this structurally hard to get wrong (an already-affirmed allocation is
excluded by state, not by timing), which is exactly why the 0/5,000 result
here is a confirmation of that design rather than a surprise.

"False block" means a clean order, one built to pass all three pre-trade
rules with margin, was still rejected; "conserved every share" means, for
every single order in the 250,000-allocation benchmark, the sum of every
account's allocated quantity equals the order's filled quantity exactly, an
integer equality check, not a tolerance.

## Building and running

```bash
cd backend
npm install
npm test                                            # 60 Vitest tests, pg-mem, ~6s
npx tsx scripts/bench_rebuild_250k.ts               # the 250,000-allocation rebuild benchmark
npx tsx scripts/bench_escalation.ts                 # the 40-seeded-breach escalation benchmark
npx tsx scripts/bench_pretrade_compliance.ts        # the 40-of-40 blocked / 0-false-blocks benchmark
npx tsx scripts/bench_prorata_allocation_250k.ts    # the 250,000-allocation share-conservation benchmark
npm run build                                       # tsc -b
PORT=0 node dist/index.js                           # prints LISTENING_ON <port>; PORT=0 asks the OS for a free port
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

- **In-memory live projectors.** `LiveStateProjector` and `LiveOrderProjector`
  live in Node process memory; a restart loses the served read model, which
  would need to be rebuilt from the durable event log before serving traffic
  again (the rebuild path this project already has, just not wired to run on
  startup).
- **The cutoff sweep is triggered on demand (`POST /cutoff-sweep`), not on a
  scheduler.** A real deployment would call it on a timer; nothing in this
  project's measured claims depends on how often that timer fires, only on
  what the sweep does once it runs.
- **CORS is wide open (`*`).** Acceptable for a synthetic local demo console
  talking to a synthetic local API; not a pattern to carry into a real
  deployment serving anything non-public.
- **No throughput claim.** The rebuild-benchmark times are single-run
  wall-clock numbers on a shared development machine, not a controlled
  throughput benchmark.
- **The position book is a simplified two-number-per-account model**, not a
  real custodian or PMS position feed with lots, historical prices, or
  corporate actions; the three pre-trade rules only ever need cash and a
  per-symbol book-value fraction, so that is all the book carries.
- **Pre-trade compliance runs three rules in a fixed order and stops at the
  first failure.** The seeded breach population is deliberately constructed
  so each order can only ever fail one rule; a real order that violates two
  rules at once would only ever be reported for the first one checked
  (restricted-list, then cash, then concentration).
- **The pro-rata allocator takes target weights as an input, not a model of
  how those weights were decided.** Where the weights come from (a
  portfolio manager's target allocation, an existing position ratio, or
  something else) is out of scope for this project.
