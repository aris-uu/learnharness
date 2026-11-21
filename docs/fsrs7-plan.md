# FSRS-7 via ts-fsrs, with gated fitting to your reviews

**Status:** built 2026-11-21. Fitting is inactive until the log reaches 100 training items (18 at the time of building).
**Replaces:** the hand-ported FSRS-6 in `src/core/memory/fsrs.ts`. Builds on [retention-mode-plan.md](retention-mode-plan.md) §4 and [consolidation-sessions-plan.md](consolidation-sessions-plan.md) phase 4.

## 1. Decisions (owner, 2026-11-21)

| Question | Decision |
|---|---|
| Implementation | Use the libraries, no hand-ported math: `ts-fsrs@6.0.0` (MIT, FSRS-7 model) and `@open-spaced-repetition/binding@0.6.1` (MIT, fsrs-rs optimizer, native napi). |
| Scope | Core memory only (retention, review, consolidation). `plugins/flashcards` keeps its self-contained FSRS-6 and its no-runtime-deps rule. |
| Fitting | Build the pipeline now; it is gated, so FSRS-7 default weights stay in use until the gate is met. |
| Gate | At least **100 training items**. Below that, the optimizer is not called. |
| Trigger | Fire-and-forget refit after each `record_review`, once the gate is met. |
| Storage | `data/memory/fsrs-weights.json`, read through a new store and passed in like `reviews`. Core stays pure. |
| Mature line | Mature when the model's **interval to 90% recall** is ≥ 21 days. |
| Shown "stability" | The same number, days to 90%, everywhere a stability is shown. The raw FSRS-7 state stays internal. |

Facts measured on the real log (scratchpad trial, no app changes): 31 review events and 71 seeds give **18 training items**. The optimizer returns the defaults unchanged below about 33–64 items and trains in about 0.5 s above that. So fitting is inactive today, as decided.

## 2. Why "days to 90%" replaces stability

Under FSRS-7 the forgetting curve mixes a fast and a slow trace. Recall at t = S ranged from 0.86 to 0.95 in simulation, so the `stability` field no longer means "days until recall falls to 90%". The library's `next_interval(state, 0.9)` computes that quantity directly. It becomes `daysTo90(state, weights)`, and mature means `daysTo90 ≥ MATURE_STABILITY_DAYS` (21).

## 3. Changes

**Dependencies.** Add `ts-fsrs@6.0.0` and `@open-spaced-repetition/binding@0.6.1` to `dependencies`. In `next.config.ts`, add the binding to `serverExternalPackages`, and add `node_modules/@open-spaced-repetition/binding-*/**/*` to `outputFileTracingIncludes`, following the `@napi-rs/canvas-*` precedent (a platform binary loaded as a dynamic optional dependency).

**`src/core/memory/fsrs.ts`: a thin wrapper over `ts-fsrs/models/fsrs-7`, with no formulas of its own.**
- `FsrsState` gains `stabilityFast`. It keeps `stability`, `difficulty`, `lastReview`, `reps` and `lapses` (the wrapper keeps the last three).
- `FsrsWeights = readonly number[]` and `FSRS_DEFAULT_WEIGHTS = FSRS7_DEFAULT_WEIGHTS`. Each function takes an optional `weights` argument and builds an `FSRS7Algorithm` with `FSRS7_MODEL_BOUNDS`, cached per weights array.
- `rateFsrs(state, rating, atMs, weights?)` calls `next_state(prev, elapsedFractionalDays, rating)`. The FSRS-6 same-day branch goes, because FSRS-7's fast trace handles same-day reviews itself. A lapse still counts only when rating = Again and at least 1 day has elapsed, as today.
- `retrievabilityAt(state, nowMs, weights?)` uses `curve(t, state).retrievability`.
- `intervalDays(state, retention, weights?)` uses `next_interval`. The signature changes from `(stability, retention)` to `(state, retention, weights?)`.
- `dueAt(...)` keeps its 1-day floor after Again (`minAfterAgainDays`) unchanged.
- New: `daysTo90(state, weights?) = intervalDays(state, 0.9, weights)`.
- Drop the FSRS-6 copy of `W` and the `FSRS_W` export. The MIT attribution header now names ts-fsrs 6.0.0 as a dependency instead of a port.

