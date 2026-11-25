# Global concepts: one math node per idea, one attempt log

**Status:** built 2026-11-25 (decisions: D1 a + explicit scope per concept, D2 concept map as proposed, D3 b `unverified.jsonl`, D4 build, off by default); live data migrated the same day. A full backup of the data folder is at `D:/projects/learning/backups/learnharness-data-2026-11-25-pre-global-nodes` (checksums in `learnharness-data-2026-11-25.sha256` beside it).
**Replaces:** the `${chatId}#${nodeId}` item key, the course `aliases` map, the planned `sameAs` / `continues` linking (retention plan §8), and `assumed` as a writable outcome (including today's `basisSession` rule).
**Also builds:** everything left open in [retention-mode-plan.md](retention-mode-plan.md) and [consolidation-sessions-plan.md](consolidation-sessions-plan.md), except the flashcards bridge and the code profile.
**Backward compatibility:** none. The old data is migrated once and the old formats are deleted from the code.

## 1. What is wrong with the current format

| Problem | Where | Effect |
|---|---|---|
| A math node is a per-chat slug | `PlanNode.id`; items keyed `${chatId}#${nodeId}` (`core/memory/items.ts`) | The same idea taught twice is two items with two curves: `chain-rule`, `char-const`, `wave-factor` and `basis-test` already exist twice. |
| Merging needs indirection | course `aliases` (`core/course.ts`), the planned `sameAs` | Every read resolves keys through a lookup table, and the resolver is a global singleton (`configureItemKeys`). |
| Slugs collide | `transport` means "transport equation" in the wave chat and "transport through a trivialization" in G-bundles | It works only because ids are scoped to a chat. |
| Two logs for one thing | `evidence/evidence.jsonl` (teaching) and `memory/reviews.jsonl` (review) | Seeds come from one, reviews from the other. A probe re-test in a teach session cannot count as a review (retention §7 unbuilt). |
| The chat record holds the truth, the ledger is a copy | `evidenceFromMessages`, `backfillEvidence`, "ledger append failure is logged, not fatal" | The gate reads transcripts, memory reads the ledger, and they can disagree. |
| `assumed` stands in for global knowledge | `record_evidence` outcome | It existed because the tutor could not see that the node was already known. It was then misused for probe answers (40 records). |

## 2. The new format

Everything lives under `data/math/`. The old `evidence/` and `memory/reviews.jsonl` are removed after migration. `memory/fsrs-weights.json` moves to `math/fsrs-weights.json`.

### 2.1 `math/concepts.json`: the concept graph (mutable, written whole, atomic)

```ts
interface ConceptGraph {
  format: 1;
  concepts: Record<string, Concept>;   // key = Concept.id
  edges: ConceptEdge[];                // prerequisite edges, global
}
interface Concept {
  id: string;            // global, descriptive slug: "upwind-cfl", "compact-to-hausdorff". Mermaid-safe. Unique.
  title: string;
  summary?: string;      // 1–2 sentences: what it covers
  // SCOPE (D1, owner 2026-11-25): one concept is ONE testable unit, so a review can test it reliably.
  kind: "definition" | "theorem" | "technique" | "example" | "fact";
  statement: string;     // the exact content tested: a definition with every clause, a theorem with every hypothesis,
                         // a technique as its steps and when it applies. Fresh questions are generated from this.
  checks?: Partial<Record<"K" | "U" | "S" | "P", string>>;  // per dimension, what a question must make the learner produce
  scopeDraft?: true;     // statement drafted by the migration from the old summary; the tutor confirms it on next touch
  createdAt: string;
  createdIn: string;     // chatId of the first plan that named it
  status: "active" | "retired";
  confusableWith?: string[];   // concept ids it is easy to mix up with (interference grouping, consolidation §4)
}
interface ConceptEdge { from: string; to: string; addedIn: string /* chatId */; }
```

- **The concept id is the plan node id** in math mode. A math-mode `PlanNode.id` *is* a concept id, so the tree, tagged questions, evidence, memory and courses all use one key with no lookup.
- **Edges are global.** A plan's `edges` stay on the chat tree (they are that plan's path), and each one is also unioned into `edges`. Clusters and the gate read the global graph.
- **Merging is a rewrite, not a label.** `merge(a → b)` rewrites every reference to `a` (attempt log, chat trees, tool-call arguments, course maps, edges), deletes `a`, and appends one line to `math/merges.jsonl` for audit. No alias survives.

### 2.2 `math/attempts.jsonl`: the one append-only log

