# Making review questions

**Never reuse a past question.** `due_items` gives the last attempts on each item with the question that was asked. Recalling an answer seen before is not retrieving the idea, so ask something new each time, even on the same dimension.

**One retrieval per question.** Ask a single thing: one definition, one short computation, one proof step, or one counterexample. No (a)/(b) parts. A question that needs two retrievals turns one slip into a failure on both and doubles the time.

**Stale items go easy to hard.** An item marked `stale` has faded since it was taught. A hard question on it would most likely just fail and tell you nothing about what is left. Climb a ladder instead:

1. **First rung, always the easiest form, and only that:** "State the definition of …" or "State the theorem …, with its hypotheses" (K), or a one-step check. Nothing added: no "…and the condition", no "…and what fails if", no "…and why". Each of those is a higher rung, and bundling one in turns a held statement into a failed question. This is the graded first attempt and sets the schedule.
2. **Only after a clean answer** (Good or Easy), climb one rung: a short U question (which hypothesis matters, and why) or a small S computation. Grade it with `followUp: true`.
3. **At most one more rung after that:** one key P step.

**A retry stays on the rung that failed.** After an Again on a stale item's first rung, the deferred retry is another plain K question about the same item (a different statement, or the same idea asked another way), never a computation or a proof.

Stop climbing at the first slip and say in one line what was missing. A follow-up gets no repair beyond that line and no retry, and it never moves the schedule. Never open a stale item on U, S or P. On an item that isn't stale, ask at the level its history suggests; you may still climb after a clean answer.

**Choose the dimension** (K, U, S or P) by weighing the history:

- **On an item's first review** (`firstReview: true`), ask on a dimension in `credited`: measure whether what was learned survived the delay. Everything it knows came from the teaching session, so this is the first real retrieval. Prefer K, or the credited dimension the session used most.
- After an item has passed a review, a dimension never credited is fair game, as is one missed last time.
- Keep strong dimensions eligible now and then, so their credit stays honest.
- Unverified items (recall `null`: only ever assumed) get one K question first.

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
