# Retention mode: per-node forgetting curves and tutor-graded review

**Status:** draft plan (2026-11-18). Nothing is implemented yet.
**Motivation:** `D:/projects/learning/reports/learnharness-analysis-2026-11-18.md`. Teaching works, and math mode made it honest, but nothing brings a node back once its session ends. Primality was covered on Nov 6. Eight days later, in the kripto probe, Miller–Rabin and CRT came back as "forgot". Material from the standard principal-bundles session "did not survive" a day or two later.

## 1. Which of the analysis suggestions are implementable here

| # | Suggestion | In LearnHarness? | Where | Size |
|---|---|---|---|---|
| A2 + A3 | Scheduled retests; evidence goes stale | **Yes: this plan** | new `src/core/memory/*`, new session kind | L |
| G | Confidence slider on written answers | **Yes** | `question-core.ts` (currently quiz-only, ~l.751), `question-dock.tsx`, `shared/25-confidence.md` | S |
| C | Habit tags on partial answers + pre-submit checklist | **Yes** | optional `habits[]` on `record_evidence`; doctrine in `profiles/math/teacher/30-question-principles.md` | S |
| F | "Stuck point" instead of a bare idk | **Yes** | math-mode doctrine; optionally a stuck-point text field when `dontKnow` | S |
| D | "Which hypothesis fails?" drills | **Yes**, as doctrine | math-mode question principles; a question family in review mode (§6) | S |
| E | Protect throughput (cap re-plans, fixed goal) | **Yes**, soft | `plan_init` in math mode returns a warning past N nodes or after the 2nd re-plan | S |
| I | Code profile (evidence = code that passes a test) | Yes, later | `TEACHING_PROFILES = ["math","code"]`, reusing the `coding-questions` plugin | M–L |
| B | Merge with the anki-prompt math profile | **Partly** | No LH code needed: register the `anki` MCP server under Settings › Agent › MCP servers (supported since 61ff380), so the planner can read `concepts.yaml` ids. The exporter itself lives outside LH. | S + outside |
| A1 | Anki cards from evidence | Covered by the flashcards plugin for K. Otherwise replaced by this plan | — | — |
| H, J | Computation warm-ups; smaller practice sets | Become review mode's S questions and session budget | — | — |
| — | One thread per week, finishing what you start | No. These are habits, not features | — | — |

Phase 0 (below) bundles the S-sized items, because they are independent of the rest and make review mode's data better.

## 2. Why not the flashcards plugin

The flashcards plugin already ships FSRS-6 (`plugins/flashcards/src/scheduler.cjs`). It is deliberately the cheap path: you rate yourself (Again/Hard/Good/Easy), it reviews graph **propositions**, makes no model call per review, and holds no learner evidence. Its vision doc rules out agent grading in v1 and keeps learner evidence out of the graph.

Retention mode is the expensive complement:

| | Flashcards | Retention mode |
|---|---|---|
| Unit | graph proposition | **math-mode plan node** (an item with K/U/S/P evidence) |
| Question | fixed cue cards | **generated fresh** by the tutor for every review |
| Grade | self-rated | **tutor-graded** written attempt → mapped to an FSRS rating |
| Dimensions | recall only | K, U, S, P |
| Cost | none | one model turn per question |

They can coexist: flashcards for cheap K upkeep, retention mode for U/S/P. A bridge comes in phase 3: when only K is weak, push cues for that item to flashcards.

## 3. Data model

There are two new append-only files under `data/memory/`. Schedule state is **derived by replaying the log** and never stored. That makes it deterministic, auditable, safe to re-parameterize, and gives no state that can be corrupted.

```ts
// data/memory/items.jsonl: one line per item (first line for an id wins, like the graph)
interface MemoryItem {
  id: string;              // `${chatId}#${nodeId}`: stable, because plan slugs are per chat
  chatId: string; nodeId: string;
  title: string; summary?: string;
  createdAt: string;       // time of the first credited evidence
  sameAs?: string[];       // phase 3: other item ids for the same idea (see §8)
  prereqs?: string[];      // item ids from that chat's plan edges (direct only)
  status: "active" | "unverified" | "retired";
}

