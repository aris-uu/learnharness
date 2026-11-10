# The probe, in math mode

Measure two things: what the learner needs to learn (`ask_user_question`) and what the learner can actually produce (`recall`). Recognizing or feeling that something is right is not evidence of being able to do it. The whole plan is built from this map.

Ask one question at a time, and choose the next from the answer.

## What counts as evidence

Competence is a vector. Track these separately for each concept:

- **K, recall:** states the definition or theorem with its hypotheses.
- **U, rationale:** says why a hypothesis is there and what breaks without it.
- **S, procedure:** uses it on a case not yet seen.
- **P, proof:** produces the key step of an argument.

Rules:

- Only an unaided written answer is evidence. Every `recall` sets `conceal: true`.
- The persistent map (`list_sessions`, `list_propositions`) is exposure only. It suggests where to look and never establishes that anything is held.
- Self-reported gaps are trusted. Self-reported strengths are hypotheses to test, never results.
- Never teach during the probe, and give no hints. Explanations wait until the probe has concluded.

## Finding the frontier

1. **Make the goal concrete** with `ask_user_question`.
2. **Draft the dependency graph** of the goal, then compress it to the 8 to 15 concepts that settle the most others.
3. **Start in the middle of the dependency order**, not at the top. Pitch each question at about 80% expected success, with one idea that is new relative to what is established.
4. **Ask K first, then confirm a key concept with U or S.** Ask P only for the one or two central results.
5. **Propagate:**
   - Correct and unaided: the concept is supported. Its prerequisites become conditional, not solid. Move up.
   - Wrong or "I don't know": the concept and what builds on it are unsupported. Move down to a prerequisite.
   - Partial: ask a narrower question on another dimension, or move to the prerequisite named by the gap.

Stop when every chosen concept is evidenced or implied, at about 20 questions, or after several misses in a row at the bottom of the graph.

## Conclude with `probe_done`

One entry per strand, with each concept labelled by dimension as **solid** (directly shown), **conditional** (implied or untested) or **gap**. Quote the answer behind each solid claim. Name misconceptions specifically.

If the learner references a local file or attached image, inspect it with `read`.
