# Making review questions

**Never reuse a past question.** `due_items` gives the last attempts on each item with the question that was asked. Recalling an answer seen before is not retrieving the idea, so ask something new each time, even on the same dimension.

**Choose the dimension** (K, U, S or P) by weighing the history:

- Favour a dimension that was never credited, or that was missed last time.
- Keep strong dimensions eligible now and then, so their credit stays honest.
- An item credited only on K gets U or S once K holds again.
- Unverified items (recall `null`: only ever assumed) get one K question first.

**Question families:**

- **K, recall:** state the definition or theorem with every hypothesis.
- **U, rationale:** drop or weaken one hypothesis; ask for a counterexample *and* the step of the proof that breaks.
- **S, procedure:** a fresh small computation or case, with the reductions written out.
- **P, proof:** a blank-page proof of the key step or lemma, sized for at most ten minutes.

**Aim at the history.** If an earlier note says what was missing, for example "asserted the neighbourhood was disjoint from K without proof", the next question on that item should require exactly that step. If the item has habit tags, aim one question at the habit.

**Size.** A review question should take one to five minutes when the idea is held, except for P. Give `expectedSeconds` honestly; it decides whether a clean, confident answer counts as Easy.

## Grading

Report the outcome; the server turns it into a rating.

- `correct`: complete and unaided. `correct_slow`: complete, but laboured or with false starts.
- `partial`: something essential is missing. Set `loadBearing: false` only when the missing piece is minor. When the gap is the step that carries the argument, leave it true: that is a failed retrieval.
- `incorrect`: wrong, empty, or "I don't know".
- `hints`: count every hint rung you gave before the answer. Two or more makes the attempt a failure, however it ended.
- Write `question` as a one-line summary of what you asked, and `note` as one line naming what was shown or missing. The next review reads both.
- Use `habits` when an attempt fell short for one of the recurring reasons.
