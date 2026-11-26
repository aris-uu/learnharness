/**
 * THE REVIEWER'S TOOLS (retention mode; consolidation sittings): a sitting
 * picks due concepts, asks a fresh written question on each, and records a
 * graded attempt in the global attempt log. The picked concepts become this
 * sitting's plan map under their own (global) ids, so `explain` keeps its
 * nodeId contract. Design: docs/retention-mode-plan.md §5–§6,
 * docs/consolidation-sessions-plan.md, docs/global-concepts-plan.md.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { attemptedNodes, habitsOf, MATH_DIMENSIONS, MATH_HABITS, type MathDimension } from "../../core/math-evidence.ts";
import { conceptBrief, confusablesOf, linkConfusable, type Attempt, type MathStore } from "../../core/math-concepts.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { createTree } from "../../core/plan-tree.ts";
import type { PlanEdge, PlanTree } from "../../core/contracts/plan.ts";
import { retrievabilityAt, type FsrsWeightsStore } from "../../core/memory/fsrs.ts";
import { MATURE_STABILITY_DAYS, storeItems, storeSnapshot, trainingItems } from "../../core/memory/items.ts";
import {
	consolidationClusters, contrastAsked, contrastPairs, MAX_FOLLOW_UPS, owedContrasts, RATING_LABELS, ratingFor, retryQueue, RETRY_GAP, REVIEW_CHECKS, REVIEW_OUTCOMES, reviewCandidates, stagesFor,
} from "../../core/memory/review.ts";
import { invalidInputResult } from "../tool-execute.ts";
import { minutesIntoSitting, consolidationItemCount } from "../../core/session-clock.ts";
import type { PlanToolContext } from "./plan.ts";
import type { CourseStore } from "../../core/course.ts";

export const DUE_ITEMS_TOOL = "due_items";
export const PICK_ITEMS_TOOL = "pick_items";
export const RECORD_REVIEW_TOOL = "record_review";
/** How many items a review session picks by default (about 30 minutes). */
export const REVIEW_SESSION_ITEMS = 6;
const MAX_PICK = 12;

export type ReviewToolContext = Pick<PlanToolContext, "chatId" | "chatStore"> & {
	mathStore: MathStore;
	/** Fitted FSRS weights (absent: defaults) and the refit after each graded review. */
	weightsStore?: FsrsWeightsStore;
	/** Courses: close_session syncs the sitting into its course. */
	courseStore?: CourseStore;
	now?: () => number;
};

const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const ok = (details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

const dueItemsInput = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "How many candidates to list. Default 15." })),
});

const pickItemsInput = Type.Object({
	itemIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_PICK, description: "Concept ids from due_items, in the order you will review them (in consolidation: a cluster's items in its order)." }),
	warmUps: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 4, description: "Consolidation only: mature prerequisites from a cluster's warmUps, asked first as a warm-up. Their answers are logged as follow-ups and never move their schedule." })),
	reasons: Type.Optional(Type.String({ description: "One line on why these, in this order." })),
	override: Type.Optional(Type.Boolean({ description: "Allow ids that are not currently due (only when the learner asked for them)." })),
	contrastPartners: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 4, description: "Look-alikes of picked items that are not due (a cluster's contrastPartners): asked only inside a contrast question; their schedule never moves." })),
});

