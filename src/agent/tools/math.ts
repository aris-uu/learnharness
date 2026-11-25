import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { derivePlanStatusesLh } from "../../core/contracts/plan.ts";
import {
	answeredWrittenQuestions,
	attemptedNodes,
	blockingPrerequisites,
	describeWrittenQuestions,
	evidenceFromMessages,
	habitsOf,
	MATH_DIMENSIONS,
	MATH_HABITS,
	MATH_OUTCOMES,
	mathPitch,
	nodeStatus,
	RECORD_EVIDENCE_TOOL,
	SEARCH_EVIDENCE_TOOL,
	EVIDENCE_SEARCH_LIMIT,
	type MathEvidence,
} from "../../core/math-evidence.ts";
import {
	CONCEPT_KINDS, conceptBrief, scopeProblems, searchConcepts,
	type Attempt, type Concept, type MathStore,
} from "../../core/math-concepts.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { asEvidence, DEFAULT_DESIRED_RETENTION, storeSnapshot, type MemoryItemSnapshot } from "../../core/memory/items.ts";
import { ratingFor } from "../../core/memory/review.ts";
import type { FsrsWeightsStore } from "../../core/memory/fsrs.ts";
import { invalidInputResult } from "../tool-execute.ts";
import { minutesIntoSitting } from "../../core/session-clock.ts";
import type { PlanToolContext } from "./plan.ts";

const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));

export const UPDATE_CONCEPT_TOOL = "update_concept";

const recordEvidenceInput = Type.Object({
	nodeId: Type.String({ description: "The concept this evidence is about: a node id of this session's plan map (node ids are global concept ids)." }),
	dimension: literals(MATH_DIMENSIONS),
	outcome: literals(MATH_OUTCOMES),
	hints: Type.Integer({ minimum: 0, description: "How many hint rungs this answer needed. Zero when unaided." }),
	note: Type.String({ minLength: 1, description: "One line naming what was shown or what was missing." }),
	habits: Type.Optional(Type.Array(literals(MATH_HABITS), {
		description: "When the attempt fell short (partial, incorrect, or credit that needed a hint): which recurring habit caused it. Omit when none applies.",
	})),
	probeAnswer: Type.Optional(Type.String({
		description: "For evidence from this session's probe, asked before the map existed: the id of the probe question (explain or recall) whose written answer shows this. Record the outcome that answer showed. If you don't know the id, call without it: the refusal lists this session's answered questions with their ids.",
	})),
});

type EvidenceInput = { nodeId: string; dimension: MathEvidence["dimension"]; outcome: MathEvidence["outcome"]; hints: number; note: string; habits?: unknown; probeAnswer?: string };

const updateConceptInput = Type.Object({
	conceptId: Type.String({ description: "A concept id: a node of this plan, or one search_evidence returned." }),
	title: Type.Optional(Type.String({ minLength: 1 })),
	kind: Type.Optional(literals(CONCEPT_KINDS)),
	statement: Type.Optional(Type.String({ minLength: 1, description: "Exactly what is tested: the definition with every clause, the theorem with every hypothesis, or the technique's steps and when it applies. One concept = one testable unit." })),
	checks: Type.Optional(Type.Object({
		K: Type.Optional(Type.String()), U: Type.Optional(Type.String()), S: Type.Optional(Type.String()), P: Type.Optional(Type.String()),
	}, { description: "Per dimension, what a question on it must make the learner produce." })),
	confusableWith: Type.Optional(Type.Array(Type.String(), { description: "Concept ids the learner easily mixes up with this one. Consolidation studies them together." })),
});

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

/** What the math tools close over. `mathStore` absent = no global record
 *  (bare tests): the sitting's transcript is the only evidence. */
export type MathToolContext = Pick<PlanToolContext, "chatId" | "chatStore"> & { mathStore?: MathStore; weightsStore?: FsrsWeightsStore };

/** Solid on the global record and still fresh: a prerequisite that needs no work here. */
export function establishedGlobally(item: MemoryItemSnapshot | undefined): boolean {
	return !!item && item.mastery === "solid" && !!item.state && item.retrievability >= DEFAULT_DESIRED_RETENTION;
}

