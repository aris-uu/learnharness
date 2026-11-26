# Plan: retest depth (P/U) and contrast items for look-alikes

Status: **implemented 2026-11-26** (uncommitted on `fork`). See *As built* at the end for where the code differs from this proposal. Motivated by [learnharness-analysis-2026-11-26.md](D:/projects/learning/reports/learnharness-analysis-2026-11-26.md) §2.3–2.5 and §4.4. The owner agreed (2026-11-26) that consolidation should push P/U rungs even if the pass rate drops.

## The problem in the data

**A. Retention is only measured on the easiest rung.**
- 41 of 54 cross-session first attempts are K. Of the 50 concepts ever retested, 27 were retested on K only.
- Since the analysis began there has been 1 cross-session P first attempt and 3 U.
- An Easy K statement can push an item out by weeks. `basis-vector-test` and `preservers-form-group` each got one Easy K on 11-20, plus a U follow-up that held, and both are now due 2027-01-12. Nothing on their record shows the proof survives.

**B. The look-alike machinery exists but is almost never fed.**
- `confusableWith` is set on 4 of 255 concepts (2 pairs, both from 11-25).
- Clusters only *place* confusables next to each other. Nothing asks the learner to tell the two apart.
- The high-confidence misses are all confusions: flux vs area element, divergence theorem vs flux formula, B_M vs the determinant form, a form's matrix vs a map's matrix, [Au_j]_B vs column j of A. None of them is linked.

## Why the current code lets this happen

| Mechanism | Where | Gap |
|---|---|---|
| The first attempt is the only schedule-moving event, and it is asked on the easiest rung | `prompts/reviewer/20-questions.md` (ladder) | Even a non-stale item opens on K in practice, because the prompt says "prefer K" on a first review and gives no rule for later ones |
| Climbing is optional | `tools/review.ts:264`: "You **may** climb one rung" | The tutor rarely climbs: 12 follow-ups across 54 first attempts |
| "The easy rung does not mature an item alone" | `items.ts` `capByFollowUps` | It only fires when a follow-up was asked **and failed**. A follow-up that was never asked costs nothing, so skipping the climb is the cheaper path for the tutor |
| `checks` (what a P/U question must produce) | `math-concepts.ts` `checks` | Set on 2 of 255 concepts, and 233 statements are still `scopeDraft`. The tutor has nothing to aim a P question at |
| Recording a confusion takes a separate `update_concept` call | `tools/math.ts:61` | It's an extra call after grading, so in practice it rarely gets made |

The fix is mostly **code that changes the default**, plus small prompt edits. Prompt-only changes have already been tried here ("prefer…", "may climb") and were not followed.

---

## A. Depth: make proofs and rationales part of what "retained" means

### A1. A depth requirement per concept kind (code)

Add to `src/core/memory/items.ts`:

```ts
/** Dimensions an item must show *after the encoding window* before it can mature. */
export const DEPTH_TARGET: Record<ConceptKind, MathDimension[]> = {
  definition: ["K", "U"],      // state it, and say what breaks without a clause
  fact:       ["K", "U"],
  theorem:    ["K", "P"],      // state it, and prove the key step
  technique:  ["K", "S"],
  example:    ["S"],
};

/** Dimensions credited (correct/correct_slow, ≤1 hint) outside the encoding window, any role except repair. */
export function retainedDims(events: readonly MemoryEvent[], firstAttemptMs: number): Set<MathDimension>
```

Expose `retainedDims` and `depthMissing = DEPTH_TARGET[kind] \ retainedDims` on `MemoryItemSnapshot` and on `ReviewCandidate`. Follow-ups and `close` checks count toward retainedDims. Repairs do not, because a repair is a rebuild with the answer still fresh.

### A2. Close the maturity hole (code)

This is the key change. Generalise `capByFollowUps` into `capByDepth`:

> A first attempt rated Good or Easy is capped at **Hard** when the item still has `depthMissing` after this sitting, meaning no follow-up or close check in the same sitting credited a missing dimension.

Effects:
- An item can no longer mature on recall alone. FSRS keeps bringing it back at Hard intervals until a P/U/S rung holds outside the encoding window.
- A clean K plus a clean P follow-up earns the full rating. That is the reward for climbing.
- A failed follow-up still lowers the rating one step, as now.

Keep it deterministic and replayable from the log, like `capByFollowUps`. Old attempts can be rescored with no data migration, because the snapshot is recomputed from `attempts.jsonl`.

### A3. Make the climb mandatory when depth is missing (tool instruction)

In `tools/review.ts` (`instruction` around line 264–285), after a Good/Easy first attempt:

- if `depthMissing` is non-empty: **"Climb now: ask one {dim} question on this item (graded with `followUp: true`). This item cannot mature until a {dim} answer holds outside the teaching sitting."** Pick `dim` as the first element of `depthMissing`.
- otherwise keep the current optional wording.

`MAX_FOLLOW_UPS = 2` already fits the K→U→P path. Keep it at 2, and make sure the mandatory depth rung is the first follow-up, not a second U.

### A4. Open on the deeper rung once K has been retained (prompt + candidate field)