Every graded learner attempt on a concept, from any session kind.

```ts
interface Attempt {
  id: string;            // the tool-call id (record_evidence / record_review)
  conceptId: string;
  chatId: string;        // the sitting
  at: string;            // ISO
  source: "teach" | "probe" | "review" | "consolidate";
  role: "attempt" | "retry" | "followup" | "check";   // check = repair/close (record_review check)
  dimension: "K" | "U" | "S" | "P";
  outcome: "correct" | "correct_slow" | "partial" | "incorrect" | "learner_override";
  hints: number;
  note: string;
  question?: string;     // what was asked (reviews; and probe answers via probeAnswer)
  questionCallId?: string; // the explain/recall call the attempt grades
  loadBearing?: boolean; confidence?: number; elapsedSeconds?: number; expectedSeconds?: number;
  habits?: MathHabit[]; minutesIn?: number; noRetry?: boolean;
  check?: "repair" | "close";
  predicted?: number;    // recall predicted at the time (schedule-moving attempts)
  implicit?: true;       // §4 R7: marks a derived implicit event; never written by the tutor (as built, implicit credit is derived at replay, not stored)
}
```

- **No stored ratings, no seeds.** The rating is derived from the outcome by `ratingFor` (§5 table) on every replay. Changing the mapping, the encoding window or the follow-up cap re-schedules history consistently.
- **One schedule rule for every session kind** replaces seeds plus reviews:
  1. A concept with no schedule yet: the attempts of its first sitting **seed** it, exactly as `seedFor` does today (solid & past the encoding window → Good, solid otherwise → Hard, in progress → Again).
  2. A concept that has a schedule: in every later sitting, **the first `attempt` on it moves the schedule**. That holds for teach, probe, review and consolidation alike. Later attempts in that sitting are logged only (the follow-up cap still applies).
  This is retention §7 for free: a probe answer on a stale concept in a teach session is that concept's review.
- **`assumed` is gone.** An earlier session's evidence counts directly, because the concept is the same. The gate reads it (§3). The old 40 `assumed` records are not attempts, so they don't go into this log (decision D3).

### 2.3 Chats and courses

- **Chat records:** math-mode tree nodes use concept ids. The migration rewrites `tree`, every tool call's `nodeId` (explain, recall, quiz, record_evidence), `plan_init` arguments (nodes, edges, and the mermaid text) and the course `mapHistory`. Standard-mode chats keep local slugs, and nothing about them changes.
- **Courses:** `format: 2`. `map` uses concept ids, and `aliases` is deleted. `courseItemKeys`, `ItemKeyResolver`, `configureItemKeys` and `IDENTITY_ITEM_KEYS` are deleted.

## 3. How the code changes

| Area | Change |
|---|---|
| `core/math-concepts.ts` (new) | Types, validation, `ensureConcepts(plan)`, `mergeConcepts`, `similarConcepts(title)` (token overlap on title and summary). |
| `store/math-concepts.ts`, `store/attempts.ts` (new) | fs adapters with atomic writes and the same corruption handling as `store/evidence.ts`. These replace `store/evidence.ts` and `store/memory.ts`. |
| `core/math-evidence.ts` | Statuses read `Attempt[]` per concept. `evidenceFromMessages`, `backfillEvidence` and the ledger copy are removed. **A failed append is now a tool error**, because the log is the truth. |
| `core/memory/items.ts` | An item is a concept. Replay implements the §2.2 rule. `stage()` gains `relearning`. The item-key resolver is removed. |
| `core/memory/review.ts` | `reviewCandidates` keys by concept. New `consolidationClusters`. |
| `agent/tools/plan.ts` (`plan_init`, math mode) | Node ids are concept ids. Existing ids are reused, and the result echoes "reused: X (title)" so an accidental collision is visible. New ids get `similarConcepts` warnings ("same idea as `upwind-cfl`? reuse its id"). Generic ids (`definition`, `held`, `retest`, under 2 words) are refused. |
| `agent/tools/math.ts` | Remove the `assumed` outcome and `basisSession`; keep the probe-id listing. The gate's "established" = solid in this sitting **or** solid on the global record with recall ≥ retention. A stale prerequisite blocks until one short retrieval, which is a review by §2.2. `search_evidence` searches concepts and returns the concept id to reuse. |
| `agent/tools/review.ts` | `itemId` = concept id. `pick_items` takes clusters in consolidation. |
| `core/course*.ts`, `server/courses.ts` | Drop aliases and adoption key-mapping; the course map holds concept ids. |
| `server/chat-handler.ts`, `server/stores.ts` | Wire the new stores; remove the backfill at boot. |
| Prompts | Math teacher, prober, reviewer and consolidation: reuse concept ids, no `assumed`, stale prerequisites get one retrieval. |
| `skills/learnharness` readers and `references/data-format.md`; `tools/lh-analysis` | Read the new files. |

