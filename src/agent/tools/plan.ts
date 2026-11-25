import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { PlanToolResult, PlanTree } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";
import { createTree, PlanTreeError } from "../../core/plan-tree.ts";
import { parseMermaidPlan } from "./mermaid-plan.ts";
import { evidenceFromMessages, nodeStatus } from "../../core/math-evidence.ts";
import { budgetNodeLimit } from "../../core/session-clock.ts";
import { COURSE_MAP_SOFT_LIMIT, droppedEvidencedNodes, type CourseStore } from "../../core/course.ts";
import { ensureCourseForChat, evidencedCourseNodes, saveCourseMap, courseOfChat } from "../../core/course-ops.ts";
import type { EvidenceStore } from "../../core/math-evidence.ts";

/** The binding-id reminder riding plan_init's slim content (owner,
 *  2026-10-09): plan_init is the exact moment the node ids become
 *  load-bearing — every later quiz/explain call must reference one. The
 *  field-drop incidents (tools_fails_2) showed the turn's tail is where
 *  discipline slips; the reminder lands right there. */
const PLAN_NODE_IDS_REMINDER =
	"These are the plan's node ids — the only valid nodeId values for every quiz and explain call from here on. Reference them exactly.";

/** What the plan tools close over (the plan-tree half of the tool context). */
export interface PlanToolContext {
	chatId: string;
	/** The storage port plan tools persist through. */
	chatStore: ChatStore;
	/** Courses (docs/course-plans-plan.md): present = a time-boxed teach
	 *  session's map is its course's map. Absent in bare tests. */
	courseStore?: CourseStore;
	/** The evidence ledger, for which course nodes are memory keys. */
	evidenceStore?: EvidenceStore;
}

/**
 * The plan tool — AUTHOR-ONCE protocol (2026-09-03 design pass): the teacher
 * WRITES the map and never tracks progress. One tool, plan_init, takes the
 * whole dependency map as a mermaid `graph TD` block:
 *
 *   - call it ONCE right after the probe concludes, to present the map (the
 *     LEARNER'S ACCEPTANCE of the presented plan, not this call, ends
 *     planning — docs/archive/probe-teach-split.md §4)
 *   - statuses (current / visited / upcoming) are DERIVED from the quiz
 *     nodeId tags the teacher fires (contracts.ts derivePlanStatuses) — the
 *     teacher never declares them, and there is no "done" bookkeeping
 *   - re-call it any time the map is wrong: the new block replaces the tree
 *     wholesale. Node slugs are permanent — the map tracks nothing between
 *     rewrites
 *   - checks name the node they assess (quiz nodeId, validated against the
 *     live tree at the call boundary) — that tag is the only thing statuses
 *     derive from
 *
 * The former mutation tools (add/update/remove node/edge, set_current,
 * mark_done) are gone by design: restructuring is a rewrite, tracking is
 * derived. SERVER-SIDE with execute: parse → validate → persist. The
 * result is CONTEXT-SLIM (owner, context diet 2026-10-09): the model
 * WROTE the mermaid one message ago, so content never echoes the tree —
 * it carries the validated nodeIds + the binding-nodeId reminder (the
 * exact moment the ids become load-bearing); `details` keeps the full
 * tree for the record and the plan popup (latestTree reads it — the
 * agent-invisible channel, serializer-verified).
 */
const planInitInput = Type.Object({
	mermaid: Type.String({
		minLength: 1,
		description:
			"A mermaid graph block (any direction), e.g.:\ngraph TD\n  primitives[Number primitives] --> operators[Arithmetic operators] --> expressions[Evaluating expressions]\n" +
			"The only strict rule: ids are permanent lowercase slugs (a-z, 0-9, hyphens/underscores) — checks reference them via nodeId. " +
			"Titles are free single-line text; `-->` means 'from = prerequisite' (chains fine); no subgraphs, styles, or classes.",
	}),
});

/** Math mode's soft scope guard (2026-11-18): past this many nodes, or from
 *  the third map of a session on, plan_init still succeeds but says so. The
 *  2026-11 session analysis found math-mode goals receding as maps were
 *  rebuilt finer and finer (one session: four maps, 35 nodes). */
