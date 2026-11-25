/**
 * Time-boxed sittings, phase 1 (2026-11-20, docs/timeboxed-sessions-plan.md):
 * the teacher's goal and close tools. Goals live on the chat's settings
 * (ChatSettings.timebox); close_session ends the sitting, after which the
 * learner continues in a new session seeded with the hand-off.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore } from "../../core/ports.ts";
import { evidenceFromMessages } from "../../core/math-evidence.ts";
import type { SessionGoal } from "../../core/session-clock.ts";
import type { MathStore } from "../../core/math-concepts.ts";
import type { FsrsWeightsStore } from "../../core/memory/fsrs.ts";
import { COURSE_DIGEST_MAX_CHARS, type CourseStore } from "../../core/course.ts";
import { courseFacts, courseOfChat, ensureCourseForChat, saveDigest, syncSitting, type CoursePorts } from "../../core/course-ops.ts";

export const SET_GOALS_TOOL = "set_goals";
export const CLOSE_SESSION_TOOL = "close_session";
export const RECORD_DIGEST_TOOL = "record_digest";

const recordDigestInput = Type.Object({
	digest: Type.String({ minLength: 40, maxLength: COURSE_DIGEST_MAX_CHARS, description: "Markdown transcription of the course's sources: the syllabus outline, or every problem with its number and full statement, plus what the learner said about the context (exam date, what is weighted). Later sittings get this instead of the attachments." }),
	learnerAgreed: Type.Optional(Type.Boolean({ description: "Required to replace an existing digest: the learner agreed." })),
});

const setGoalsInput = Type.Object({
	goals: Type.Array(Type.Object({
		id: Type.String({ pattern: "^[a-z0-9_-]+$", description: "Lowercase slug." }),
		text: Type.String({ minLength: 3, description: "A checkable goal: \"Prove …\", \"Compute …\", \"State and use …\"." }),
		nodeIds: Type.Array(Type.String(), { description: "plan_init slugs of the nodes that serve this goal." }),
	}), { minItems: 1, maxItems: 3 }),
	learnerAgreed: Type.Optional(Type.Boolean({ description: "Required when goals are already set: the learner agreed to change them." })),
});

const closeInput = Type.Object({
	verdicts: Type.Array(Type.Object({
		goalId: Type.String(),
		status: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")]),
	}), { description: "One per goal set with set_goals; empty when the sitting has no goals (review and consolidation)." }),
	handoff: Type.String({ minLength: 20, description: "Markdown: what holds, what is fragile (name habits), what the next sitting should start with, and the deferred \"later\" items." }),
	closeChecksSkipped: Type.Optional(Type.String({ minLength: 3, description: "Consolidation only: why some items got no blank-page close check (the learner stopped, or time ran out). Name the items." })),
});

const CREDITED = new Set(["correct", "correct_slow"]);

export function timeboxTools(ctx: { chatId: string; chatStore: ChatStore; courseStore?: CourseStore; mathStore?: MathStore; weightsStore?: FsrsWeightsStore }): Record<string, AgentTool<any>> {
	const record = () => ctx.chatStore.getChat(ctx.chatId);
	const ports = () => ctx.courseStore ? { chatStore: ctx.chatStore, courseStore: ctx.courseStore, ...(ctx.mathStore ? { mathStore: ctx.mathStore } : {}), ...(ctx.weightsStore ? { weights: () => ctx.weightsStore!.read() } : {}) } : null;
	return {
		[SET_GOALS_TOOL]: {
			name: SET_GOALS_TOOL,
			label: SET_GOALS_TOOL,
			description: "Set this time-boxed sitting's 1–3 goals, sized to the budget, right after plan_init. They are shown to the learner above the map. Changing goals later needs the learner's agreement (learnerAgreed).",
			parameters: setGoalsInput,
			execute: serverExecute(SET_GOALS_TOOL, setGoalsInput, async ({ goals, learnerAgreed }) => {
				const chat = record();
				if (!chat) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
				const state = chat.settings?.timebox ?? {};
				if (state.closedAt) return { ok: false, error: "This sitting is closed." };
				if (state.goals?.length && !learnerAgreed) return { ok: false, error: "Goals are already set. Change them only after the learner agrees, then pass learnerAgreed: true." };
				const planIds = new Set(chat.tree?.nodes.map((n) => n.id) ?? []);
				const unknown = goals.flatMap((g) => g.nodeIds.filter((id) => !planIds.has(id)));
				if (unknown.length) return { ok: false, error: `Not plan_init slugs: ${unknown.join(", ")}. Call plan_init first, then use its slugs.` };
				const next: SessionGoal[] = goals.map((g) => ({ ...g, status: "open" }));
				ctx.chatStore.saveSettings(ctx.chatId, { ...chat.settings, timebox: { ...state, goals: next } });
				return { text: JSON.stringify({ ok: true, goals: next.map((g) => g.id), ...(state.goals?.length ? { changed: true } : {}) }), details: { ok: true, goals: next } };
			}),
		},
		[CLOSE_SESSION_TOOL]: {
			name: CLOSE_SESSION_TOOL,
			label: CLOSE_SESSION_TOOL,
			description: "End this time-boxed sitting after the close ritual (one blank-page retrieval per goal). Give a verdict per goal and the hand-off. \"met\" needs credited evidence on EVERY node of the goal in this session; a goal with an untaught or uncredited node is partial. A consolidation sitting needs a close check (record_review with check: \"close\") on every item it attempted, unless closeChecksSkipped says why not. Afterwards the session is read-only and the learner continues in a new one seeded with the hand-off.",
			parameters: closeInput,
			execute: serverExecute(CLOSE_SESSION_TOOL, closeInput, async ({ verdicts, handoff, closeChecksSkipped }) => {
				const chat = record();
				if (!chat) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
				const state = chat.settings?.timebox ?? {};
				if (state.closedAt) return { ok: false, error: "This sitting is already closed." };
				const goals = state.goals ?? [];
				const byId = new Map(verdicts.map((v) => [v.goalId, v.status]));
				const missing = goals.filter((g) => !byId.has(g.id)).map((g) => g.id);
				if (missing.length) return { ok: false, error: `Give a verdict for every goal; missing: ${missing.join(", ")}.` };
				const evidence = evidenceFromMessages(chat.messages);
				// Standard-mode sessions record no evidence: the check applies in math mode only.
				if (evidence.length > 0) {
					// MET MEANS EVERY NODE (owner, 2026-11-21): one credited node let a
					// goal with an untaught node and a partial blank-page answer pass.
					const uncredited = (g: SessionGoal) => g.nodeIds.filter((id) => !evidence.some((e) => e.nodeId === id && CREDITED.has(e.outcome) && e.hints <= 1));
					const unbacked = goals.filter((g) => byId.get(g.id) === "met" && (g.nodeIds.length === 0 || uncredited(g).length > 0));
					if (unbacked.length) return { ok: false, error: `"met" needs credited evidence on every node of the goal. Missing: ${unbacked.map((g) => `${g.id} (${uncredited(g).join(", ") || "no nodes"})`).join("; ")}. Mark it partial, or record the evidence first.` };
				}
				if (chat.kind === "review" && chat.settings?.consolidate && ctx.mathStore && !closeChecksSkipped) {
					const here = ctx.mathStore.attempts().filter((a) => a.chatId === ctx.chatId);
					const closed = new Set(here.filter((a) => a.role === "check" && a.check === "close").map((a) => a.conceptId));
					const owed = [...new Set(here.filter((a) => a.role === "attempt").map((a) => a.conceptId))].filter((id) => !closed.has(id));
					if (owed.length) return { ok: false, error: `No blank-page close check yet on: ${owed.join(", ")}. Ask one per item and grade it with record_review check: "close", or pass closeChecksSkipped with the reason.` };
				}
				const closedGoals = goals.map((g) => ({ ...g, status: byId.get(g.id) ?? g.status }));
				const closedAt = new Date().toISOString();
				ctx.chatStore.saveSettings(ctx.chatId, { ...chat.settings, timebox: { ...state, goals: closedGoals, handoff, closedAt } });
				// The course keeps the sitting's verdicts and hand-off (course-plans-plan.md §4).
				const p = ports();
				if (p) { try { syncSitting(p, ctx.chatId); } catch (error) { console.error(`[course] sitting sync failed for ${ctx.chatId}:`, error); } }
				return { text: JSON.stringify({ ok: true, closedAt, goals: closedGoals.map((g) => `${g.id}: ${g.status}`) }), details: { ok: true, goals: closedGoals, handoff, closedAt } };
			}),
		},
		...(ctx.courseStore ? { [RECORD_DIGEST_TOOL]: recordDigestTool(ctx.chatId, ports) } : {}),
	};
}

/** record_digest (course-plans-plan.md §4): the course's sources, transcribed once. */
export function recordDigestTool(chatId: string, ports: () => CoursePorts | null): AgentTool<any> {
	return {
		name: RECORD_DIGEST_TOOL,
		label: RECORD_DIGEST_TOOL,
		description: "Write this course's digest once, after reading its sources and attachments: the syllabus outline, or every problem with its number and statement, plus the learner's context. Later sittings receive the digest instead of the attachments. Replacing an existing digest needs the learner's agreement (learnerAgreed).",
		parameters: recordDigestInput,
		execute: serverExecute(RECORD_DIGEST_TOOL, recordDigestInput, async ({ digest, learnerAgreed }) => {
			const p = ports();
			if (!p) return { ok: false, error: "Courses are not available here." };
			const course = courseOfChat(p, chatId) ?? ensureCourseForChat(p, chatId);
			if (!course) return { ok: false, error: `Chat not found: ${chatId}` };
			if (course.digest && !learnerAgreed) return { ok: false, error: "This course already has a digest. Replace it only after the learner agrees, then pass learnerAgreed: true." };
			saveDigest(p, course, digest.trim());
			return { text: JSON.stringify({ ok: true, courseId: course.id, chars: digest.trim().length }), details: { ok: true, courseId: course.id } };
		}),
	};
}