Add `firstRung` to `ReviewCandidate`:
- `"K"` if K is not in `retainedDims` or the item is `stale`;
- otherwise the first element of `depthMissing`;
- otherwise rotate: the least recently retained dimension in `DEPTH_TARGET`.

Change `20-questions.md`, "Choose the dimension":

> Ask the first attempt on `firstRung`. It is K only until the statement has been retrieved once after teaching. After that the first attempt, which moves the schedule, is on the deeper dimension, so the schedule tracks whether the proof or the reason survived, not only the statement.

This keeps the stale-item ladder (stale items still open on K). It also means that, for items whose K is retained, FSRS is fed P/U outcomes directly.

### A5. Scope before a deep question (tool gate)

A P/U question needs a target. In `record_review`, when the attempt is P or U and the concept has no `checks[dim]`, refuse with: "Set `checks.{dim}` with `update_concept` first: one line naming what the answer must contain (the step that carries the proof, or the hypothesis and its counterexample)." This also gradually cleans up the 233 `scopeDraft` statements, one item at a time. It's cheap: one call per concept, once.

### A6. Size and time (prompt)

P rungs in consolidation stay "one key step, at most five minutes" (already in the prompt). Add to `CONSOLIDATION_DOCTRINE`: *"At most two depth rungs per sitting, on different items; the rest of the sitting goes to first attempts."* That stops a 25-minute sitting from turning into one long proof.

### A7. Measure it (analysis)

`tools/lh-analysis/analyze.py` and `trends.py` get these:
- **Retained-depth coverage:** the share of scheduled items with `depthMissing = ∅`.
- **Cross-session pass rate by dimension**, which already exists in `trends.py`. The target is for P+U to be at least 30 % of cross-session attempts within two weeks.

Expect the consolidation pass rate to drop from 88 %. That is the point of the change, not a regression.

### Tests (`tests/review.test.ts`, new `tests/memory-depth.test.ts`)
- Clean K Easy, no follow-up, theorem kind → event rating capped to Hard; item not mature.
- Clean K Easy + clean P follow-up outside the encoding window → Easy kept; `depthMissing` empty.
- P follow-up inside the encoding window (teaching sitting) → doesn't count.
- `firstRung` = K for stale or K-unretained items; = P for a theorem with K retained.
- `record_review` refuses a P attempt on a concept without `checks.P`.
- Replaying the current `attempts.jsonl` fixture: `basis-vector-test` no longer due 2027-01-12.

---

## B. Contrast items: tell the look-alikes apart on purpose

### B1. Record the confusion as part of grading (code)

Add to the `record_review` and `record_evidence` schemas (`tools/review.ts`, `tools/math.ts`):

```ts
confusedWith: Type.Optional(Type.String({ description:
  "Concept id the answer produced instead of this one (gave the flux formula for the divergence theorem). " +
  "Links both concepts as confusable; tag the attempt with the `confused_with` habit." }))
```

Server side:
- Validate the id.
- Write `confusableWith` on both concepts, reusing the `update_concept` logic at `math.ts:285–300`.
- Add `"confused_with"` to `MATH_HABITS` in `math-evidence.ts`.

When the confused object isn't a concept yet, such as "the determinant form", the tutor creates it with `update_concept` first. The tool error should say exactly that.

Add this row to `12-habits.md` and to the reviewer grading section:

| `confused_with` | gives the right answer *to a neighbouring concept*: another formula, object or theorem that looks alike (area element for flux, map matrix for form matrix, a vector for its coordinates). Pass `confusedWith`. |

### B2. A contrast check (code + prompt)

- Add `"contrast"` to `REVIEW_CHECKS` (`review.ts:18`), with a new optional `pairWith: conceptId` field.
- A contrast is **one question about both items**: "Which of these is X and which is Y? What does each compute? Give one input where they differ."
- Grade it once, and log it on both items (two attempt rows sharing a `pairId`).
- Like other checks it never moves a schedule directly.
- Add a rule to `capByDepth`: **a failed contrast caps both items' first attempts in that sitting at Hard.** That way, a pair still being confused cannot mature.

Prompt additions:
- `CONSOLIDATION_DOCTRINE`: *"When a cluster contains a confusable pair and both first attempts are graded, ask one contrast question before the close. When the pair was confused before (`confused_with` in either history), the contrast is required."* Enforce it the way the close checks are enforced: `close_session` refuses while a required contrast is missing, unless `contrastSkipped` gives a reason.
- `00-base.md` (review of mature items): *"If an item has a confusable concept, ask its first question without cues that name which one it is. The retrieval must select the right one. The bare cue is the test, as with the divergence theorem asked cold."*

### B3. Keep pairs together across the stage boundary (code)

`consolidationClusters` only pulls in confusables that are themselves due candidates. In the flux case one side was due and the other wasn't. Change it so that a confusable which is **not due** still joins as a contrast partner:
- it goes in a new `contrastWith` list on the cluster, like `warmUps`;
- it is asked only inside the contrast question;
- its own schedule doesn't move.

`pickItems` in review sittings gets the same rule.

