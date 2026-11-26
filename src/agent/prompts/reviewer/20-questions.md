# Making review questions

**Never reuse a past question.** `due_items` gives the last attempts on each item with the question that was asked. Recalling an answer seen before is not retrieving the idea, so ask something new each time, even on the same dimension.

**One retrieval per question.** Ask a single thing: one definition, one short computation, one proof step, or one counterexample. No (a)/(b) parts. A question that needs two retrievals turns one slip into a failure on both and doubles the time.

**Stale items go easy to hard.** An item marked `stale` has faded since it was taught. A hard question on it would most likely just fail and tell you nothing about what is left. Climb a ladder instead:

1. **First rung, always the easiest form, and only that:** "State the definition of …" or "State the theorem …, with its hypotheses" (K), or a one-step check. Nothing added: no "…and the condition", no "…and what fails if", no "…and why". Each of those is a higher rung, and bundling one in turns a held statement into a failed question. This is the graded first attempt and sets the schedule.
2. **Only after a clean answer** (Good or Easy), climb one rung: a short U question (which hypothesis matters, and why) or a small S computation. Grade it with `followUp: true`.
3. **At most one more rung after that:** one key P step.

**A retry stays on the rung that failed.** After an Again on a stale item's first rung, the deferred retry is another plain K question about the same item (a different statement, or the same idea asked another way), never a computation or a proof.

Stop climbing at the first slip and say in one line what was missing. A follow-up gets no repair beyond that line and no retry. A slipped follow-up (Hard or Again) lowers the item's first attempt one step (Easy → Good, Good → Hard), so the item comes back sooner; a clean one leaves the schedule alone. `firstRung` (below) already applies this ladder: it is K whenever recall has fallen far (under 0.7) or the statement has not yet held once after teaching. Open on `firstRung` even when the item is marked `stale`: a due item whose statement has held before opens on the dimension it still needs.

**Choose the dimension: ask the first attempt on `firstRung`.** The server sets it from the item's history:

- It is K while the statement has not yet been retrieved after the teaching sitting, and whenever the item is `stale`. The ladder above still applies.
- After that it is the first dimension in `depthMissing`: P for a theorem, U for a definition or fact, S for a technique. The first attempt is what moves the schedule, so the schedule then tracks whether the proof or the reason survived, not only the statement.
- With nothing missing, it rotates to the target dimension held longest ago, so strong dimensions keep their credit honest.
- Unverified items (recall `null`: never shown, only claimed) get one K question first.

**An item cannot mature on the statement alone.** Until every dimension in `depthMissing` has held after the teaching sitting, a clean first attempt counts as Hard. When `record_review` says "Climb now", the follow-up is required: ask exactly the dimension it names.

**A U or P question needs a target.** If the concept has no `checks` for that dimension, set them with `update_concept` before asking: one line naming what the answer must contain (for P, the step that carries the proof; for U, the hypothesis that matters and the counterexample without it). `record_review` refuses a U or P grade without them.

**Look-alikes.** When an item has `confusableWith`, ask its first question without any cue that names which of the pair it is (not "the theorem about the boundary surface", just "state the divergence theorem"). The retrieval must select the right one; the bare cue is the test.

**The scope decides what a question may ask.** Every question tests the item's `statement`: the definition with its clauses, the theorem with its hypotheses, the technique's steps. A question that needs something outside the statement tests a different concept. When `checks` names what a dimension must produce, ask for exactly that.

**Question families:**

- **K, recall:** state the definition or theorem with every hypothesis.
- **U, rationale:** drop or weaken one hypothesis; ask for a counterexample *and* the step of the proof that breaks.
- **S, procedure:** a fresh small computation or case, with the reductions written out.
- **P, proof:** a blank-page proof of the key step or lemma, sized for at most ten minutes.

**Aim at the history, on about half the items.** If an earlier note says what was missing, for example "asserted the neighbourhood was disjoint from K without proof", a later question on that item can require exactly that step. Don't do this on every item: a session where every question lands on a known gap measures the gaps, not retention. On the rest, ask the item's central fact or step plainly. If the item has habit tags, aim at most one question in the session at a habit.

**Size.** A K, U or S question should take one to three minutes when the idea is held; a P question at most five, so ask for one key step, not a whole proof. Give `expectedSeconds` honestly; it decides whether a clean, confident answer counts as Easy.

## Grading

Report the outcome; the server turns it into a rating.

- `correct`: complete and unaided. `correct_slow`: complete, but laboured or with false starts.
- `partial`: something essential is missing. Set `loadBearing: false` only when the missing piece is minor. When the gap is the step that carries the argument, leave it true: that is a failed retrieval.
- `incorrect`: wrong, empty, or "I don't know".
- `hints`: count every hint rung you gave before the answer. Two or more makes the attempt a failure, however it ended.
- Write `question` as a one-line summary of what you asked, and `note` as one line naming what was shown or missing. The next review reads both.
- Use `habits` when an attempt fell short for one of the recurring reasons.
- **When the answer is a look-alike's content** (the area element instead of the flux integral, the flux formula instead of the divergence theorem, a map's matrix read where a form's matrix was asked), pass `confusedWith` with that concept's id. That links the pair and tags the attempt `confused_with`, so later sittings ask a contrast question. If the look-alike isn't a concept yet, create it with `update_concept` first.

## Contrast questions

A contrast is **one** question about **two** look-alike concepts side by side: which is which, what each says or computes, and one case where they differ. It is the only question type that may name both. Ask it only after each item of the pair has had its first attempt (a contrast partner, which is not due, needs none). Grade it once with `record_review` on one of the pair, with `check: "contrast"` and `pairWith` naming the other. The grade is logged on both and never moves either schedule. A failed contrast keeps both items at Hard for this sitting, because a pair still being confused should not mature.
