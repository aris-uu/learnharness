# Math mode

Math mode is a per-session teaching profile for hard mathematics. It replaces recognition-based checks with written work, and tracks mastery by evidence. It is off by default and does not affect practice sessions.

## Turning it on

- **New session:** the **Math mode** pill above the composer. The choice is remembered for the next draft.
- **Existing session:** the **Math mode** pill in the top bar. It takes effect on the next turn.

## What changes

| Area | Standard | Math mode |
| --- | --- | --- |
| Questions | Your Quizzing setting | Always written; the committed answer stays hidden so an attempt can continue |
| Definitions | May be stated as starting points | Earned through examples, non-examples and your own attempt |
| Probe | Enters near the top | Starts mid-chain at about 80% expected success; self-reports and the graph are not evidence |
| Moving on | Follows the tutor's tags | A soft mastery gate checks direct prerequisites |
| Plan size | Any | `plan_init` warns, without blocking, past 15 nodes or from the third map of a session |

## Evidence

After a written attempt, the tutor calls `record_evidence` for each dimension shown: recall (K), rationale (U), procedure (S) or proof (P). A node is solid with K plus one of U, S or P, each with at most one hint. Credit requires a submitted attempt on that node, and a later `incorrect` reopens it.

The gate blocks a question on a new node until its direct prerequisites are solid (in this session, or on the global record and still fresh), credited from a same-session probe answer, or passed by `learner_override` when you explicitly chose to move on. Staying on a node or moving back is never blocked. There is no `assumed` outcome: a claim nobody tested is stored as an *unverified* note, never as credit.

Plan nodes in math mode are **global concepts**: one id per idea, shared by every session (`data/math/concepts.json`). Each concept carries its scope (kind: definition, theorem, technique, …; the statement it covers; and what a test of it checks), so a review can test exactly that. Every graded `record_evidence` call appends an attempt to `data/math/attempts.jsonl`; untested claims go to `data/math/unverified.jsonl`. Deleting a session removes its attempts. A prerequisite the probe tested in the same session is credited from that probe answer (`record_evidence` with `probeAnswer`). In math mode the prober and the tutor can call `search_evidence`, a keyword search over the concepts with their mastery and memory; they reuse a hit's id as the plan node id so its record carries over, and confirm a migrated draft scope with `update_concept`. Merging two concepts (Memory view, or grouping sessions into a course) rewrites every reference; there are no aliases. Layout: [global-concepts-plan.md](global-concepts-plan.md).

Below 70% credited over the recent attempts, `record_evidence` tells the tutor to step down instead of raising difficulty.

### Confidence on written answers

Written answers (`explain`, `recall`) have the same confidence slider as quiz answers, in every session: your probability that what you wrote is correct. It is never sent with "I don't know". The tutor reads it against its own grade, so a confident wrong argument shows up as a misconception and a hesitant right one as fragile knowledge. The slider starts unset: no confidence is sent until you move it, so an answer without one and a deliberate 50% stay distinguishable. Older written answers have no confidence. In written answers the slider is set with the mouse, because ←/→ move the caret in the answer field.

### Habit tags

When an attempt falls short, `record_evidence` can carry `habits`: tags for the recurring reason, chosen from `unjustified_step`, `unchecked_membership`, `wrong_hypothesis`, `backward_only`, `dropped_term`, `unverified_candidate`, `incomplete_statement` and `arithmetic_slip`. The tags are stored in the session and the global ledger, and returned by `search_evidence`. `record_evidence` reports the session's counts so far, so the tutor can aim a question at a habit once it has appeared twice. With the first P or U question of a session, the tutor also shows a five-point pre-submit checklist. Doctrine: [`profiles/math/teacher/12-habits.md`](../src/agent/prompts/profiles/math/teacher/12-habits.md).

### "I don't know"

Before teaching after an "I don't know", the tutor asks once what you would try first and where it stops, so its hint can land on the exact step. It skips this when you say you have no starting point.

### Memory: forgetting curves