// data/memory/reviews.jsonl: one line per scheduling event
interface ReviewEvent {
  id: string;              // the record_review tool-call id
  itemId: string;
  chatId: string;          // the session where it happened (seed = the teaching chat)
  at: string;              // ISO time
  kind: "seed" | "review" | "retry";   // only seed and review move the schedule
  dimension: "K" | "U" | "S" | "P";
  outcome: MathOutcome;    // same vocabulary as record_evidence
  hints: number;
  rating: 1 | 2 | 3 | 4;   // Again/Hard/Good/Easy, computed by the server (§5)
  confidence?: number;     // from phase 0's slider
  elapsedSeconds?: number; // from the answer timer (fb52e30)
  question: string;        // what was asked, so the next review avoids repeating it
  note: string;            // tutor's one-line grade note
  habits?: string[];       // phase 0 tags
}
```

Store port and fs adapter: copy the `EvidenceStore` pattern (`src/core/math-evidence.ts`, `src/store/evidence.ts`). Deleting a chat removes the items it seeded, along with their review events.

## 4. Forgetting curve

FSRS-6 tracks **one schedule per item**. The K/U/S/P dimensions play the role the flashcards plugin gives to cues: they are different ways in to the same item. Each review picks which dimension to test (see §6).

- Port the core of `scheduler.cjs` to `src/core/memory/fsrs.ts` as a typed module: `W`, `DECAY`, `FACTOR`, `initDifficulty`, `nextDifficulty`, `reviewStability`, and retrievability `R(t,S) = (1 + FACTOR·t/S)^DECAY`. Drop the minute learning steps and the study-day boundaries, which don't fit tutor sessions. Keep the MIT attribution. The plugin stays self-contained, per its own design rule, so a small amount of math gets duplicated.
- `replay(events) → { stability, difficulty, lastReview, due, R(now) }` per item.
- **Desired retention defaults to 0.85**, not 0.90. Fresh tutor-made questions are harder than a fixed card, and each review costs a model call. It is a setting.
- The default FSRS parameters were fit to flashcard data, so the predicted R is only a prior. Log predicted R on every review event. After about 200 reviews, compare predicted with observed pass rate, and later optimize `W` from the log. Nothing is lost by starting on the defaults.

**Seeding.** As built in phase 1, seeds are *derived on every read* from `evidence/evidence.jsonl` rather than written to `items.jsonl`, so there is no backfill and no new data file until reviews exist (phase 2 adds `reviews.jsonl` only). The table:

| The node's final status in its teaching chat | Seed |
|---|---|
| solid, with an unhinted `correct` K and an unhinted `correct` U/S/P | `seed` Good at the time of the last credited record |
| solid otherwise (a hint or a slow answer) | `seed` Hard |
| in_progress (latest partial/incorrect) | `seed` Again, so it is due within about a day |
| assumed only | item `unverified`, due now, low priority: verify once |
| skipped (learner_override) | not seeded |

Today's ledger would produce about 73 items. Most of the topology and G-bundles items are already overdue by any curve, which matches what the probes found.

Because the seed is derived, every new math-mode `record_evidence` call is picked up on the next read, so retention works without manual steps.

## 5. Mapping grades to FSRS ratings

The tutor reports the **outcome**, as it does now. The server computes the **rating**, so the mapping is auditable and consistent.

| Tutor's report | Rating |
|---|---|
| `incorrect`, or idk, or `partial` with `loadBearing: true` | **Again** |
| `partial` with `loadBearing: false`, `correct_slow`, or `correct` with 1 hint | **Hard** |
| `correct`, 0 hints | **Good** |
| `correct`, 0 hints, confidence ≥ 90 and `elapsedSeconds` ≤ the tutor's `expectedSeconds` | **Easy** |

The tutor gives `loadBearing` for a partial: was the missing piece the step that carries the argument? Your recurring pattern of "asserting the key step" is exactly the case that should count as Again.

Only the **first** attempt on an item in a session moves the schedule. The repair and retry after an Again are logged as `retry` and don't count, so re-teaching within the session can't inflate stability. The next review after an Again comes back no sooner than 1 day later.

## 6. Session flow: the new "review" kind

`ChatKind = "teach" | "practice" | "review"`. Review is a separate kind, not a profile. `composeInstructions` skips profiles for practice, and review needs its own toolset and its own stop rules. Prompts go in `src/agent/prompts/review/`, plus the shared segments. Session title: `Review YYYY-MM-DD`, one chat per day, so history stays readable.

**Tools**

- `due_items({ limit })` (read only, at the start). Returns the ranked candidates, about 15, each with: title, summary, R now, days overdue, stability, which dimensions are credited, the last 3 questions asked and their notes, habit tags, and the prerequisites that are also due. Ranking: R ascending, then prerequisite-of-due-items first, then recent Agains.
- `pick_items({ itemIds, reasons })`. The tutor hand-picks the session: default 6 items (about 30 min, a setting). It interleaves topics, puts a prerequisite before its dependent when both are due, and collapses `sameAs` duplicates. The server rejects ids outside the candidates unless `override` is set, and logs the picks.
- `explain` / `recall` with `itemId` instead of `nodeId`. They are concealed, as in math mode, and carry the confidence slider.
- `record_review({ itemId, dimension, outcome, hints, loadBearing?, expectedSeconds, note, habits? })`. Returns the rating, the new due date and R. Its instruction text tells the tutor what to do next: repair, or move on.
- `search_evidence`: the existing tool, extended to return R and `stale`.
- No `plan_init`, no gate, no graph writes, no extraction.

**Question generation** (doctrine, `review/20-questions.md`)

- **Never reuse a past question.** `due_items` hands over the last questions for that reason: recalling an answer you've seen is not retrieving the knowledge.
- Choose the dimension by weighted choice, as the flashcards plugin chooses a cue. Favour dimensions that were never credited or were last missed, and keep strong ones eligible. A K-only item gets U or S once K holds again.
- Question families per dimension:
  - **K**: state it with every hypothesis.
  - **U**: drop or weaken one hypothesis, then give a counterexample *and* the step of the proof that breaks (suggestion D).
  - **S**: a fresh small computation, writing the reductions out (H).
  - **P**: a blank-page proof of the key lemma, ≤ 10 min.
- Aim at the item's last notes. If the history says "asserted V_x disjoint from K", the next P question should require exactly that step.
- After an Again: one short repair, then one `retry` on a *different* question, deferred behind two other items (built 2026-11-18 after the first live review; `RETRY_GAP` in `src/core/memory/review.ts`). `noRetry` skips it when the learner says the item was never consolidated. If it still fails, offer "Open a teach session from this item": a new math-mode teach chat seeded with the item and its notes, reusing the Go back message pattern.

**UI**

- **Due count badge** on the new-session button, and a "Review (N due)" entry in the session picker.
- **Memory view** (a new pane): a table of items with R now, next due date and stability, and a per-item sparkline of R over time with review marks. Read only, apart from retire/unretire and `sameAs` linking.
- **Plan tree** in math-mode chats: tint each node by its item's R. This makes decay visible inside the original lesson.

## 7. Changes to math mode (A3, evidence goes stale)

- `nodeStatus` gets a cross-session reading, `solidNow`: solid **and** R ≥ the desired retention. `search_evidence` returns `stale: true` when that fails. The prober doctrine (`profiles/math/prober/10-probe-doctrine.md`) changes from "skip what is solid elsewhere" to "skip what is solid *and fresh*; re-probe what is stale". The per-chat gate is unchanged.
- When a teaching session's prober re-tests a stale item, it writes a `review` event. Probes in teaching sessions then double as reviews, and nothing is tested twice.

## 8. Later (phase 3)

- **`sameAs` linking.** The topology "Compact-to-Hausdorff lemma" and the G-bundles one are the same idea, but they are separate items today. At `plan_init` in math mode, the planner may declare `continues: "<chatId>#<nodeId>"` on a node, found through `search_evidence`. The Memory view also allows manual linking. Linked items share one schedule, with events merged by time.
- **Implicit credit along prerequisites**, in the spirit of Math Academy's "FIRe" idea and your `encompass` edges in `concepts.yaml`. A Good on a P question for node X could give its direct prerequisites a fractional review. This is risky, because a success can route around a prerequisite. Leave it off until the log can test it.
- **Parameter optimization** of FSRS `W` from `reviews.jsonl`.
- **Flashcards bridge** for K-only upkeep.
- **Code profile** reusing this machinery, with test-passing code as evidence.

## 9. Phases and files

**Phase 0: small math-mode fixes (independent, about a day each)**
1. Confidence slider on `explain`/`recall` when `profile === "math"`. Touches `question-core.ts` (confidence handling), `question-dock.tsx` (`kind === "quiz"` checks), `answered-card.tsx`, `compactAnswerForModel`, and a written-answer paragraph in `shared/25-confidence.md`. Add tests next to `tests/question-core.test.ts`.
2. Optional `habits` on `record_evidence`, with the taxonomy in `profiles/math/shared/habits.md` so it can be edited without code. Also add it to `EvidenceRecord` and the validator in `store/evidence.ts`.
3. Doctrine: a stuck-point request on idk; the pre-submit checklist shown before P questions; the hypothesis-drop family; a soft re-plan warning.

**Phase 1: memory core (read only for you)**
**Built (2026-11-18):** `src/core/memory/fsrs.ts` (FSRS-6 with the ts-fsrs 5.2.3 defaults) and `src/core/memory/items.ts` (seeding, replay, snapshot, curve points), all derived from the ledger with no stored state; `search_evidence` returning `memory: {recall, dueAt, stale}` or `{unverified: true}`; prober/teacher doctrine to re-test stale items; and the read-only Memory view at `/memory` (sidebar → Memory) via `src/server/memory.ts` and `components/memory-view.tsx`. Tests: `tests/memory.test.ts`, `tests/render-memory-view.test.tsx`, and a case in `tests/evidence-ledger.test.ts`. `src/store/memory.ts` and the rating table move to phase 2, where reviews first exist.

**Phase 2: review kind**
**Built (2026-11-18):** `ChatKind` `"review"` and the `reviewer` agent (`createReviewerAgent`, prompts in `src/agent/prompts/reviewer/`, composed like practice with a curated shared appendix); `src/agent/tools/review.ts` (`due_items`, `pick_items`, `record_review`; `explain` concealed and tagged with the picked item's slug); `src/core/memory/review.ts` (the §5 table as `ratingFor`, candidate ranking, slugs); the log `data/memory/reviews.jsonl` via `src/store/memory.ts`, removed with its chat; a clean `pick_items` result moves the phase from probe to plan; no extraction in review chats; one review chat per day via `POST /api/chats {kind:"review"}`; **Start review** on the Memory page and a due badge on the sidebar's Memory entry (`GET /api/memory`). Decisions taken with the defaults of §10: one schedule per item, partial is Again unless `loadBearing: false`, retention 0.85, six items, prober-only staleness, standard-mode sessions not counted. Not yet: plan-tree tinting in math-mode chats, the "open a teach session from this item" button (the reviewer offers it in prose), and §7's prober re-tests writing review events.

Originally planned: `ChatKind` extension (with a reader fallback; the chat record version stays 2 if the reader tolerates unknown kinds, so check `chats.ts`), `src/agent/tools/review.ts`, `src/agent/prompts/review/*`, agent wiring in `teacher-agent.ts`/`tools.ts`, the new-session entry with the badge, and plan-tree tinting.

**Phase 3**: §8.

## 10. Decisions for you

1. **One schedule per item, or one per (item, dimension)?** This plan has one per item, with dimensions as ways in. Per-dimension curves would capture that P may fade differently from K, but there is too little data now to fit four curves per item.
2. **Partial = Again or Hard?** The plan splits them with `loadBearing`. The simpler alternative is "partial is always Again", which is stricter but honest.
3. **Desired retention**: 0.85 to start?
4. **Session budget**: 6 items or about 30 min, one chat per day?
5. **Should the stale signal change the teaching gate**, or only what the prober does? The plan says prober only.
6. **Should standard-mode sessions count?** They have no evidence records. The plan leaves them out. Re-entering them means writing a review event, which also measures what the MC sessions actually left you with.
