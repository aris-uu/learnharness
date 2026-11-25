import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { derivePlanStatusesLh } from "../../core/contracts/plan.ts";
import {
	answeredWrittenQuestions,
	attemptedNodes,
	blockingPrerequisites,
	evidenceFromMessages,
	evidenceRecord,
	habitsOf,
	MATH_DIMENSIONS,
	MATH_HABITS,
	MATH_OUTCOMES,
	MATH_STATUS_LABELS,
	mathPitch,
	nodeStatus,
	RECORD_EVIDENCE_TOOL,
	SEARCH_EVIDENCE_TOOL,
	searchEvidence,
	type EvidenceStore,
	type MathEvidence,
} from "../../core/math-evidence.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { DEFAULT_DESIRED_RETENTION, itemKeys, memorySnapshot } from "../../core/memory/items.ts";
import type { ReviewStore } from "../../core/memory/review.ts";
import type { FsrsWeightsStore } from "../../core/memory/fsrs.ts";
import { invalidInputResult } from "../tool-execute.ts";
import { minutesIntoSitting } from "../../core/session-clock.ts";
import type { PlanToolContext } from "./plan.ts";

const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));

const recordEvidenceInput = Type.Object({
	nodeId: Type.String({ description: "The plan node this evidence is about. Must match a plan_init slug." }),
	dimension: literals(MATH_DIMENSIONS),
	outcome: literals(MATH_OUTCOMES),
	hints: Type.Integer({ minimum: 0, description: "How many hint rungs this answer needed. Zero when unaided." }),
	note: Type.String({ minLength: 1, description: "One line naming what was shown or what was missing." }),
	habits: Type.Optional(Type.Array(literals(MATH_HABITS), {
		description: "When the attempt fell short (partial, incorrect, or credit that needed a hint): which recurring habit caused it. Omit when none applies.",
	})),
	probeAnswer: Type.Optional(Type.String({
		description: "For evidence from this session's probe, asked before the map existed: the tool-call id of the probe question (explain or recall) whose written answer shows this. Lets a probe-proven node earn credit instead of being recorded as assumed.",
	})),
});

type EvidenceInput = { nodeId: string; dimension: MathEvidence["dimension"]; outcome: MathEvidence["outcome"]; hints: number; note: string; habits?: unknown; probeAnswer?: string };

const CONCEAL_PROBLEM = "Math mode keeps the committed answer hidden so the attempt can continue: set conceal to true.";

/** Written answers only help if the answer stays hidden while the attempt runs. */
export function requireConcealedAnswer(tool: AgentTool<any>): AgentTool<any> {
	return {
		...tool,
		execute: async (toolCallId, input, ...rest) => {
			if ((input as { conceal?: unknown }).conceal !== true) return invalidInputResult(tool.name, [CONCEAL_PROBLEM]);
			return tool.execute(toolCallId, input, ...rest);
		},
	};
}

/** What the evidence tools close over. `evidenceStore` absent = no global
 *  ledger (tests): record_evidence still works, search_evidence is not offered. */
export type MathToolContext = Pick<PlanToolContext, "chatId" | "chatStore"> & { evidenceStore?: EvidenceStore };

const searchEvidenceInput = Type.Object({
	query: Type.String({ minLength: 1, description: "Keywords for the topic, e.g. \"quadratic residues Legendre symbol\". Matched against node titles, summaries and evidence notes." }),
});

