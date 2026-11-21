# Consolidation sessions: re-teaching for young items, review for mature ones only

**Status:** built 2026-11-20 as a mode of the review kind (`settings.consolidate`, not a new `ChatKind`): phases 1–3. Phase 4 built 2026-11-21 as [fsrs7-plan.md](fsrs7-plan.md): FSRS-7 via ts-fsrs, refit after each graded review once there are 100 training items; "stability" and the mature line are now days to 90% recall.
**Builds on:** [retention-mode-plan.md](retention-mode-plan.md) (the memory model and review kind, built) and [timeboxed-sessions-plan.md](timeboxed-sessions-plan.md) (the sitting, a draft).

## 1. The idea

This takes over Anki's split between *learning* and *mature* cards:

| Stage | Rule | Session | What happens |
|---|---|---|---|
| **Learning** | stability < 21 days, unverified, or relearning after a lapse | **Consolidation** (a teach-like sitting) | Attempt first, then re-teach what broke, then check again later in the sitting |
| **Mature** | stability ≥ 21 days | **Review** (the existing kind) | One fresh question per item, graded; no teaching beyond a short repair |
| **Lapsed** | a mature item rated Again in a review | back to learning | The next consolidation sitting takes it, at the earliest the next day |

**Why.** Review sessions currently test items that were never consolidated:
- First attempts pass 6/13 = 46 %, against a predicted 72 %.
- Two of three Agains on 11-18 were "not consolidated"; you skipped them, and `noRetry` exists because of it.
- On 11-18 the cold AᵀMA = M question failed twice. In the bilinear teach session it came back after a warm-up.

Testing items that are still in learning measures encoding that didn't happen yet and costs a failure per item.

## 2. Where things stand (memory snapshot, 2026-11-20)

| Stability | Items |
|---|---|
| unverified (assumed only) | 21 |
| < 3 days | 66 |
| 7–21 days | 5 |
| **≥ 21 days (mature)** | **0** |

68 are due now. **Under this rule review mode would be empty for the next couple of weeks, and all retention work becomes consolidation.** That is expected: the system has only been running since 11-18.

How fast an item could mature under the FSRS-6 defaults then in use at 85 % retention, simulated with `rateFsrs` / `dueAt`:

| Ratings | Reaches S ≥ 21 |
|---|---|
| Good (seed), Good, Good | after the 3rd rating, about day 4 (S = 17 → 95) |
| Hard (seed, encoding cap), Good, Good | after the 3rd rating, about day 16 (S = 1.3 → 7.3 → 33) |
| Hard, Hard, Good, Good | after the 4th, about day 46 |

So an item typically needs **2–3 successful spaced retrievals** to mature. The default parameters are overconfident for you (46 % passed against 72 % predicted). Once about 100 graded events exist, fitting FSRS parameters to your own log would make "mature" mean what it says.

## 3. One correction to "just reteaching"

**A consolidation sitting has to begin each item with a graded attempt.** This doesn't change the idea, but without it the design doesn't work, for three reasons:

1. **Graduation.** Stability only grows from graded retrievals at spaced intervals. Pure re-teaching produces no rating, so no item would ever reach 21 days.
2. **The testing effect.** An attempt before re-teaching is itself the strongest consolidation step, even when it fails. Re-teaching after a failed attempt also sticks better than re-teaching cold.
3. **Aim.** The attempt shows *which* part is gone, so the re-teach targets that step instead of the whole node.

What makes it different from review is **what happens after the attempt**, not whether there is one:

| | Review (mature) | Consolidation (learning) |
|---|---|---|
| Opening question | The hardest rung that is fair | **The easiest rung** (state it), climbing only on a clean answer, as the existing ladder does |
| After a miss | One short repair; the retry is deferred | **Full re-teach** of the broken step: examples, the learner rebuilds it, as in a math-mode teach session |
| Grouping | Interleaved across topics | **By topic cluster**: an item together with its due prerequisites and confusable neighbours, such as flux / surface area / divergence theorem |
| Evidence | `record_review` only | `record_review` for the first attempt (moves the schedule). Re-teaching records `record_evidence` on the same node, which never moves the schedule |
| End | Summary | The time-boxed close: one blank-page retrieval per cluster, and a hand-off |
| Length | ~3 min per item | ~10–15 min per item: 3–4 items in a 45–60 min sitting |

Only the first attempt per item per sitting moves FSRS, as today. That rule stays, so re-teaching within the sitting can't inflate stability.

## 4. Scheduling consolidation

It stays spaced repetition; only the activity changes.

- **Due rule:** the same FSRS due date as now, restricted to items in learning. Unverified items are due at once; their first attempt is the verification.
- **Picking a sitting:**
  1. Take the most overdue learning item.
  2. Add its due prerequisites (plan edges) and items with high interference: same source chat, or a recent Again on a look-alike.
  3. Stop when the cluster fills the budget (`floor(teachMin / 12)` items).
- **The 1-day floor:** every item gets at least 1 day between sittings (as now after an Again), so a consolidation sitting is never a same-day repeat.
- **Graduation:** when stability crosses 21 after a first attempt, the closing summary says so (for example "Transport → mature, next review Dec 30"). From then on, the item appears only in review.
- **Lapse:** a mature item rated Again in review is marked `relearning`. It leaves review and is picked by the next consolidation sitting. Lapses already count in `FsrsState.lapses`.

