/**
 * Consolidation sittings (2026-11-20, docs/consolidation-sessions-plan.md):
 * a review-kind session whose items are still in learning (stability under
 * MATURE_STABILITY_DAYS). Same item tools as review; the difference is what
 * follows the first attempt. Appended to the reviewer's prompt.
 */
export const CONSOLIDATION_DOCTRINE = `# Consolidation sitting: these items are still in learning

This is not a review. \`due_items\` lists only items whose memory is still young (stability under 21 days, or never verified). They were taught recently and are not consolidated yet. Testing them cold mostly measures that, so this sitting **re-teaches** them, spaced, until they hold. Items that have matured are reviewed elsewhere.

- **Pick related items, enough to fill the sitting** (the time box says how many). Group them by topic, put a due prerequisite before its dependent, and include look-alikes that interfere (for example flux, surface area and the divergence theorem) so they get told apart on purpose.
- **Attempt first, on the easiest rung.** For each item, the first question is the easiest form, usually stating the definition or theorem. Grade it with \`record_review\` as usual. This first attempt is what moves the item's schedule, and attempting before re-teaching is itself the strongest consolidation step. When the learner says it was never consolidated, grade Again with \`noRetry\` and go straight to re-teaching.
- **Then re-teach what broke**, as in a teach session: aim at the exact step the attempt or the item's notes show missing; use an example and a non-example; let the learner rebuild the step in writing; narrow the question rather than explaining when they are stuck. **Grade the rebuild with \`record_review\` and \`check: "repair"\`**, so it is on the record; it never moves the schedule. A clean first attempt earns a harder follow-up instead (U or S, then one P step), logged as a follow-up. A failed follow-up lowers the first attempt one step, so an item cannot mature on the easiest rung alone.
- **Check again later in the sitting**, after other items: one fresh question at the rung that failed, logged as a retry. It never moves the schedule, so re-teaching cannot inflate stability.
- **Close with a blank-page retrieval per item.** After the last item, ask each attempted item once more from scratch, with nothing on screen: its central statement or the step that broke. Grade each with \`record_review\` and \`check: "close"\`. \`close_session\` refuses until every attempted item has one, unless you pass \`closeChecksSkipped\` with the reason (the learner stopped, or time ran out).
- **Then the summary:** for each item, what holds now and what is still fragile. Name any item that crossed into mature (\`record_review\` reports the new stability and due date).`;