### B4. Backfill the known pairs (one-off, owner runs it)

These come from the analysis. The tutor (or a small script that uses `update_concept` through the app) should link them. Don't hand-edit `concepts.json`.

| Concept | Confused with | Evidence |
|---|---|---|
| `flux-integral-orientation` | `surface-area-element` | Review 11-18: wrote \|r_u×r_v\| for flux |
| `divergence-theorem-r3` | `flux-integral-orientation` | Review 11-19: gave the flux formula at 90 % |
| `new-basis-matrix` / `congruence` | `matrix-change-basis` | bilinear 11-18: read diag(2,2) as a map, 90 % |
| `change-of-basis` | `change-of-basis-coords` | spherical 11-19: [Au_j]_B as column j of A, 100 % |
| `form-preserver-equation` | (new) determinant / symplectic form | Review 11-18: read B_M as the determinant form |
| `box-flux-ftc` | `divergence-theorem-r3` | Consolidate 11-21: P at the same point on both faces |

### Tests
- `record_review` with `confusedWith` links both concepts and tags the habit; an unknown id is refused.
- Cluster with a due item whose confusable isn't due → `contrastWith` contains it, `itemIds` doesn't.
- Failed contrast → both first attempts in that chat capped to Hard; passed contrast → unchanged.
- `close_session` refuses while a required contrast is missing.

---

## Order of work

1. **A2 + A1**, the cap and the depth table. This is the single change with the biggest effect, it is pure core code, and it can be replayed on existing data.
2. **B1**, `confusedWith` + habit. This is small and makes the data start accumulating at once.
3. **A3–A5**, the instructions, `firstRung` and the checks gate.
4. **B2–B3**, contrast checks and partners in clusters.
5. **B4** backfill, then **A7** metrics. Rerun `trends.py` around Dec 10.

Risks:
- The due backlog will grow, because fewer items mature. Watch the `due_items` count. If it passes about 2 sittings' worth, lower the depth target for `fact` to K+U only on `definition`-like facts.
- Tutor-written grades on P are noisier than on K. That's acceptable, since P is what the owner most wants measured.

---

## As built (2026-11-26)

| Step | Where |
|---|---|
| A1 depth table, `retainedDims`, `depthMissingFor` | `src/core/memory/items.ts` (`DEPTH_TARGET`; `MemoryItem.retained` / `depthMissing`) |
| A2 `capByDepth` (also the B2 contrast cap) | `items.ts`, applied in `conceptEvents` after `capByFollowUps` when the concept kind is known |
| A3 required climb | `src/agent/tools/review.ts`, the `climb` instruction ("Climb now: …") |
| A4 `firstRung` | `src/core/memory/review.ts` `firstRungFor`, on every `ReviewCandidate`; prompt `reviewer/20-questions.md` |
| A5 checks gate | `record_review` refuses U/P grades without `checks[dim]` (repairs and contrasts exempt) |
| A6 sizing | `src/agent/consolidation.ts` (at most two depth rungs per sitting) |
| A7 metrics | `scripts/memory-metrics.ts` `depth`, printed by `tools/lh-analysis/analyze.py` |
| B1 `confusedWith` + `confused_with` | `record_review`, `record_evidence`; `linkConfusable` / `confusablesOf` in `src/core/math-concepts.ts` |
| B2 contrast check | `REVIEW_CHECKS` / `ATTEMPT_CHECKS` + `pairWith`; logged on both concepts (`<id>#pair`); `owedContrasts`; `close_session` `contrastSkipped` |
| B3 contrast partners | `consolidationClusters` → `contrastPartners`, `contrasts`; `pick_items` `contrastPartners` |
| B4 backfill | `scripts/link-confusables.ts` (dry run by default, `--apply` backs up `concepts.json`) |
| Tests | `tests/memory-depth.test.ts` (new); additions in `review.test.ts`, `timebox-tools.test.ts`, `math-profile.test.ts` |

Decisions made while building:
- **Retained = Good or Easy as graded** (`cappedFrom ?? rating` ≥ 3), not "credited" (correct_slow or one hint). A held rung should be clean.
- **Only schedule-moving first attempts, follow-ups and close checks count** toward retained depth. Repairs, retries, contrasts and later attempts inside a teach sitting don't: they come right after an explanation.
- **FSRS trains on the rating before the depth cap** (`depthFrom`). The cap is scheduling policy; the memory model should learn what recall showed. Implicit credit and the memory metrics' pass rate use the graded rating too.
- **`firstRung` treats an item as stale only below 0.7 recall.** The candidate `stale` flag is true for every due solid item (recall under the 0.85 target), so using it would have kept every first rung on K. The ladder text in the prompt now defers to `firstRung`.
- **Backfilled pairs start as optional contrasts.** "Required" is derived from `confusedWith` on attempts, and the old attempts don't have it, so the attempt log stays untouched. A pair becomes required the first time a tutor records the confusion.

Effect on the existing record (replay, 2026-11-26): 27 of 54 schedule-moving reviews are now capped by depth, the 5 concepts that had matured no longer do, and 6 of 105 scheduled concepts meet their depth target.
