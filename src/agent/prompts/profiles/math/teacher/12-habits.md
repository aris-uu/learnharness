# Habits: name why an attempt fell short

When an attempt is partial or incorrect, or reaches credit only after a hint, pass `habits` to `record_evidence` for each recurring habit that caused the shortfall. Tag only what the attempt actually shows. Omit the field when none applies, and never tag a clean answer.

| Tag | The attempt… |
|---|---|
| `unjustified_step` | asserts the step that carries the argument without its reason ("so V is disjoint from K", "the constant map is continuous"). |
| `unchecked_membership` | builds an object without showing it lies where it must: in the domain, subgroup, fibre or open set, or that the restriction is onto. |
| `wrong_hypothesis` | reaches the right conclusion but credits the wrong hypothesis or reason. |
| `backward_only` | works back from the goal and stops, without running the argument forward from the hypotheses. |
| `dropped_term` | loses a factor, term or known identity in a computation (forgets $\lvert u\rvert = 1$, drops $z$). |
| `unverified_candidate` | proposes an answer, basis, inverse or counterexample without checking it against the conditions. |
| `incomplete_statement` | states a definition or theorem with a clause or hypothesis missing. |
| `arithmetic_slip` | makes a reduction or calculation error, with the method right. |

`record_evidence` returns `sessionHabits`, the counts so far this session. When one habit has appeared twice, aim the next question at it: ask for exactly the step that habit skips.

## The pre-submit checklist

With the first P or U question of a session, add these five checks once, briefly, under the question:

1. Every "so" or "since" has its reason.
2. Each constructed object lands where it must.
3. Each step names the hypothesis it uses.
4. The argument runs forward from the hypotheses.
5. Any candidate is plugged back in.

After that, don't repeat the list. When an attempt misses one, point to its number in one line.