const searchEvidenceInput = Type.Object({
	query: Type.String({ minLength: 1, description: "Keywords for the topic, e.g. \"quadratic residues Legendre symbol\". Matched against concept ids, titles, statements and summaries." }),
});

/** Search the global concepts and what the learner has shown on them. */
export function searchEvidenceTool(ctx: MathToolContext & { mathStore: MathStore }): AgentTool<typeof searchEvidenceInput> {
	return {
		name: SEARCH_EVIDENCE_TOOL,
		label: SEARCH_EVIDENCE_TOOL,
		description:
			"Search the learner's global math concepts. Concepts are shared by every session: REUSE a result's id as the plan node id for the same idea, so its evidence and memory carry over. " +
			`Best matches first, at most ${EVIDENCE_SEARCH_LIMIT}. Each gives the id, title, kind, statement, mastery (solid / in progress / not started), the credited dimensions, the last notes, ` +
			`and memory: recall now, when it falls below ${DEFAULT_DESIRED_RETENTION}, and stale = solid but likely forgotten (re-test it with one short question before building on it).`,
		parameters: searchEvidenceInput,
		execute: async (_toolCallId, input) => {
			const graph = ctx.mathStore.graph();
			const hits = searchConcepts(graph, input.query, EVIDENCE_SEARCH_LIMIT);
			if (hits === null) return invalidInputResult(SEARCH_EVIDENCE_TOOL, ["query holds no searchable word (use words of two or more letters)."]);
			const snapshot = new Map(storeSnapshot(ctx.mathStore, Date.now(), ctx.weightsStore?.read()).map((item) => [item.id, item]));
			const attempts = ctx.mathStore.attempts();
			const titles = new Map(ctx.chatStore.listChats().map((chat) => [chat.id, chat.title]));
			const results = hits.map((concept) => {
				const item = snapshot.get(concept.id);
				const notes = attempts.filter((a) => a.conceptId === concept.id && !a.implicit).slice(-2).reverse().map((a) => ({ at: a.at, dimension: a.dimension, outcome: a.outcome, note: a.note, session: titles.get(a.chatId) ?? a.chatId }));
				return {
					...conceptBrief(concept),
					...(concept.status === "retired" ? { retired: true } : {}),
					mastery: item?.mastery ?? "none",
					credited: item?.credited ?? [],
					lastNotes: notes,
					memory: !item ? { untested: true } : !item.state ? { unverified: true } : { recall: Math.round(item.retrievability * 100) / 100, dueAt: item.dueAt, stale: item.stale, stage: item.stage },
				};
			});
			const details = { query: input.query, count: results.length, results };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	};
}

/** The latest answered explain on a node in this transcript: what was asked. */
function latestQuestionOn(messages: readonly LhMessage[], nodeId: string, answered: ReadonlyMap<string, string>): { id: string; question: string } | null {
	let found: { id: string; question: string } | null = null;
	for (const raw of messages as unknown as Array<{ role?: string; content?: unknown }>) {
		if (raw.role !== "assistant" || !Array.isArray(raw.content)) continue;
		for (const block of raw.content as Array<{ type?: string; id?: string; name?: string; arguments?: { nodeId?: unknown; question?: unknown } }>) {
			if (block.type === "toolCall" && block.name === "explain" && block.arguments?.nodeId === nodeId && block.id && answered.has(block.id)) {
				found = { id: block.id, question: typeof block.arguments.question === "string" ? block.arguments.question : "" };
			}
		}
	}
	return found;
}

/** The teacher's math tools. Evidence recorded during this run is kept here
 *  too, because the transcript may not hold it until the run settles. */
export function mathTeacherTools(ctx: MathToolContext) {
	const thisRun: MathEvidence[] = [];
	const readRecord = () => {
		const record = ctx.chatStore.getChat(ctx.chatId);
		const messages = (record?.messages ?? []) as LhMessage[];
		// The sitting's evidence: the global log's rows for this chat, else (no store) the transcript.
		const stored = ctx.mathStore
			? ctx.mathStore.attempts().filter((a) => a.chatId === ctx.chatId && !a.implicit).map(asEvidence)
			: evidenceFromMessages(messages);
		const known = new Set(stored.map((entry) => entry.id));
		return { tree: record?.tree, settings: record?.settings, messages, evidence: [...stored, ...thisRun.filter((entry) => !known.has(entry.id))] };
	};
	const snapshotNow = () => ctx.mathStore ? new Map(storeSnapshot(ctx.mathStore, Date.now(), ctx.weightsStore?.read()).map((item) => [item.id, item])) : new Map<string, MemoryItemSnapshot>();

	const gateExplain = (tool: AgentTool<any>): AgentTool<any> => requireConcealedAnswer({
		...tool,
		execute: async (toolCallId, input, ...rest) => {
			const { tree, messages, evidence } = readRecord();
			const nodeId = (input as { nodeId?: unknown }).nodeId;
			if (tree && typeof nodeId === "string" && tree.nodes.some((node) => node.id === nodeId)) {
				const concept = ctx.mathStore?.graph().concepts[nodeId];
				if (concept?.scopeDraft) {
					return invalidInputResult(tool.name, [
						`Concept ${nodeId} has a draft scope from the migration. Confirm or sharpen it with ${UPDATE_CONCEPT_TOOL} (kind and statement: exactly what is tested) before asking on it. Draft: ${JSON.stringify(conceptBrief(concept))}`,
					]);
				}
				const current = derivePlanStatusesLh(tree, messages).current;
				const snapshot = snapshotNow();
				const blocked = blockingPrerequisites(tree, nodeId, current, evidence, (id) => establishedGlobally(snapshot.get(id)));
				if (blocked.length > 0) {
					const stale = blocked.filter((id) => snapshot.get(id)?.mastery === "solid");
					return invalidInputResult(tool.name, [
						`Mastery gate: prerequisite(s) ${blocked.join(", ")} of ${nodeId} are not established. ` +
						(stale.length ? `${stale.join(", ")} ${stale.length === 1 ? "was" : "were"} solid in an earlier session but recall has faded: ask one short retrieval question on each (it counts as its review), record it, then move on. ` : "") +
						"Otherwise keep working there with a written attempt. If this session's probe showed one, record what it showed with probeAnswer. " +
						"Record learner_override only if the learner explicitly asked to move on.",
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
			"Record what the learner's latest written attempt demonstrated on a concept. Call it after judging an attempt, once per dimension shown. " +
			"K = stated the definition or theorem, U = explained why or what breaks, S = used it on a case, P = produced a proof or key step. " +
			"correct and correct_slow require a submitted written attempt on this node, or `probeAnswer` naming the probe question whose answer showed it. " +
			"Evidence is global: it carries over to every later session on this concept, and the first attempt on a concept in a sitting moves its forgetting curve. " +
			"learner_override = the learner explicitly chose to move on.",
		parameters: recordEvidenceInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const entry = input as EvidenceInput;
			const { tree, settings, messages, evidence } = readRecord();
			// The schema already restricts this; checked again because the log is the truth.
			if (!(MATH_OUTCOMES as readonly string[]).includes(entry.outcome)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`outcome "${entry.outcome}" is not one of ${MATH_OUTCOMES.join(", ")}. Earlier sessions' evidence counts by itself: the concept is the same.`]);
			}
			if (!tree?.nodes.some((node) => node.id === entry.nodeId)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`nodeId "${entry.nodeId}" matches no node in this session's plan map.`]);
			}
			const questions = answeredWrittenQuestions(messages);
			if (entry.probeAnswer !== undefined && !questions.has(entry.probeAnswer)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`probeAnswer "${entry.probeAnswer}" is not an answered written question (explain or recall) in this session.\n${describeWrittenQuestions(questions)}`]);
			}
			if ((entry.outcome === "correct" || entry.outcome === "correct_slow") && entry.probeAnswer === undefined && !attemptedNodes(messages).has(entry.nodeId)) {
				return invalidInputResult(RECORD_EVIDENCE_TOOL, [`No submitted written attempt exists on ${entry.nodeId}, so it cannot earn credit. If this session's probe tested it, pass that question's id as probeAnswer.\n${describeWrittenQuestions(questions)}`]);
			}
			const habits = habitsOf(entry.habits);
			const saved: MathEvidence = { id: toolCallId, nodeId: entry.nodeId, dimension: entry.dimension, outcome: entry.outcome, hints: entry.hints, note: entry.note, ...(habits ? { habits } : {}) };
			if (ctx.mathStore) {
				const t = Date.now();
				const asked = entry.probeAnswer !== undefined
					? { id: entry.probeAnswer, question: questions.get(entry.probeAnswer) ?? "" }
					: latestQuestionOn(messages, entry.nodeId, questions);
				const attempt: Attempt = {
					id: toolCallId,
					conceptId: entry.nodeId,
					chatId: ctx.chatId,
					at: new Date(t).toISOString(),
					source: entry.probeAnswer !== undefined ? "probe" : "teach",
					role: "attempt",
					dimension: entry.dimension,
					outcome: entry.outcome,
					hints: entry.hints,
					note: entry.note,
					...(entry.outcome !== "learner_override" ? { rating: ratingFor({ outcome: entry.outcome, hints: entry.hints }) } : {}),
					...(asked?.question ? { question: asked.question.slice(0, 500) } : {}),
					...(asked ? { questionCallId: asked.id } : {}),
					...(habits ? { habits } : {}),
					minutesIn: minutesIntoSitting(messages, t, settings),
				};
				// The log is the truth: a failed write is this call's failure.
				try { ctx.mathStore.appendAttempt(attempt); }
				catch (error) { return invalidInputResult(RECORD_EVIDENCE_TOOL, [`The evidence could not be saved (${(error as Error).message}). Try again.`]); }
			}
			thisRun.push(saved);
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

	return { gateExplain, recordEvidence, ...(ctx.mathStore ? { updateConcept: updateConceptTool({ ...ctx, mathStore: ctx.mathStore }) } : {}) };
}

/** Confirm or sharpen a concept's scope, and mark confusable neighbours (teacher and reviewer). */
export function updateConceptTool(ctx: MathToolContext & { mathStore: MathStore }): AgentTool<typeof updateConceptInput> {
	return {
		name: UPDATE_CONCEPT_TOOL,
		label: UPDATE_CONCEPT_TOOL,
		description:
			"Set a global concept's scope: its kind and its statement (exactly what is tested), optional per-dimension checks, and the concepts it is easily confused with. " +
			"One concept = one testable unit: one definition, theorem, technique, example family or fact. A draft scope (scopeDraft) must be confirmed here before questions on it.",
		parameters: updateConceptInput,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const graph = ctx.mathStore.graph();
			const concept = graph.concepts[input.conceptId];
			if (!concept) return invalidInputResult(UPDATE_CONCEPT_TOOL, [`No concept "${input.conceptId}". Use a node id of this plan or an id from search_evidence.`]);
			const next: Concept = {
				...concept,
				...(input.title ? { title: input.title.trim() } : {}),
				...(input.kind ? { kind: input.kind } : {}),
				...(input.statement ? { statement: input.statement.trim() } : {}),
			};
			if (input.checks) {
				const checks = Object.fromEntries(Object.entries(input.checks).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, (v as string).trim()]));
				if (Object.keys(checks).length) next.checks = { ...(concept.checks ?? {}), ...checks };
			}
			if (input.confusableWith) {
				const unknown = input.confusableWith.filter((id) => !graph.concepts[id] || id === concept.id);
				if (unknown.length) return invalidInputResult(UPDATE_CONCEPT_TOOL, [`confusableWith names no other concept: ${unknown.join(", ")}.`]);
				next.confusableWith = [...new Set([...(concept.confusableWith ?? []), ...input.confusableWith])];
			}
			if (concept.scopeDraft) {
				if (!input.statement || !input.kind) return invalidInputResult(UPDATE_CONCEPT_TOOL, [`${concept.id} has a draft scope: pass both kind and statement to confirm it (they may repeat the draft when it is right).`]);
				delete next.scopeDraft;
			}
			const problems = scopeProblems(next.id, next);
			if (problems.length) return invalidInputResult(UPDATE_CONCEPT_TOOL, problems);
			const concepts = { ...graph.concepts, [next.id]: next };
			// Confusion is symmetric.
			for (const other of input.confusableWith ?? []) {
				const o = concepts[other]!;
				concepts[other] = { ...o, confusableWith: [...new Set([...(o.confusableWith ?? []), next.id])] };
			}
			ctx.mathStore.saveGraph({ ...graph, concepts });
			const details = { ok: true, concept: conceptBrief(next) };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	};
}
