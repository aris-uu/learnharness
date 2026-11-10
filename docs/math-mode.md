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

## Evidence

After a written attempt, the tutor calls `record_evidence` for each dimension shown: recall (K), rationale (U), procedure (S) or proof (P). A node is solid with K plus one of U, S or P, each with at most one hint. Credit requires a submitted attempt on that node, and a later `incorrect` reopens it.

The gate blocks a question on a new node until its direct prerequisites are solid, `assumed` from direct probe evidence, or passed by `learner_override` when you explicitly chose to move on. Staying on a node or moving back is never blocked. Evidence is derived from the session record and adds no separate store.

Below 70% credited over the recent attempts, `record_evidence` tells the tutor to step down instead of raising difficulty.

## Going back

Once a plan exists, **Go back** in the top bar lists the current node's prerequisites, nearest first, with their evidence status. Choosing one sets aside any open question and asks the tutor to rebuild from there. You can also just ask in your own words.

## Images

Paste a screenshot or photo into the composer or any answer field. It is saved under the data folder in `pasted-images/` and inserted as a file chip, which the tutor reads as part of your attempt. PNG, JPEG, WebP and GIF are accepted, up to 20 MB. Pasted images remain readable when file access is restricted. The feature works in any session, not only Math mode.

## Maintainer entry points

- Doctrine: [`src/agent/prompts/profiles/math/`](../src/agent/prompts/profiles/math/), where a file replaces the same-named segment or adds a new one.
- Evidence rules: [`src/core/math-evidence.ts`](../src/core/math-evidence.ts).
- Gate and tool: [`src/agent/tools/math.ts`](../src/agent/tools/math.ts).
- Interface: [`components/math-mode.tsx`](../components/math-mode.tsx).

These enforce the structure: written answers, hidden commitments, credit rules and the gate. Whether a tutor actually earns each definition, and how it grades, remains prompt doctrine.