`noRetry` ("never consolidated") becomes unnecessary in review, because such items no longer reach review. In consolidation, the same statement from the learner just skips the attempt and goes straight to re-teaching. The item is graded Again, as today.

## 5. How it fits in

- **Kind.** A new `ChatKind = "consolidate"`. It uses the teacher's teaching doctrine plus a consolidation segment, and the reviewer's item tools (`due_items` filtered to learning, `pick_items`, `record_review`). It is always time-boxed, using the sitting from the time-boxed plan, so it has a budget, goals (one per cluster: "state and use X") and a close.
- **Math mode.** It's on by default for these sittings, because it gives written answers and evidence.
- **Sidebar.** The Review door splits in two: **Consolidate (N)** and **Review (M)**. The counts come from the same snapshot.
- **Teach sessions' new nodes** enter as learning items exactly as now (seed capped at Hard). New material therefore flows through the stages teach → consolidate ×2–3 → review.
- **Daily budget** (fatigue report): consolidation is the block-2 activity. One 45–60 min sitting a day, before or after new teaching, keeps up with about 3–4 items a day. A rough count at today's pace: about 4 new nodes a day × 2–3 sittings each ≈ 10 items of consolidation work a day. That is more than one sitting covers, which is an argument for **teaching fewer new nodes**, not for longer sittings. It is the same finding as "one topic per week".

## 6. Changes by file

| File | Change |
|---|---|
| `src/core/memory/items.ts` | `stage(item): "learning" \| "mature" \| "relearning"`, with `MATURE_STABILITY_DAYS = 21` (a setting); `relearning` from the last review event's rating on a once-mature item |
| `src/core/memory/review.ts` | `reviewCandidates` takes `stage` and filters; a new `consolidationClusters` that groups by prerequisite edges and source chat and sizes by budget |
| `src/core/contracts/chat.ts` | `ChatKind` adds `"consolidate"` |
| `src/agent/tools/review.ts` | `due_items` / `pick_items` take `stage`; `pick_items` in a consolidate chat accepts clusters |
| `src/agent/prompts/consolidate/` | new doctrine: attempt first on the easiest rung, re-teach the broken step, re-check late in the sitting, close |
| `src/agent/prompts/reviewer/` | drop the "never consolidated" branch; mature items only |
| `src/server/chat-handler.ts` | build the consolidation agent (teacher tools + item tools) |
| `components/` | split the sidebar door; Memory page column "stage" |
| `tools/lh-analysis` | pass rate by stage; time to maturity; lapse rate of mature items |

## 7. Phases

1. **Split only:** compute `stage`, filter review to mature, and show "N in learning" on the Memory page. Small change, and it stops review from testing young items right away.
2. **Consolidation kind:** the doctrine, the tools and the sidebar door. This depends on the time-boxed sitting's phase 0 (the clock) and phase 1 (the close) for the sitting itself. Until then, a consolidation chat can run untimed with a fixed 3–4 items.
3. **Clusters and interference grouping**, graduation messages, lapse → relearning.
4. **Fit FSRS parameters** to your log once there are about 100 graded events, so that 21 days of stability means a real 21 days.

## 8. Open decisions

1. **Threshold: stability ≥ 21 days or interval ≥ 21 days?** Anki defines mature by interval. At 85 % retention the interval is about 1.9 × stability, so "interval ≥ 21" means stability ≥ about 11. Proposed: **stability ≥ 21**, as you said. It is the stricter rule, which fits a schedule that is currently overconfident.
2. **Unverified items** (21 now, assumed-only): consolidate them, or verify them with one quick question in review? Proposed: consolidation, since an assumption has never been tested.
3. **Can a mature item still be pulled into a consolidation cluster** as a prerequisite? Proposed: yes, as a warm-up whose attempt is logged as `followup`, so it doesn't move its schedule.

## 9. Changes after the first sittings (2026-11-21)

From `D:/projects/learning/reports/timebox-consolidation-fsrs7-2026-11-21.md`. The first four 25-minute sittings used 6–15 minutes each, two repair answers went unrecorded, and one item matured on the easiest rung right after its proof follow-up failed.

- **Item count:** `floor(budget / 6)` (25 min → 4), not `floor(teachMin / 12)`. When the picks are done with more than about 8 minutes left before converge, the tutor picks more.
- **1-day floor after every rating**, not only after Again (`dueAt` in `core/memory/fsrs.ts`). Under FSRS-7's defaults a Hard could fall due within the hour.
- **A failed follow-up caps the first attempt** one step on replay (`capByFollowUps` in `core/memory/items.ts`; the log keeps the graded rating, the event carries `cappedFrom`).
- **`record_review` `check: "repair" | "close"`** (event kind `check`): the rebuild after a repair, and the blank-page close retrieval per item. Logged only; never the retry, never moves the schedule, not training data.
- **The close:** `close_session` in a consolidation sitting refuses until every attempted item has a close check, unless `closeChecksSkipped` gives the reason. The items themselves stand in for goals.
- **`minutesIn`** is written on evidence records and review events (`minutesIntoSitting` in `core/session-clock.ts`).