Every concept with math-mode attempts gets a forgetting curve (FSRS-7 via ts-fsrs, weights refit from your history once there is enough of it, 85% target recall). It is derived from the attempt log each time it is read, so nothing extra is stored. The concept's first teaching sitting seeds it: Good when solid and credited beyond the teaching window, Hard when solid only inside it or reached with hints, Again when still in progress. In every later sitting, of any kind, the first graded attempt is a review that moves the schedule. A concept with only unverified notes is *unverified* and has no schedule. Items are *learning* until their 90%-recall interval reaches 21 days, then *mature*; a failed mature item is *relearning*. `search_evidence` reports each result's `memory`: recall now, when it is due, its stage, and `stale` when it was solid but has probably been forgotten. **Memory** in the sidebar lists the concepts most forgotten first, with stage, a sparkline, and actions (teach again, retire, merge into another concept). Implicit credit for prerequisites (a clean U review of a dependent gives an almost-due prerequisite a Hard) is off by default and toggled there.

### Review sessions

**Review** in the sidebar, or **Start review** on the Memory page, opens a new review screen, like **Teaching** and **Practice**. Name topics to review them, or send it empty to review what's due. You can start as many review sessions a day as you like; they are titled `Review YYYY-MM-DD`, numbered from the second one. The reviewer lists the due items (`due_items`), picks about six (`pick_items`), which become the session's map, and asks one fresh written question per item, never one asked before. It grades each with `record_review`, and the server turns the grade into an FSRS rating:

| Grade | Rating |
|---|---|
| incorrect, 2+ hints, or a partial missing the load-bearing step | Again |
| a minor partial, slow, or 1 hint | Hard |
| correct, unaided | Good |
| correct, unaided, ≥ 90% confident and within the expected time | Easy |

Stale items (faded since they were taught, or under 0.7 recall) go easy to hard: the graded first question is the easiest form, usually stating the definition or theorem, and only a clean answer earns a harder follow-up (U or S, then one P step, at most two). Follow-ups are logged as `followup` and never move the schedule; the ladder stops at the first slip. Each question asks one thing and should take one to three minutes (five for a proof step). An item's first review asks on a dimension it was already credited on; untested dimensions wait until it has passed a review. Only the first attempt on an item in a session moves its schedule. After an Again the reviewer gives one short repair at once, but defers the retry until two other items have had their first attempt, so it measures retrieval rather than the repair. When nothing is left to interleave (an Again on the last item, with no other retry owed), there is no retry: the item comes back in the next review. A retry is on a different question at the same rung as the one that failed, and is logged but not scheduled. An item the learner says was never consolidated is graded Again with `noRetry` and goes to a teach session instead; the item comes back no sooner than a day later. Reviews are attempts in the same log (`source: review` or `consolidate`), so every curve is replayed from `data/math/attempts.jsonl` alone. **Review** takes mature items only; young and relearning items go to **Consolidate**, which studies a due cluster (a concept with its due prerequisites, dependents and easily confused neighbours, mature prerequisites as warm-ups) and ends each item with a close check. Review sessions extract nothing into the graph. Design and later phases: [retention-mode-plan.md](retention-mode-plan.md).

## Going back

Once a plan exists, **Go back** in the top bar lists the current node's prerequisites, nearest first, with their evidence status. Choosing one sets aside any open question and asks the tutor to rebuild from there. You can also just ask in your own words.

## Images

Paste a screenshot or photo into the composer or any answer field. It is saved under the data folder in `pasted-images/` and inserted as a file chip, which the tutor reads as part of your attempt. PNG, JPEG, WebP and GIF are accepted, up to 20 MB. Pasted images remain readable when file access is restricted. The feature works in any session, not only Math mode.

## Maintainer entry points

- Doctrine: [`src/agent/prompts/profiles/math/`](../src/agent/prompts/profiles/math/), where a file replaces the same-named segment or adds a new one.
- Evidence rules: [`src/core/math-evidence.ts`](../src/core/math-evidence.ts).
- Gate and tools: [`src/agent/tools/math.ts`](../src/agent/tools/math.ts).
- Concepts and attempt log: [`src/core/math-concepts.ts`](../src/core/math-concepts.ts), store in [`src/store/math.ts`](../src/store/math.ts), migration from the old per-session ledger in [`scripts/migrate-global-concepts.ts`](../scripts/migrate-global-concepts.ts).
- Interface: [`components/math-mode.tsx`](../components/math-mode.tsx).

These enforce the structure: written answers, hidden commitments, credit rules and the gate. Whether a tutor actually earns each definition, and how it grades, remains prompt doctrine.