/** Search evidence recorded in the learner's OTHER sessions (math mode, prober and teacher). */
export function searchEvidenceTool(ctx: MathToolContext & { evidenceStore: EvidenceStore; reviewStore?: ReviewStore; weightsStore?: FsrsWeightsStore }): AgentTool<typeof searchEvidenceInput> {
	return {
		name: SEARCH_EVIDENCE_TOOL,
		label: SEARCH_EVIDENCE_TOOL,
		description:
			"Search mastery evidence recorded in the learner's earlier sessions (not this one). " +
			"Keyword match over node title, summary and note; best matches first, newest first, at most 20. " +
			"Each result gives the session, node, dimension (K/U/S/P), outcome, hints, note, date, the node's status in that session, " +
			`and its memory: recall probability now from its forgetting curve, when it falls below ${DEFAULT_DESIRED_RETENTION}, and stale = solid there but likely forgotten since.`,
		parameters: searchEvidenceInput,
		execute: async (_toolCallId, input) => {
			const records = ctx.evidenceStore.list();
			const hits = searchEvidence(records, input.query, ctx.chatId);
			if (hits === null) return invalidInputResult(SEARCH_EVIDENCE_TOOL, ["query holds no searchable word (use words of two or more letters)."]);
			const titles = new Map(ctx.chatStore.listChats().map((chat) => [chat.id, chat.title]));
			const memory = new Map(memorySnapshot(records, Date.now(), { reviews: ctx.reviewStore?.list() ?? [], weights: ctx.weightsStore?.read() }).map((item) => [item.id, item]));
			const results = hits.map(({ record, nodeStatus: status }) => ({
				session: titles.get(record.chatId) ?? record.chatId,
				sessionId: record.chatId,
				node: record.nodeTitle,
				...(record.nodeSummary ? { nodeSummary: record.nodeSummary } : {}),
				nodeStatusInSession: MATH_STATUS_LABELS[status],
				dimension: record.dimension,
				outcome: record.outcome,
				hints: record.hints,
				note: record.note,
				...(record.habits ? { habits: record.habits } : {}),
				recordedAt: record.recordedAt,
				...memoryFields(memory.get(itemKeys().key(record.chatId, record.nodeId).id)),
			}));
			const details = { query: input.query, count: results.length, results };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	};
}

/** An item's curve as search_evidence reports it. */
function memoryFields(item: ReturnType<typeof memorySnapshot>[number] | undefined) {
	if (!item) return {};
	if (item.status === "unverified") return { memory: { unverified: true } };
	return { memory: { recall: Math.round(item.retrievability * 100) / 100, dueAt: item.dueAt, stale: item.stale } };
}

/** The teacher's math tools. Evidence recorded during this run is kept here
 *  because the record may not hold it until the run settles. */
export function mathTeacherTools(ctx: MathToolContext) {
	const thisRun: MathEvidence[] = [];
	const readRecord = () => {
		const record = ctx.chatStore.getChat(ctx.chatId);
		const messages = (record?.messages ?? []) as LhMessage[];
		const persisted = evidenceFromMessages(messages);
		const known = new Set(persisted.map((entry) => entry.id));
		return { tree: record?.tree, settings: record?.settings, messages, evidence: [...persisted, ...thisRun.filter((entry) => !known.has(entry.id))] };
	};

	const gateExplain = (tool: AgentTool<any>): AgentTool<any> => requireConcealedAnswer({
		...tool,
		execute: async (toolCallId, input, ...rest) => {
			const { tree, messages, evidence } = readRecord();
			const nodeId = (input as { nodeId?: unknown }).nodeId;
			if (tree && typeof nodeId === "string" && tree.nodes.some((node) => node.id === nodeId)) {
				const current = derivePlanStatusesLh(tree, messages).current;
				const blocked = blockingPrerequisites(tree, nodeId, current, evidence);
				if (blocked.length > 0) {
					return invalidInputResult(tool.name, [
						`Mastery gate: prerequisite(s) ${blocked.join(", ")} of ${nodeId} are not established. ` +
						"Keep working there with a written attempt. If the probe directly supports one, record it as assumed; " +
						"record learner_override only if the learner explicitly asked to move on.",
					]);
				}
			}
			return tool.execute(toolCallId, input, ...rest);
		},
	});

	const recordEvidence: AgentTool<typeof recordEvidenceInput> = {
		name: RECORD_EVIDENCE_TOOL,
		label: RECORD_EVIDENCE_TOOL,
		description:
			"Record what the learner's latest written attempt demonstrated. Call it after judging an attempt, once per dimension shown. " +
			"K = stated the definition or theorem, U = explained why or what breaks, S = used it on a case, P = produced a proof or key step. " +
			"correct and correct_slow require a submitted written attempt on this node, or `probeAnswer` naming the probe question whose answer showed it. " +
			"assumed = not tested here, justified by indirect evidence. learner_override = the learner explicitly chose to move on.",
		parameters: recordEvidenceInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const entry = input as EvidenceInput;
			const { tree, settings, messages, evidence } = readRecord();
			if (!tree?.nodes.some((node) => node.id === entry.nodeId)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`nodeId "${entry.nodeId}" matches no node in this session's plan map.`]);
			}
			if (entry.probeAnswer !== undefined && !answeredWrittenQuestions(messages).has(entry.probeAnswer)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`probeAnswer "${entry.probeAnswer}" is not an answered written question (explain or recall) in this session. Copy the tool-call id of the probe question.`]);
			}
			if ((entry.outcome === "correct" || entry.outcome === "correct_slow") && entry.probeAnswer === undefined && !attemptedNodes(messages).has(entry.nodeId)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`No submitted written attempt exists on ${entry.nodeId}, so it cannot earn credit. If this session's probe tested it, pass that question's tool-call id as probeAnswer.`]);
			}
			const { habits: rawHabits, probeAnswer: _probeAnswer, ...rest } = entry;
			const habits = habitsOf(rawHabits);
			const saved: MathEvidence = { ...rest, id: toolCallId, ...(habits ? { habits } : {}) };
			thisRun.push(saved);
			// The chat record stays the gate's truth; a failed ledger copy is logged, not fatal.
			const t = Date.now();
			try { ctx.evidenceStore?.append({ ...evidenceRecord(ctx.chatId, saved, tree, new Date(t).toISOString()), minutesIn: minutesIntoSitting(messages, t, settings) }); }
			catch (error) { console.error(`[evidence] ledger append failed for ${ctx.chatId}:`, error); }
			const all = [...evidence, saved];
			const pitch = mathPitch(all);
			const habitCounts: Record<string, number> = {};
			for (const tag of all.flatMap((e) => e.habits ?? [])) habitCounts[tag] = (habitCounts[tag] ?? 0) + 1;
			const result = {
				ok: true,
				nodeStatus: nodeStatus(entry.nodeId, all),
				recentCredited: `${pitch.credited}/${pitch.graded}`,
				...(Object.keys(habitCounts).length > 0 ? { sessionHabits: habitCounts } : {}),
				instruction: pitch.stepDown
					? "Recent success is below the target band. Do not raise difficulty: step down to the weakest prerequisite with a smaller written problem."
					: "Stay near 80% success: one new idea at a time.",
			};
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};

	return { gateExplain, recordEvidence };
}