## 4. The remaining plan items, on the new format

### Retention mode
| # | Item | How |
|---|---|---|
| R1 | Plan-tree tinting | Each math node is tinted by its concept's recall now (from `/api/memory`). A stale node gets a marker. |
| R2 | "Open a teach session from this item" | A button on a review item, on a Memory row and on the reviewer's suggestion. It opens a prefilled draft (the existing "continue" pattern) whose plan starts at that concept. |
| R3 | Probe re-tests count as reviews | Falls out of §2.2. The prober doctrine says to tag recall questions on stale concepts with their concept id. |
| R4 | Memory view controls | Retire/unretire and **Merge into…**, which runs the §2.1 rewrite. There's no `sameAs`. |
| R5 | Due badge on new session | Badge on the new-session button and a "Review (N) · Consolidate (M)" entry in the session picker. |
| R6 | `sameAs` / `continues` | **Dropped**: concepts are global. |
| R7 | Implicit credit along prerequisites | When a clean (Good) U/S/P attempt on X moves its schedule, each *direct* prerequisite that is due within 3 days and wasn't attempted in that sitting gets an `implicit` event, derived at replay (as built: nothing is written to the log). It's rated Hard, so it's a weak push. **Setting, default off.** Because replay is derived, turning it off removes its effect retroactively, and `implicit` attempts are excluded from FSRS training. |

### Consolidation mode
| # | Item | How |
|---|---|---|
| C1 | Clusters and interference grouping | `consolidationClusters`: seed = most overdue learning/relearning concept. Add its due prerequisites (global edges), its `confusableWith`, and concepts from its course or source chat that failed recently. Fill to `floor(budget/6)`. `due_items` returns clusters and `pick_items` accepts them. The tutor can set `confusableWith` via a small `mark_confusable` tool. |
| C2 | Lapse → relearning | `stage = relearning` when the concept was once mature and its latest schedule-moving rating is Again, until it re-matures. Review excludes it, consolidation takes it, and the Memory page shows it. |
| C3 | Mature prerequisite as a warm-up | A mature prerequisite in a cluster is asked as `role: "followup"`, so its schedule doesn't move (decision 3 of that plan). |
| C4 | Sidebar door split | **Consolidate (N)** and **Review (M)** entries replace the single badge. |
| C5 | Stage column | Memory page column: learning / mature / relearning / unverified. |
| C6 | Reviewer prompt | Drop the "never consolidated → noRetry" branch. Review only ever sees mature items. `noRetry` stays only for "skip it". |
| C7 | lh-analysis metrics | Pass rate by stage, time to maturity, lapse rate of mature concepts. |

## 5. Migration

A script, `scripts/migrate-global-concepts.ts`, with **dry-run by default**. It reads the old data folder and writes a complete new one beside it (`data.migrated/`). It never edits in place. **The app must be closed.**

1. **Inventory:** every (chatId, slug) from math-chat trees, `mapHistory`, evidence and reviews (138 pairs with evidence over 18 chats; more plan nodes have no evidence).
2. **Concept map:** `scripts/migration/concept-map.json`, which I draft and **you approve**: `{ "<chatId>#<slug>": "<concept id>" }`, plus a title per concept. Pairs mapped to the same id are merged. Draft of the non-trivial rows:

   | Pairs | Proposed | Why |
   |---|---|---|
   | `chain-rule` (transport pde) + `chain-rule` (boundary sitting) | merge → `chain-rule-along-curve` | same idea, two sittings |
   | `char-const` (transport pde) + `char-const` (sitting 3) + `char-lines` (boundary) | merge → `characteristics-constant-speed` | the same characteristic-line idea |
   | `wave-factor` (wave pde) + `wave-factor` (boundary) | merge → `wave-operator-factorization` | same |
   | `basis-test` (special groups) + `basis-test` (bilinear) | merge → `basis-vector-test` | same |
   | `products` (G-bundles) + `product-maps` (topology) | merge → `maps-into-products` | same |
   | `master-equation` (special groups) + `preserve-criterion` (bilinear) | merge? → `form-preserver-equation` | both are "AᵀMA = M"; check |
   | `symmetry-principle` + `group-closure` | merge? → `preservers-form-group` | check |
   | `equivariance` (G-bundles) + `equivariant-def` (topology) | merge? | close; check |
   | `subspace-open` (G-bundles) + `homeo` (closed surfaces) | keep apart? | overlapping, not equal |
   | `transport` (wave pde) vs `transport` (G-bundles) | **split**: `transport-equation-solution`, `bundle-transport` | collision |
   | `definition`, `held`, `retest`, `foundations`, `slices`, … | rename to descriptive ids | generic slugs |
