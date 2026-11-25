/**
 * Consolidation sittings (2026-11-20, docs/consolidation-sessions-plan.md):
 * a review-kind session whose items are still in learning (stability under
 * MATURE_STABILITY_DAYS). Same item tools as review; the difference is what
 * follows the first attempt. Appended to the reviewer's prompt.
 */
export const CONSOLIDATION_DOCTRINE = `# Consolidation sitting: these items are still in learning

This is not a review. \`due_items\` lists only items whose memory is still young (stability under 21 days, or never verified) or **relearning** (once mature, then lapsed). They are not consolidated yet. Testing them cold mostly measures that, so this sitting **re-teaches** them, spaced, until they hold. Items that have matured are reviewed elsewhere.

- **Pick one cluster from \`due_items\`'s \`clusters\`** (or two small ones), enough to fill the sitting. A cluster is a seed item plus its due prerequisites, its look-alikes (\`confusableWith\`) and items from the same sitting that failed recently, in order, so related ideas are studied together and look-alikes get told apart on purpose. Pass its \`itemIds\` in order and its \`warmUps\` (mature prerequisites) as \`warmUps\`: ask each warm-up first, one short question; it is logged and never moves its schedule. When two items are easy to mix up, record it with \`update_concept\` (\`confusableWith\`) so later clusters group them.
- **Attempt first, on the easiest rung.** For each item, the first question is the easiest form, usually stating the definition or theorem. Grade it with \`record_review\` as usual. This first attempt is what moves the item's schedule, and attempting before re-teaching is itself the strongest consolidation step. Ask it from the item's \`statement\`; confirm a \`scopeDraft\` statement with \`update_concept\` first.
- **Then re-teach what broke**, as in a teach session: aim at the exact step the attempt or the item's notes show missing; use an example and a non-example; let the learner rebuild the step in writing; narrow the question rather than explaining when they are stuck. **Grade the rebuild with \`record_review\` and \`check: "repair"\`**, so it is on the record; it never moves the schedule. A clean first attempt earns a harder follow-up instead (U or S, then one P step), logged as a follow-up. A failed follow-up lowers the first attempt one step, so an item cannot mature on the easiest rung alone.
- **Check again later in the sitting**, after other items: one fresh question at the rung that failed, logged as a retry. It never moves the schedule, so re-teaching cannot inflate stability.
- **Close with a blank-page retrieval per item.** After the last item, ask each attempted item once more from scratch, with nothing on screen: its central statement or the step that broke. Grade each with \`record_review\` and \`check: "close"\`. \`close_session\` refuses until every attempted item has one, unless you pass \`closeChecksSkipped\` with the reason (the learner stopped, or time ran out).
- **Then the summary:** for each item, what holds now and what is still fragile. Name any item that crossed into mature (\`record_review\` reports the new stability and due date).`;
