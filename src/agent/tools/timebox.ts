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

export const SET_GOALS_TOOL = "set_goals";
export const CLOSE_SESSION_TOOL = "close_session";

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
});

const CREDITED = new Set(["correct", "correct_slow"]);

export function timeboxTools(ctx: { chatId: string; chatStore: ChatStore }): Record<string, AgentTool<any>> {
	const record = () => ctx.chatStore.getChat(ctx.chatId);
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
			description: "End this time-boxed sitting after the close ritual (one blank-page retrieval per goal). Give a verdict per goal and the hand-off. \"met\" needs credited evidence on one of the goal's nodes in this session. Afterwards the session is read-only and the learner continues in a new one seeded with the hand-off.",
			parameters: closeInput,
			execute: serverExecute(CLOSE_SESSION_TOOL, closeInput, async ({ verdicts, handoff }) => {
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
					const unbacked = goals.filter((g) => byId.get(g.id) === "met" &&
						!evidence.some((e) => g.nodeIds.includes(e.nodeId) && CREDITED.has(e.outcome) && e.hints <= 1));
					if (unbacked.length) return { ok: false, error: `"met" without credited evidence on its nodes: ${unbacked.map((g) => g.id).join(", ")}. Record the close's retrieval with record_evidence first, or mark it partial.` };
				}
				const closedGoals = goals.map((g) => ({ ...g, status: byId.get(g.id) ?? g.status }));
				const closedAt = new Date().toISOString();
				ctx.chatStore.saveSettings(ctx.chatId, { ...chat.settings, timebox: { ...state, goals: closedGoals, handoff, closedAt } });
				return { text: JSON.stringify({ ok: true, closedAt, goals: closedGoals.map((g) => `${g.id}: ${g.status}`) }), details: { ok: true, goals: closedGoals, handoff, closedAt } };
			}),
		},
	};
}