const recordReviewInput = Type.Object({
	nodeId: Type.String({ description: "The picked concept's id (a node of this sitting's map)." }),
	dimension: literals(MATH_DIMENSIONS),
	outcome: literals(REVIEW_OUTCOMES),
	hints: Type.Integer({ minimum: 0, description: "Hint rungs the answer needed. Zero when unaided." }),
	loadBearing: Type.Optional(Type.Boolean({ description: "For a partial: was the missing piece the step that carries the argument? Omitted counts as true." })),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "The learner's confidence on the answer, copied from it." })),
	elapsedSeconds: Type.Optional(Type.Number({ minimum: 0, description: "The answer's elapsedSeconds, copied from it." })),
	expectedSeconds: Type.Optional(Type.Number({ minimum: 1, description: "How long a fluent answer to your question should take." })),
	question: Type.String({ minLength: 1, description: "The question you asked, in one line." }),
	note: Type.String({ minLength: 1, description: "One line naming what was shown or what was missing." }),
	habits: Type.Optional(Type.Array(literals(MATH_HABITS), { description: "When the attempt fell short: which recurring habit caused it." })),
	followUp: Type.Optional(Type.Boolean({ description: "This answers a harder rung asked after a clean answer on the same item (the easy-to-hard ladder). Logged; a failed one (Hard or Again) lowers the item's first attempt one step." })),
	check: Type.Optional(Type.Union(REVIEW_CHECKS.map((value) => Type.Literal(value)), { description: "Log-only answers on an item that already had its first attempt here. \"repair\": the rebuild right after a repair. \"close\": the sitting's blank-page retrieval on this item." })),
	noRetry: Type.Optional(Type.Boolean({ description: "The learner asked to skip this item: no retry." })),
	confusedWith: Type.Optional(Type.String({ description: "The concept id the answer produced instead of this one (gave the flux formula for the divergence theorem). Links both concepts as confusable and tags the attempt confused_with. When the look-alike is not a concept yet, create it with update_concept first." })),
	pairWith: Type.Optional(Type.String({ description: "With check: \"contrast\": the other concept of the pair, asked side by side with this one in one question. The grade is logged on both." })),
});

/** The concepts this sitting picked (last successful pick_items), and its warm-ups. */
export function pickedItems(messages: readonly unknown[]): { items: string[]; warmUps: string[]; contrastPartners: string[] } | null {
	const okIds = new Set<string>();
	for (const message of messages as Array<{ role?: string; toolName?: string; toolCallId?: string; isError?: boolean }>) {
		if (message.role === "toolResult" && message.toolName === PICK_ITEMS_TOOL && !message.isError) okIds.add(message.toolCallId!);
	}
	let latest: { items: string[]; warmUps: string[]; contrastPartners: string[] } | null = null;
	for (const message of messages as Array<{ role?: string; content?: unknown }>) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Array<{ type?: string; id?: string; name?: string; arguments?: { itemIds?: unknown; warmUps?: unknown; contrastPartners?: unknown } }>) {
			if (block.type === "toolCall" && block.name === PICK_ITEMS_TOOL && okIds.has(block.id!) && Array.isArray(block.arguments?.itemIds)) {
				const strings = (v: unknown) => (Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : []);
				latest = { items: strings(block.arguments.itemIds), warmUps: strings(block.arguments.warmUps), contrastPartners: strings(block.arguments.contrastPartners) };
			}
		}
	}
	return latest;
}