**`src/core/memory/items.ts`.**
- `replay`, `memoryItems`, `snapshotItem`, `memorySnapshot` and `curvePoints` gain `weights` in their options and pass it through.
- `memoryStage(item, weights?)` becomes `daysTo90 ≥ MATURE_STABILITY_DAYS`.
- New pure `trainingItems(items): Array<Array<{ rating, deltaT }>>`. It takes each item's seed and review events (never retry or followup), oldest first, with fractional-day `deltaT` (0 for the first). Every prefix of two or more events is one training item, which matches what the trial counted.
- `MemoryItemSnapshot` gains `daysTo90: number | null`.

**`src/core/memory/fit.ts` (new, server-only, imports the binding).**
- `fitWeights(items) → { weights, items: n } | null` returns `null` below `FIT_GATE_ITEMS = 100`. Otherwise it calls `computeParameters(..., { modelVersion: "FSRS-7", enableShortTerm: true })` and validates the result with `checkFSRS7Parameters`.

**`src/store/fsrs-weights.ts` (new).**
- `data/memory/fsrs-weights.json` holds `{ version: "FSRS-7", weights: number[34], items, fittedAt }`.
- `read()` returns the weights, or `undefined` (meaning defaults) when the file is missing, corrupt, or fails `checkFSRS7Parameters`. `write()` is atomic, via `writeFileAtomicSync`.
- The store is wired into `src/server/stores.ts` and the tool context next to `reviewStore`.

**Refit hook (`src/agent/tools/review.ts`, `record_review`).** After the event is appended, a fire-and-forget refit runs:
- It skips if a fit is already running (one in flight at a time, in-process flag) and never blocks or fails the tool result.
- Errors are logged and swallowed.
- Weights from a fit apply on the next read.

**Callers pass `weights`.** These are `src/agent/tools/review.ts` (snapshots, `predicted`, `nextDue`, the `stability` and `stage` output, `matured`), `src/agent/tools/math.ts` (search_evidence memory), `src/server/memory.ts` (view and due counts), and `src/core/memory/review.ts` (candidate stage filter).

**Shown stability → days to 90%.** This covers the `stability` field in `reviewCandidates` (`src/core/memory/review.ts`), the `stability` field in the `record_review` output, and the Memory page column (`components/memory-view.tsx`). Wording stays as it is ("stability", "under 21 days") because the meaning is preserved. The texts in `consolidation.ts`, `math-mode.tsx` and `contracts/chat.ts` need no change.

**Docs.** Update the FSRS-6 references in `retention-mode-plan.md` §4 and in the status lines of `consolidation-sessions-plan.md` (phase 4 → this plan).

## 4. Tests (no live model calls)

- **`tests/memory.test.ts`.** FSRS core cases are rewritten for FSRS-7:
  - first-rating stabilities match the library defaults (Again 0.1104 … Easy 11.7841);
  - Good after Good grows the state;
  - `retrievabilityAt` is about 1 at t = 0 and decreasing;
  - `intervalDays` round-trips with `retrievabilityAt`;
  - the 1-day floor after Again;
  - passing custom weights changes the result.
- **`trainingItems`.** Prefixes are correct, retries and followups are excluded, and `deltaT` is fractional.
- **`fitWeights`.** It returns `null` below the gate. Above the gate, a synthetic history of 100 or more items returns 34 valid weights (about 0.5 s, local native code).
- **Weights store.** It round-trips, and missing, corrupt or invalid files fall back to defaults.
- **`tests/session-clock.test.ts`.** The mature-line test uses `daysTo90` states.
- **`record_review` refit.** The hook fires only at or above the gate and never throws into the tool result.
- **Checks to run:** `npm run typecheck`, `npm test`, and `npm run build` (confirm the binding's platform binary appears in `.next/standalone`).

## 5. Not in scope

- The flashcards plugin.
- Evaluating fitted weights against the defaults (log loss).
- Fuzz, learning steps and `DefaultScheduler`: only the model is used, as today.
- Desired-retention changes (stays at 0.85).
- A UI for weights.
- Electron packaging beyond the trace include. `desktop:dist` is macOS-only and is not run here.