export const MATH_PLAN_NODE_SOFT_LIMIT = 15;
export const MATH_PLAN_REWRITE_SOFT_LIMIT = 2;

/** How many earlier plan_init calls in this record succeeded. */
export function successfulPlanInits(messages: readonly unknown[]): number {
	let count = 0;
	for (const raw of messages as Array<{ role?: unknown; toolName?: unknown; isError?: unknown; details?: unknown }>) {
		if (raw?.role !== "toolResult" || raw.toolName !== "plan_init" || raw.isError === true) continue;
		if ((raw.details as { ok?: unknown } | undefined)?.ok === true) count++;
	}
	return count;
}

/** The math-mode scope warnings for a map about to be saved; empty when none. */
export function mathPlanWarnings(nodeCount: number, earlierMaps: number): string[] {
	const warnings: string[] = [];
	if (nodeCount > MATH_PLAN_NODE_SOFT_LIMIT) {
		warnings.push(`This map has ${nodeCount} nodes. A math-mode session goal should fit in about 6–${MATH_PLAN_NODE_SOFT_LIMIT}: ` +
			"keep the path to the goal and leave the rest for a later session, telling the learner what was deferred.");
	}
	if (earlierMaps >= MATH_PLAN_REWRITE_SOFT_LIMIT) {
		warnings.push(`This is map number ${earlierMaps + 1} for this session. Each rebuild moves the goal further away: ` +
			"prefer inserting the one missing prerequisite on the current path, and ask the learner before widening the goal.");
	}
	return warnings;
}

/** A course map's guard (course-plans-plan.md §4): the map is not cut to the
 *  sitting; it only warns when it grows past one course's worth. */
export function courseMapWarnings(nodeCount: number, earlierMaps: number): string[] {
	const warnings: string[] = [];
	if (nodeCount > COURSE_MAP_SOFT_LIMIT) {
		warnings.push(`This course map has ${nodeCount} nodes. Past about ${COURSE_MAP_SOFT_LIMIT}, ask the learner whether this is two courses.`);
	}
	if (earlierMaps >= MATH_PLAN_REWRITE_SOFT_LIMIT) {
		warnings.push(`This is map number ${earlierMaps + 1} for this sitting. Prefer inserting the one missing prerequisite, and keep every existing node id.`);
	}
	return warnings;
}

/** A time-boxed sitting's scope guard: only NEW nodes count (not ones already solid or assumed here). */
export function budgetPlanWarnings(nodeIds: readonly string[], messages: readonly unknown[], budgetMin: number, math: boolean, earlierMaps: number): string[] {
	const evidence = evidenceFromMessages(messages);
	const fresh = nodeIds.filter((id) => { const s = nodeStatus(id, evidence); return s !== "solid" && s !== "conditional"; });
	const limit = budgetNodeLimit(budgetMin, math);
	const warnings: string[] = [];
	if (fresh.length > limit) {
		warnings.push(`This map has ${fresh.length} new nodes, but a ${budgetMin}-minute sitting fits about ${limit}. ` +
			"Keep the path to this sitting's goals, put the rest on the hand-off's \"later\" list, and tell the learner what was deferred.");
	}
	if (earlierMaps >= MATH_PLAN_REWRITE_SOFT_LIMIT) {
		warnings.push(`This is map number ${earlierMaps + 1} for this sitting. Prefer inserting the one missing prerequisite, and ask the learner before widening the goal.`);
	}
	return warnings;
}