export function reviewTools(ctx: ReviewToolContext) {
	const now = ctx.now ?? Date.now;
	let thisRunPicks: { items: string[]; warmUps: string[]; contrastPartners: string[] } | null = null;
	const record = () => ctx.chatStore.getChat(ctx.chatId);
	const picks = () => thisRunPicks ?? pickedItems((record()?.messages ?? []) as LhMessage[]);
	const titles = () => new Map(ctx.chatStore.listChats().map((chat) => [chat.id, chat.title]));
	const consolidating = () => record()?.settings?.consolidate === true;
	const snapshotAt = (t: number) => storeSnapshot(ctx.mathStore, t, ctx.weightsStore?.read());
	const candidatesNow = (limit?: number) => {
		const t = now();
		const names = titles();
		const snapshot = snapshotAt(t);
		const candidates = reviewCandidates({
			snapshot, attempts: ctx.mathStore.attempts(), graph: ctx.mathStore.graph(), nowMs: t, limit,
			// Review is for mature concepts; a consolidation sitting takes learning and relearning ones.
			stages: stagesFor(consolidating()),
			sessionTitle: (chatId) => names.get(chatId) ?? chatId,
		});
		return { candidates, snapshot, t };
	};

	const dueItems: AgentTool<typeof dueItemsInput> = {
		name: DUE_ITEMS_TOOL,
		label: DUE_ITEMS_TOOL,
		description:
			"List the concepts that are due, ranked: prerequisites of other due concepts first, then lowest recall. " +
			"Each gives its id, title, kind, statement and checks (what a question must test), stage, session, recall now (null = never verified), days overdue, stability, credited dimensions, " +
				"retained and depthMissing (dimensions held after teaching, and what the item still needs before it can mature), firstRung (the dimension to ask the first attempt on), confusableWith, " +
			"the last attempts with their questions and notes (never repeat one), habit tags, and prerequisites that are also due. " +
			"In a consolidation sitting it also returns clusters: study each cluster's items together, in order, with its warm-ups first; each lists contrastPartners (look-alikes not due) and contrasts (pairs to ask one side-by-side question on; required = confused before). Read only.",
		parameters: dueItemsInput,
		execute: async (_id, input) => {
			const { candidates, snapshot, t } = candidatesNow(input.limit);
			if (!consolidating()) return ok({ count: candidates.length, sessionSize: REVIEW_SESSION_ITEMS, candidates });
			const budget = record()?.settings?.timeboxMin;
			const capacity = budget ? consolidationItemCount(budget) : 4;
			const clusters = consolidationClusters({ candidates, snapshot, graph: ctx.mathStore.graph(), capacity, nowMs: t, attempts: ctx.mathStore.attempts() });
			return ok({ count: candidates.length, sessionSize: capacity, clusters, candidates });
		},
	};

	const pickItems: AgentTool<typeof pickItemsInput> = {
		name: PICK_ITEMS_TOOL,
		label: PICK_ITEMS_TOOL,
		description:
			`Choose this sitting's concepts from due_items (default ${REVIEW_SESSION_ITEMS} in review), in order: interleave topics in review; keep a cluster together in consolidation, warm-ups first. ` +
			"The picks become this sitting's map under their own ids; tag each question with that id. Call it again to change the selection.",
		parameters: pickItemsInput,
		executionMode: "sequential",
		execute: async (_id, input) => {
			const ids = [...new Set(input.itemIds)];
			const warmUps = [...new Set(input.warmUps ?? [])].filter((id) => !ids.includes(id));
			if (warmUps.length && !consolidating()) return invalidInputResult(PICK_ITEMS_TOOL, ["warmUps belong to consolidation sittings only."]);
			const snapshot = snapshotAt(now());
			const byId = new Map(snapshot.map((item) => [item.id, item]));
			const unknown = [...ids, ...warmUps].filter((id) => !byId.has(id));
			if (unknown.length) return invalidInputResult(PICK_ITEMS_TOOL, [`No memory item has id ${unknown.join(", ")}. Copy ids from due_items exactly.`]);
			const notDue = ids.filter((id) => !byId.get(id)!.due);
			if (notDue.length && !input.override) {
				return invalidInputResult(PICK_ITEMS_TOOL, [`Not due: ${notDue.join(", ")}. Pick due items, or set override only when the learner asked for these.`]);
			}
			const graphNow = ctx.mathStore.graph();
			const partners = [...new Set(input.contrastPartners ?? [])].filter((id) => !ids.includes(id) && !warmUps.includes(id));
			const badPartners = partners.filter((id) => !byId.get(id)?.state || !ids.some((item) => confusablesOf(graphNow, item).includes(id)));
			if (badPartners.length) return invalidInputResult(PICK_ITEMS_TOOL, [`Contrast partners must be scheduled concepts marked confusable with a picked item: ${badPartners.join(", ")}.`]);
			const notMatureWarmUps = warmUps.filter((id) => byId.get(id)!.stage !== "mature");
			if (notMatureWarmUps.length) return invalidInputResult(PICK_ITEMS_TOOL, [`Warm-ups must be mature prerequisites: ${notMatureWarmUps.join(", ")}. Put a young one in itemIds instead.`]);
			const all = [...warmUps, ...ids];
			const graph = ctx.mathStore.graph();
			const nodes = all.map((id) => ({ id, title: byId.get(id)!.title, ...(byId.get(id)!.summary ? { summary: byId.get(id)!.summary } : {}) }));
			const inPick = new Set(all);
			const edges: PlanEdge[] = graph.edges.filter((e) => inPick.has(e.from) && inPick.has(e.to)).map((e) => ({ from: e.from, to: e.to }));
			let tree: PlanTree;
			try { tree = createTree(nodes, edges); }
			catch (error) { return invalidInputResult(PICK_ITEMS_TOOL, [(error as Error).message]); }
			ctx.chatStore.saveTree(ctx.chatId, tree);
			thisRunPicks = { items: ids, warmUps, contrastPartners: partners };
			const drafts = all.filter((id) => graph.concepts[id]?.scopeDraft);
			const pairs = contrastPairs(graph, ctx.mathStore.attempts(), ids, partners);
			return ok({
				ok: true,
				items: all.map((id) => ({ nodeId: id, ...(graph.concepts[id] ? conceptBrief(graph.concepts[id]!) : { title: byId.get(id)!.title }), ...(warmUps.includes(id) ? { warmUp: true } : {}) })),
				...(drafts.length ? { confirmScopes: `Draft scopes on ${drafts.join(", ")}: confirm or sharpen each with update_concept before its first question.` } : {}),
				...(partners.length ? { contrastPartners: partners } : {}),
				...(pairs.length ? { contrasts: pairs, contrastRule: "After both items of a pair have their first attempt (a partner needs none), ask ONE contrast question on the pair: which is which, what each computes or says, and one case where they differ. Grade it with record_review on one of them, check: \"contrast\", pairWith: the other. Required pairs must be asked before the close." } : {}),
			});
		},
	};

	const recordReview: AgentTool<typeof recordReviewInput> = {
		name: RECORD_REVIEW_TOOL,
		label: RECORD_REVIEW_TOOL,
		description:
			"Grade the learner's written answer on a picked concept. Report the outcome; the server sets the FSRS rating " +
			"(incorrect, 2+ hints, or a load-bearing partial = Again; other partial, slow or 1 hint = Hard; clean = Good; clean, fast and ≥90% confident = Easy). " +
			"Only the first attempt on a concept in a sitting moves its schedule; later ones are logged as retries, follow-ups (followUp) or checks (check: repair / close / contrast). Warm-ups never move it. After an Again the retry is deferred behind other items. " +
				"An item cannot mature until its depthMissing dimensions hold after teaching: until then a clean first attempt counts as Hard. A failed contrast also caps both items of the pair at Hard for the sitting. " +
				"A U or P answer needs the concept's checks for that dimension (set them with update_concept). Returns the rating, the next due date, depthMissing, the retry queue and what to do next.",
		parameters: recordReviewInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const picked = picks();
			const itemId = input.nodeId;
			const warmUp = !!picked?.warmUps.includes(itemId);
			if (!picked || (!picked.items.includes(itemId) && !warmUp)) return invalidInputResult(RECORD_REVIEW_TOOL, [`nodeId "${input.nodeId}" is not a picked concept. Call pick_items first, then use its ids.`]);
			const messages = (record()?.messages ?? []) as LhMessage[];
			if ((input.outcome === "correct" || input.outcome === "correct_slow") && !attemptedNodes(messages).has(input.nodeId)) {
				return invalidInputResult(RECORD_REVIEW_TOOL, [`No submitted written attempt exists on ${input.nodeId}, so it cannot be graded correct.`]);
			}
			const attempts = ctx.mathStore.attempts();
			const t = now();
			const sitting = attempts.filter((a) => a.chatId === ctx.chatId);
			const onItem = sitting.filter((a) => a.conceptId === itemId);
			const ladder = onItem.filter((a) => a.role === "attempt" || a.role === "followup");
			if (input.check && !warmUp) {
				const problem = input.followUp
					? "pass either check or followUp, not both"
					: !onItem.some((a) => a.role === "attempt")
						? "a check needs a graded first attempt on this item in this sitting; grade the first attempt without check first"
						: undefined;
				if (problem) return invalidInputResult(RECORD_REVIEW_TOOL, [`check on ${input.nodeId}: ${problem}.`]);
			}
			if (input.followUp && !warmUp) {
				const problem = !onItem.some((a) => a.role === "attempt")
					? "a follow-up needs a graded first attempt on this item; grade the easy rung without followUp first"
					: (ladder.at(-1)!.rating ?? 1) < 3
						? "climb only after a clean answer: the last rung on this item was not Good or Easy. If this answers your repair's rebuild question, record it with check: \"repair\" instead"
						: onItem.filter((a) => a.role === "followup").length >= MAX_FOLLOW_UPS
							? `at most ${MAX_FOLLOW_UPS} follow-ups per item; move on`
							: undefined;
				if (problem) return invalidInputResult(RECORD_REVIEW_TOOL, [`followUp on ${input.nodeId}: ${problem}.`]);
			}
			let graph = ctx.mathStore.graph();
			if (input.confusedWith !== undefined && (input.confusedWith === itemId || !graph.concepts[input.confusedWith])) {
				return invalidInputResult(RECORD_REVIEW_TOOL, [`confusedWith "${input.confusedWith}" is no other concept. When the look-alike is not a concept yet, create it with update_concept first, then grade again.`]);
			}
			if (input.pairWith !== undefined && input.check !== "contrast") return invalidInputResult(RECORD_REVIEW_TOOL, ["pairWith belongs to check: \"contrast\" only."]);
			const pairWith = input.check === "contrast" ? input.pairWith : undefined;
			if (input.check === "contrast" && !warmUp) {
				const partnerFirstOwed = !!pairWith && picked.items.includes(pairWith) && !sitting.some((a) => a.conceptId === pairWith && a.role === "attempt");
				const problem = !pairWith
					? "a contrast needs pairWith: the other concept of the pair"
					: !confusablesOf(graph, itemId).includes(pairWith) && input.confusedWith !== pairWith
						? `${pairWith} is not marked confusable with ${itemId}; link them with update_concept (confusableWith) first`
						: partnerFirstOwed
							? `grade ${pairWith}'s own first attempt before the contrast`
							: contrastAsked(sitting, itemId, pairWith)
								? "this pair already had its contrast in this sitting"
								: undefined;
				if (problem) return invalidInputResult(RECORD_REVIEW_TOOL, [`contrast on ${input.nodeId}: ${problem}.`]);
			}
			// A5: a deep question needs a target. Repairs and contrasts are exempt (they aim at a slip or a pair, not the item's scope).
			const deep = input.dimension === "U" || input.dimension === "P";
			if (deep && !warmUp && input.check !== "repair" && input.check !== "contrast" && !graph.concepts[itemId]?.checks?.[input.dimension as MathDimension]) {
				return invalidInputResult(RECORD_REVIEW_TOOL, [
					`${itemId} has no checks.${input.dimension}. Set it with update_concept: one line naming what a ${input.dimension} answer must contain (${input.dimension === "P" ? "the step that carries the proof" : "the hypothesis that matters and the counterexample when it is dropped"}). Then call record_review again with the same grade.`,
				]);
			}
			const weights = ctx.weightsStore?.read();
			const before = storeSnapshot(ctx.mathStore, t, weights).find((item) => item.id === itemId);
			const followUp = input.followUp === true || warmUp;
			const check = warmUp ? undefined : input.check;
			const retry = !followUp && !check && onItem.length > 0;
			// NOTHING TO INTERLEAVE (owner, 2026-11-19): an Again on the last first attempt with no other retry owed skips the retry.
			const queueBefore = retryQueue(sitting, picked.items);
			const lastFirst = !followUp && !check && !retry && queueBefore.remaining.length === 1 && queueBefore.remaining[0] === itemId;
			const nothingToInterleave = lastFirst && queueBefore.waiting.length === 0 && queueBefore.ready.length === 0;
			const rating = ratingFor(input);
			const habits = habitsOf([...(input.habits ?? []), ...(input.confusedWith ? ["confused_with"] : [])]);
			const attempt: Attempt = {
				id: toolCallId, conceptId: itemId, chatId: ctx.chatId, at: new Date(t).toISOString(),
				source: consolidating() ? "consolidate" : "review",
				role: check ? "check" : followUp ? "followup" : retry ? "retry" : "attempt",
				...(check ? { check } : {}),
				dimension: input.dimension as MathDimension, outcome: input.outcome, hints: input.hints, rating,
				...(input.loadBearing !== undefined ? { loadBearing: input.loadBearing } : {}),
				...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
				...(input.elapsedSeconds !== undefined ? { elapsedSeconds: input.elapsedSeconds } : {}),
				...(input.expectedSeconds !== undefined ? { expectedSeconds: input.expectedSeconds } : {}),
				question: input.question, note: input.note,
				...(habits ? { habits } : {}),
				...(pairWith ? { pairWith } : {}),
				...(input.confusedWith ? { confusedWith: input.confusedWith } : {}),
				...(!check && !followUp && (input.noRetry || nothingToInterleave) && rating === 1 ? { noRetry: true } : {}),
				minutesIn: minutesIntoSitting(messages, t, record()?.settings),
				...(before?.state ? { predicted: Math.round(retrievabilityAt(before.state, t, weights) * 1000) / 1000 } : {}),
			};
			try {
				ctx.mathStore.appendAttempt(attempt);
				// The contrast grade is the pair's: log it on the partner too (never moves either schedule).
				if (check === "contrast" && pairWith) ctx.mathStore.appendAttempt({ ...attempt, id: `${toolCallId}#pair`, conceptId: pairWith, pairWith: itemId, predicted: undefined });
				if (input.confusedWith) {
					graph = linkConfusable(graph, itemId, input.confusedWith);
					ctx.mathStore.saveGraph(graph);
				}
			}
			catch (error) { return invalidInputResult(RECORD_REVIEW_TOOL, [`The grade could not be saved (${(error as Error).message}). Try again.`]); }
			// Refit FSRS to the grown log (docs/fsrs7-plan.md): fire-and-forget, gated in core/memory/fit.ts.
			if (ctx.weightsStore && !check && !followUp) void ctx.weightsStore.refit(trainingItems(storeItems(ctx.mathStore, weights)));
			const after = storeSnapshot(ctx.mathStore, t, weights).find((item) => item.id === itemId);
			const nextDue = after?.state ? after.dueAt : undefined;
			const sittingNow = [...sitting, attempt];
			const queue = retryQueue(sittingNow, picked.items);
			const names = (ids: readonly string[]) => ids.join(", ");
			const closeChecked = new Set(sittingNow.filter((a) => a.role === "check" && a.check === "close").map((a) => a.conceptId));
			const attemptedHere = [...new Set(sittingNow.filter((a) => a.role === "attempt").map((a) => a.conceptId))];
			const closeOwed = attemptedHere.filter((id) => !closeChecked.has(id));
			const allAttempts = ctx.mathStore.attempts();
			const owed = owedContrasts(graph, allAttempts, ctx.chatId, picked.contrastPartners);
			const optional = contrastPairs(graph, allAttempts, attemptedHere, picked.contrastPartners).filter((p) => !p.required && !contrastAsked(sittingNow, p.itemId, p.partner));
			const contrastStep = owed.length
				? `Required contrast (the pair was confused before), before the close: ${owed.map((p) => `${p.itemId} vs ${p.partner}`).join("; ")}. One question on both side by side: which is which, what each says or computes, and one case where they differ. Grade with record_review check: "contrast", pairWith. `
				: optional.length && consolidating()
					? `If time allows, one contrast question on ${optional.map((p) => `${p.itemId} vs ${p.partner}`).join("; ")} (check: "contrast", pairWith). `
					: "";
			const closeStep = contrastStep + (consolidating() && closeOwed.length
				? `Before the closing summary, the close: one blank-page retrieval per item, written from scratch with nothing on screen (state the item's central statement or step again), each graded with record_review and check: "close". Still owed on: ${names(closeOwed)}. `
				: "");
			const nextStep = queue.ready.length
				? `Now ask the deferred retry on ${names(queue.ready.slice(0, 1))}: a DIFFERENT question from both earlier ones, at the same rung as the one that failed (for a stale item, another plain K question), with no reminder of the repair.`
				: queue.remaining.length
					? "Move to the next item."
					: record()?.settings?.timeboxMin
						? `All items and retries are done. ${closeStep}Then give the closing summary and call close_session with the hand-off (verdicts: []). The sitting is not closed until close_session succeeds.`
						: `All items and retries are done. ${closeStep}Then close the session.`;
			const followUpsLeft = MAX_FOLLOW_UPS - onItem.filter((a) => a.role === "followup").length - (followUp ? 1 : 0);
			const depthMissing = after?.depthMissing ?? [];
			const needs = depthMissing.find((d) => d !== "K");
			const checksFor = (d: string) => graph.concepts[itemId]?.checks?.[d as MathDimension];
			// A3: when the item still misses depth, the climb is not optional.
			const climb = needs && followUpsLeft > 0
				? `Climb now: ask one ${needs} question on this item, graded with followUp: true. This item cannot mature until a ${needs} answer holds outside the teaching sitting, so a clean first attempt counts as Hard until then.` +
					(needs === "U" || needs === "P" ? (checksFor(needs) ? ` It must make the learner produce: ${checksFor(needs)}.` : ` First set checks.${needs} with update_concept (what the answer must contain).`) : "") +
					" One retrieval, at most five minutes. Then: " + nextStep
				: `You may climb one rung: a harder question on this item (U or S, then a P step), graded with followUp: true; it does not move the schedule. Otherwise: ${nextStep}`;
			const instruction = warmUp
				? `Warm-up logged (a mature prerequisite: its schedule does not move). ${rating >= 3 ? "" : "It slipped: say in one line what was missing; it will come back on its own schedule. "}Now the cluster's first item.`
				: check
				? `${check === "repair" ? "Repair check" : "Close check"} logged (never moves the schedule, and it is not the retry). ${nextStep}`
				: followUp
				? rating >= 3
					? followUpsLeft > 0 ? `Follow-up held (logged, not scheduled). ${climb}` : `Follow-up held (logged, not scheduled). ${nextStep}`
					: `The harder rung slipped. It gets no retry, and it lowers this item's first attempt one step, so the item comes back sooner: say in one line what was missing, then: ${nextStep}`
				: retry
				? rating === 1
					? `The retry also failed. Stop drilling this item: offer a teach session on it in the closing summary (the learner can open one from the Memory page). ${nextStep}`
					: `Retry logged; it does not move the schedule. ${nextStep}`
				: rating === 1 && attempt.noRetry && !input.noRetry
					? `Again: give one short repair aimed at the exact gap, but no retry. Nothing is left to interleave, so a retry now would only test the repair; the item comes back in the next sitting. ${nextStep}`
					: rating === 1 && attempt.noRetry
					? `No retry: the learner asked to skip it. Give at most a one-line pointer and move on. ${nextStep}`
					: rating === 1
					? queue.ready[0] === itemId
						? "Again: give one short repair aimed at the exact gap. Nothing is left to interleave, so then ask the retry: a DIFFERENT question about this item."
						: `Again: give one short repair aimed at the exact gap now, but do NOT retry yet. The retry waits until ${RETRY_GAP} other items have been asked (or until none are left), so it tests retrieval rather than the repair you just gave. Then: ${nextStep}`
					: rating >= 3 ? `${RATING_LABELS[rating]} on this rung. ${climb}` : nextStep;
			const moved = !retry && !followUp && !check;
			// Graduation, and a lapse out of mature (consolidation plan §4, C2).
			const matured = moved && before && after && before.stage !== "mature" && after.stage === "mature";
			const lapsed = moved && before && after && before.stage === "mature" && after.stage === "relearning";
			return ok({
				ok: true, rating: RATING_LABELS[rating], kind: attempt.role, ...(nextDue ? { nextDue } : {}),
				...(after?.daysTo90 != null ? { stability: Math.round(after.daysTo90 * 10) / 10, stage: after.stage } : {}),
				...(after ? { depthMissing: after.depthMissing } : {}),
				...(input.confusedWith ? { linked: `${itemId} and ${input.confusedWith} are now marked confusable: consolidation will study them together and ask a contrast question.` } : {}),
				...(matured ? { matured: `This item is now mature (stability ≥ ${MATURE_STABILITY_DAYS} days): from here on it is reviewed, not consolidated. Say so in the closing summary.` } : {}),
				...(lapsed ? { lapsed: "This mature item lapsed: it is now relearning, and the next consolidation sitting takes it (at the earliest tomorrow). Say so in the closing summary." } : {}),
				retries: { waiting: queue.waiting, ready: queue.ready },
				instruction,
			});
		},
	};

	return { dueItems, pickItems, recordReview };
}
