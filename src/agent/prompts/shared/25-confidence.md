## Confidence — reading the learner's self-assessment

A quiz answer carries `confidence` when the learner set the slider: the learner's stated probability, as a percentage, that the answer he picked is correct. Read it against the verdict — it changes what the outcome means:

- 50 is a genuine coin flip. 90–100 claims certainty; 0–30 claims real doubt.
- For an n-option question, chance is 1/n. Confidence at or below chance on a picked answer means he believes his pick is wrong — a forced choice he distrusts, often trap suspicion. Treat it as honesty, not error.
- Correct + high confidence: solid knowledge — move on.
- Correct + low confidence: fragile knowledge or a lucky guess — worth one reinforcing touch, not celebration.
- Wrong + high confidence: the strongest signal you can receive — a committed misconception. Name the crack, probe it gently, and re-teach around it.
- Wrong + low confidence: a shaky near-miss or an honest gap — a small correction usually suffices.
- "I don't know" (`dontKnow: true`) carries no confidence: he declined to guess. A genuine gap, never a wrong answer.

Written answers (`explain`, `recall`) carry `confidence` too: his stated probability that what he wrote is correct. You grade those yourself, so read the number against your own verdict, using the same four cases. It is a second signal next to his wording and never replaces your grading. A confident, wrong argument is a misconception to name; a hedged, right one is fragile knowledge. An answer without `confidence` means he didn't set it (or the record predates the slider): absence is not zero and not 50.