3. **Rewrite:** write `concepts.json` and `attempts.jsonl` (evidence → `source: teach|probe`, with probe-backed ones marked by `questionCallId` where the note or the call shows it; reviews → `source: review|consolidate`, `role` from `kind`). Rewrite math chat records and courses.
4. **Verify**, printing a report:
   - every old record maps, with none dropped;
   - for every **unmerged** item, the FSRS state is the same before and after (any difference is a bug);
   - for merged items, before vs after recall and due date side by side, for you to sanity-check;
   - all math chats still load; derived plan statuses are the same; the gate passes the same.
5. **Swap:** rename `data/` → `data.pre-migration/` and `data.migrated/` → `data/`. The off-site backup above stays untouched.

## 6. Potential problems

| Risk | Mitigation |
|---|---|
| Rewriting transcripts (tool-call arguments, mermaid text) could break continuing an old chat. Thinking blocks carry signatures. | Only tool-call `arguments` and the tree change, never thinking or text. The mermaid rewrite is token-bounded on node ids and checked by re-parsing. Test: continue a migrated chat once on each provider. |
| The tutor reuses an id by accident ("transport") or duplicates one under a new name | Reuse is echoed back with the stored title; new ids get similarity warnings; generic ids are refused; Merge in the Memory view fixes the rest. |
| Merged items change schedule | Expected: two histories become one, and a later sitting's first attempt becomes a review. Shown in the verify report before the swap. |
| A failed append is now a hard tool error | Correct, because the log is the truth; the tutor retries. |
| Courses lose `aliases` | Course maps are rewritten by the same concept map. |
| Fork diverges further from upstream | Accepted (the fork is already 133 commits ahead). The change is contained in math mode. |
| Large test rewrite | Fixtures keyed `chatId#node` (memory, evidence-ledger, course, review tests) are rewritten. Run focused suites, then `compare.sh` after saving a new baseline (the current one predates the rebase). |
| `question-layout-dock.test.tsx` hangs the full suite | Unrelated and pre-existing. Exclude it from the baseline run, and fix it separately. |

## 7. Decisions (answered 2026-11-25)

- **D1 → (a)**, every math-plan node becomes a concept, **and each concept carries its scope**: `kind`, `statement` and optional `checks` (§2.1). The scope rule is **one concept = one testable unit**: one definition, one theorem (with its proof idea as U/P), one technique, one worked example family, or one fact. A node that needs two different statements is two concepts. `plan_init` requires `kind` and `statement` for new concepts. Migrated concepts get the old summary as a draft statement (`scopeDraft`), and the tutor must confirm or sharpen it (`set_concept_scope`) before it can quiz on that concept. The reviewer generates every question from `statement` and `checks`.
- **D2 → approved** as drafted.
- **D3 → (b)** `math/unverified.jsonl`.
- **D4 → build it**, off by default.

### Original questions

- **D1 Which plan nodes become concepts:** (a) every node of every math-chat plan (recommended: maps reuse them, and an untested concept has no memory item), or (b) only nodes with evidence.
- **D2 The concept map:** approve or edit the draft in §5.2 before the migration runs.
- **D3 The 40 old `assumed` records:** (a) drop them, (b) keep them in an `unverified.jsonl` side file as notes that never schedule anything (recommended: honest and not lost), or (c) keep them in the log as a read-only legacy outcome.
- **D4 Implicit credit (R7):** build it off by default (recommended), or skip it.

## 8. Order of work

1. Format, stores and the migration script with dry-run and the verify report. You approve the concept map, then run.
2. Core and tools on the new format: replay rule, gate, `plan_init` reuse, tests.
3. Swap the data, and continue one old chat to check.
4. Retention R1–R5, R7; consolidation C1–C7.
5. Readers and docs: the learnharness skill, `data-format.md`, lh-analysis, and the hub `CLAUDE.md`.