export function planTools(ctx: PlanToolContext, options: { mathMode?: boolean } = {}): Record<string, AgentTool<any>> {
	const chat = ctx.courseStore ? ctx.chatStore.getChat(ctx.chatId) : null;
	const inCourse = !!chat && (!!chat.settings?.courseId || (!!chat.settings?.timeboxMin && (chat.kind ?? "teach") === "teach"));
	const size = inCourse
		? "This session is a sitting of a COURSE: the map is the whole course's map, as many nodes as the learner's material needs (the full syllabus or problem set), one reasoning step per node. Keep every existing node id; the sitting's goals (set_goals) are the slice that fits the time. "
		: "5–15 nodes: a map, not a syllabus — one reasoning step per node, compress. ";
	return {
		plan_init: {
			name: "plan_init",
			label: "plan_init",
			description:
				"Write or REWRITE this session's plan map — the dependency graph the learner follows live in the plan window. " +
				"Call once right after the probe concludes, to present the map; re-call whenever the map is wrong (the new block replaces the old tree). " +
				"A mermaid graph block (any direction): one node per line (`slug[Short Title]` — slugs are permanent lowercase ids: a-z, 0-9, hyphens/underscores), " +
				"`-->` edges meaning 'from must be understood before to' (chains fine). " + size +
				"Every check you fire names the node it assesses via `nodeId`; where the lesson stands derives from those tags.",
			parameters: planInitInput,
			execute: serverExecute("plan_init", planInitInput, async ({ mermaid }) => {
				const { chatId, chatStore } = ctx;
				const record = chatStore.getChat(chatId);
				if (!record) return { ok: false, error: `Chat not found: ${chatId}` };

				const parsed = parseMermaidPlan(mermaid);
				if (!parsed.ok || !parsed.plan) {
					// The parser collects every problem; the teacher fixes and retries.
					// No tree echo — the model needs the problems, not a restatement of
					// the map it is rewriting (owner, context diet 2026-10-09).
					return { ok: false, error: parsed.problems.join("\n") };
				}
				try {
					// createTree validates the structure (duplicate ids, missing
					// edge endpoints, self-loops, cycles → PlanTreeError).
					const next = createTree(parsed.plan.nodes, parsed.plan.edges);
					const budget = record.settings?.timeboxMin;
					// THE MAP IS THE COURSE'S (course-plans-plan.md §4): a time-boxed
					// teach session's map is its course's full map; the budget
					// limits the goals (set_goals), not the map.
					const ports = ctx.courseStore ? { chatStore, courseStore: ctx.courseStore, ...(ctx.evidenceStore ? { evidenceStore: ctx.evidenceStore } : {}) } : null;
					const courseSitting = !!ports && (!!budget && (record.kind ?? "teach") === "teach" || !!record.settings?.courseId);
					const course = ports && courseSitting ? courseOfChat(ports, chatId) ?? ensureCourseForChat(ports, chatId) : null;
					if (ports && course) {
						const dropped = droppedEvidencedNodes(course, next, evidencedCourseNodes(ports, course));
						if (dropped.length) {
							return { ok: false, error: `The course map must keep every node that has evidence (they are memory keys): ${dropped.join(", ")}. Add them back; you may add new nodes and edges.` };
						}
					}
					const warnings = course
						? courseMapWarnings(next.nodes.length, successfulPlanInits(record.messages))
						: budget
							? budgetPlanWarnings(next.nodes.map((n) => n.id), record.messages, budget + (record.settings?.timebox?.extendedMin ?? 0), options.mathMode === true, successfulPlanInits(record.messages))
							: options.mathMode ? mathPlanWarnings(next.nodes.length, successfulPlanInits(record.messages)) : [];
					chatStore.saveTree(chatId, next);
					if (ports && course) saveCourseMap(ports, course, next, chatId);
					// Context diet: content = the validated nodeIds + the reminder (the
				// ids just became binding for every quiz/explain call); details =
					// the full tree for the record/UI — the plan popup's latestTree
					// seam, agent-invisible (the serializer sends content only).
					return {
						text: JSON.stringify({
							ok: true,
							nodeIds: next.nodes.map((n) => n.id),
							reminder: PLAN_NODE_IDS_REMINDER,
							...(warnings.length > 0 ? { scopeWarnings: warnings } : {}),
						}),
						details: { ok: true, tree: next },
					};
				} catch (err) {
					if (err instanceof PlanTreeError) return { ok: false, error: err.message };
					throw err;
				}
			}),
		},
	};
}