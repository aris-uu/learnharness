/**
 * THE REVIEWER'S TOOLS (retention mode, phase 2 — 2026-11-18): a review
 * session picks due memory items, asks a fresh written question on each,
 * and records a graded attempt that moves the item's forgetting curve.
 * No plan_init, no mastery gate, no graph writes. The picked items become
 * this session's plan map, so `explain` keeps its nodeId contract and the
 * plan panel shows the session. Design: docs/retention-mode-plan.md §5–§6.
 */
import { MATURE_STABILITY_DAYS, memoryStage } from "../../core/memory/items.ts";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { attemptedNodes, habitsOf, MATH_DIMENSIONS, MATH_HABITS, type EvidenceStore, type MathDimension } from "../../core/math-evidence.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { createTree } from "../../core/plan-tree.ts";
import type { PlanEdge, PlanTree } from "../../core/contracts/plan.ts";
import { retrievabilityAt, type FsrsWeightsStore } from "../../core/memory/fsrs.ts";
import { DEFAULT_DESIRED_RETENTION, itemKeys, memoryItems, memorySnapshot, trainingItems } from "../../core/memory/items.ts";
import { isCourseId, type CourseStore } from "../../core/course.ts";
import { RATING_LABELS, ratingFor, REVIEW_CHECKS, REVIEW_OUTCOMES, MAX_FOLLOW_UPS, retryQueue, RETRY_GAP, reviewCandidates, reviewNodeIds, type ReviewEvent, type ReviewStore } from "../../core/memory/review.ts";
import { invalidInputResult } from "../tool-execute.ts";
import { minutesIntoSitting } from "../../core/session-clock.ts";
import type { PlanToolContext } from "./plan.ts";

export const DUE_ITEMS_TOOL = "due_items";
export const PICK_ITEMS_TOOL = "pick_items";
export const RECORD_REVIEW_TOOL = "record_review";
/** How many items a session picks by default (about 30 minutes). */
export const REVIEW_SESSION_ITEMS = 6;
const MAX_PICK = 12;

export type ReviewToolContext = Pick<PlanToolContext, "chatId" | "chatStore"> & {
	evidenceStore: EvidenceStore;
	reviewStore: ReviewStore;
	/** Fitted FSRS weights (absent: defaults) and the refit after each graded review. */
	weightsStore?: FsrsWeightsStore;
	/** Courses, for a course item's prerequisite edges. */
	courseStore?: CourseStore;
	now?: () => number;
};

const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const ok = (details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });

const dueItemsInput = Type.Object({
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "How many candidates to list. Default 15." })),
});

const pickItemsInput = Type.Object({
	itemIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: MAX_PICK, description: "Item ids from due_items, in the order you will review them." }),
	reasons: Type.Optional(Type.String({ description: "One line on why these, in this order." })),
	override: Type.Optional(Type.Boolean({ description: "Allow ids that are not currently due (only when the learner asked for them)." })),
});

const recordReviewInput = Type.Object({
	nodeId: Type.String({ description: "The picked item's slug in this session's map (from pick_items)." }),
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
	followUp: Type.Optional(Type.Boolean({ description: "This answers a harder rung asked after a clean answer on the same item (the easy-to-hard ladder). Logged; a failed one (Hard or Again) lowers the item's first attempt one step (Easy → Good, Good → Hard)." })),
	check: Type.Optional(Type.Union(REVIEW_CHECKS.map((value) => Type.Literal(value)), { description: "Log-only answers on an item that already had its first attempt here. \"repair\": the learner's rebuild right after you repaired a failed rung. \"close\": the sitting's blank-page retrieval on this item. Never moves the schedule and is never the deferred retry." })),
	noRetry: Type.Optional(Type.Boolean({ description: "The learner said this was never consolidated (or asked to skip it): no retry; it goes to a teach session instead." })),
});

/** The item behind each slug of this session's map, from the last successful pick_items call. */
export function pickedItems(messages: readonly unknown[]): Map<string, string> | null {
	const ok = new Set<string>();
	for (const message of messages as Array<{ role?: string; toolName?: string; toolCallId?: string; isError?: boolean }>) {
		if (message.role === "toolResult" && message.toolName === PICK_ITEMS_TOOL && !message.isError) ok.add(message.toolCallId!);
	}
	let latest: string[] | null = null;
	for (const message of messages as Array<{ role?: string; content?: unknown }>) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Array<{ type?: string; id?: string; name?: string; arguments?: { itemIds?: unknown } }>) {
			if (block.type === "toolCall" && block.name === PICK_ITEMS_TOOL && ok.has(block.id!) && Array.isArray(block.arguments?.itemIds)) {
				latest = block.arguments.itemIds.filter((id): id is string => typeof id === "string");
			}
		}
	}
	return latest ? reviewNodeIds(latest) : null;
}

export function reviewTools(ctx: ReviewToolContext) {
	const now = ctx.now ?? Date.now;
	// pick_items made during this run, before the record holds the call.
	let thisRunPicks: Map<string, string> | null = null;
	const record = () => ctx.chatStore.getChat(ctx.chatId);
	const picks = () => thisRunPicks ?? pickedItems((record()?.messages ?? []) as LhMessage[]);
	const titles = () => new Map(ctx.chatStore.listChats().map((chat) => [chat.id, chat.title]));
	// A course item's prerequisites come from the course map (docs/course-plans-plan.md §8).
	const edgesOf = (owner: string): readonly PlanEdge[] => isCourseId(owner) ? ctx.courseStore?.get(owner)?.map.edges ?? [] : ctx.chatStore.getChat(owner)?.tree?.edges ?? [];
	const candidatesNow = (limit?: number) => {
		const records = ctx.evidenceStore.list();
		const reviews = ctx.reviewStore.list();
		const t = now();
		const names = titles();
		return reviewCandidates({
			snapshot: memorySnapshot(records, t, { reviews, weights: ctx.weightsStore?.read() }),
			records, reviews, edgesOf, nowMs: t, limit,
			// Review is for mature items; a consolidation sitting takes the ones still in learning.
			stage: record()?.settings?.consolidate ? "learning" : "mature",
			sessionTitle: (chatId) => names.get(chatId) ?? chatId,
		});
	};

	const dueItems: AgentTool<typeof dueItemsInput> = {
		name: DUE_ITEMS_TOOL,
		label: DUE_ITEMS_TOOL,
		description:
			"List the memory items that are due, ranked: prerequisites of other due items first, then lowest recall. " +
			"Each gives its id, title, session, recall now (null = only ever assumed), days overdue, stability, credited dimensions, " +
			"the last attempts with their questions and notes (never repeat one), habit tags, and prerequisites that are also due. Read only.",
		parameters: dueItemsInput,
		execute: async (_id, input) => {
			const candidates = candidatesNow(input.limit);
			return ok({ count: candidates.length, sessionSize: REVIEW_SESSION_ITEMS, candidates });
		},
	};

	const pickItems: AgentTool<typeof pickItemsInput> = {
		name: PICK_ITEMS_TOOL,
		label: PICK_ITEMS_TOOL,
		description:
			`Choose this session's items (default ${REVIEW_SESSION_ITEMS}) from due_items, in review order: interleave topics, and put a prerequisite before its dependent. ` +
			"The picks become this session's map; tag each question with the slug it returns. Call it again to change the selection.",
		parameters: pickItemsInput,
		executionMode: "sequential",
		execute: async (_id, input) => {
			const ids = [...new Set(input.itemIds)];
			const records = ctx.evidenceStore.list();
			const snapshot = memorySnapshot(records, now(), { reviews: ctx.reviewStore.list(), weights: ctx.weightsStore?.read() });
			const byId = new Map(snapshot.map((item) => [item.id, item]));
			const unknown = ids.filter((id) => !byId.has(id));
			if (unknown.length) return invalidInputResult(PICK_ITEMS_TOOL, [`No memory item has id ${unknown.join(", ")}. Copy ids from due_items exactly.`]);
			const notDue = ids.filter((id) => !byId.get(id)!.due);
			if (notDue.length && !input.override) {
				return invalidInputResult(PICK_ITEMS_TOOL, [`Not due: ${notDue.join(", ")}. Pick due items, or set override only when the learner asked for these.`]);
			}
			const slugs = reviewNodeIds(ids);
			const slugOf = new Map([...slugs].map(([slug, itemId]) => [itemId, slug]));
			const nodes = [...slugs].map(([slug, itemId]) => {
				const item = byId.get(itemId)!;
				return { id: slug, title: item.title, ...(item.summary ? { summary: item.summary } : {}) };
			});
			const edges: PlanEdge[] = [];
			for (const itemId of ids) {
				const item = byId.get(itemId)!;
				const owner = item.courseId ?? item.chatId;
				for (const edge of edgesOf(owner)) {
					const from = slugOf.get(`${owner}#${edge.from}`);
					if (edge.to === item.nodeId && from) edges.push({ from, to: slugOf.get(itemId)! });
				}
			}
			let tree: PlanTree;
			try { tree = createTree(nodes, edges); }
			catch (error) { return invalidInputResult(PICK_ITEMS_TOOL, [(error as Error).message]); }
			ctx.chatStore.saveTree(ctx.chatId, tree);
			thisRunPicks = slugs;
			return ok({ ok: true, items: [...slugs].map(([nodeId, itemId]) => ({ nodeId, itemId, title: byId.get(itemId)!.title })) });
		},
	};

	const recordReview: AgentTool<typeof recordReviewInput> = {
		name: RECORD_REVIEW_TOOL,
		label: RECORD_REVIEW_TOOL,
		description:
			"Grade the learner's written answer on a picked item. Report the outcome; the server sets the FSRS rating " +
			"(incorrect, 2+ hints, or a load-bearing partial = Again; other partial, slow or 1 hint = Hard; clean = Good; clean, fast and ≥90% confident = Easy). " +
			"Only the first attempt on an item in a session moves its schedule; later ones are logged as retries, follow-ups (followUp) or checks (check: repair / close). After an Again the retry is deferred behind other items. Returns the rating, the next due date, the retry queue and what to do next.",
		parameters: recordReviewInput,
		executionMode: "sequential",
		execute: async (toolCallId, input) => {
			const itemId = picks()?.get(input.nodeId);
			if (!itemId) return invalidInputResult(RECORD_REVIEW_TOOL, [`nodeId "${input.nodeId}" is not a picked item. Call pick_items first, then use its slugs.`]);
			const messages = (record()?.messages ?? []) as LhMessage[];
			if ((input.outcome === "correct" || input.outcome === "correct_slow") && !attemptedNodes(messages).has(input.nodeId)) {
				return invalidInputResult(RECORD_REVIEW_TOOL, [`No submitted written attempt exists on ${input.nodeId}, so it cannot be graded correct.`]);
			}
			const reviews = ctx.reviewStore.list();
			const t = now();
			const onItem = reviews.filter((e) => e.chatId === ctx.chatId && itemKeys().itemId(e.itemId) === itemId);
			const ladder = onItem.filter((e) => e.kind === "review" || e.kind === "followup");
			if (input.check) {
				const problem = input.followUp
					? "pass either check or followUp, not both"
					: !onItem.some((e) => e.kind === "review")
						? "a check needs a graded first attempt on this item in this sitting; grade the first attempt without check first"
						: undefined;
				if (problem) return invalidInputResult(RECORD_REVIEW_TOOL, [`check on ${input.nodeId}: ${problem}.`]);
			}
			if (input.followUp) {
				const problem = !onItem.some((e) => e.kind === "review")
					? "a follow-up needs a graded first attempt on this item; grade the easy rung without followUp first"
					: ladder.at(-1)!.rating < 3
						? "climb only after a clean answer: the last rung on this item was not Good or Easy. If this answers your repair's rebuild question, record it with check: \"repair\" instead"
						: onItem.filter((e) => e.kind === "followup").length >= MAX_FOLLOW_UPS
							? `at most ${MAX_FOLLOW_UPS} follow-ups per item; move on`
							: undefined;
				if (problem) return invalidInputResult(RECORD_REVIEW_TOOL, [`followUp on ${input.nodeId}: ${problem}.`]);
			}
			const weights = ctx.weightsStore?.read();
			const before = memorySnapshot(ctx.evidenceStore.list(), t, { reviews, weights }).find((item) => item.id === itemId);
			const followUp = input.followUp === true;
			const check = input.check;
			const retry = !followUp && !check && onItem.length > 0;
			// NOTHING TO INTERLEAVE (owner, 2026-11-19): an Again on the last
			// first attempt, with no other retry still owed, would be retried
			// straight after its repair, which measures the repair. Skip it:
			// the item is due again within a day, and that review is the retry.
			const sessionSoFar = reviews.filter((e) => e.chatId === ctx.chatId);
			const queueBefore = retryQueue(sessionSoFar, [...(picks()?.values() ?? [])]);
			const lastFirst = !followUp && !check && !retry && queueBefore.remaining.length === 1 && queueBefore.remaining[0] === itemId;
			const nothingToInterleave = lastFirst && queueBefore.waiting.length === 0 && queueBefore.ready.length === 0;
			const rating = ratingFor(input);
			const habits = habitsOf(input.habits);
			const event: ReviewEvent = {
				id: toolCallId, itemId, chatId: ctx.chatId, at: new Date(t).toISOString(),
				kind: check ? "check" : followUp ? "followup" : retry ? "retry" : "review", rating,
				...(check ? { check } : {}),
				dimension: input.dimension as MathDimension, outcome: input.outcome, hints: input.hints,
				...(input.loadBearing !== undefined ? { loadBearing: input.loadBearing } : {}),
				...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
				...(input.elapsedSeconds !== undefined ? { elapsedSeconds: input.elapsedSeconds } : {}),
				...(input.expectedSeconds !== undefined ? { expectedSeconds: input.expectedSeconds } : {}),
				question: input.question, note: input.note,
				...(habits ? { habits } : {}),
				...(!check && (input.noRetry || nothingToInterleave) && rating === 1 ? { noRetry: true } : {}),
				minutesIn: minutesIntoSitting(messages, t, record()?.settings),
				...(before?.state ? { predicted: Math.round(retrievabilityAt(before.state, t, weights) * 1000) / 1000 } : {}),
			};
			ctx.reviewStore.append(event);
			const records = ctx.evidenceStore.list();
			// Refit FSRS to the grown log (docs/fsrs7-plan.md): fire-and-forget,
			// gated in core/memory/fit.ts; new weights apply from the next read.
			if (ctx.weightsStore && !check) void ctx.weightsStore.refit(trainingItems(memoryItems(records, [...reviews, event])));
			const after = memorySnapshot(records, t, { reviews: [...reviews, event], weights }).find((item) => item.id === itemId);
			// The item's own due date (last schedule-moving rating, 1-day floor), so a retry or follow-up reports the same date as the first attempt.
			const nextDue = after?.state ? after.dueAt : undefined;
			const slugs = picks()!;
			const slugOf = new Map([...slugs].map(([slug, id]) => [id, slug]));
			const queue = retryQueue([...reviews, event].filter((e) => e.chatId === ctx.chatId), [...slugs.values()]);
			const names = (ids: readonly string[]) => ids.map((id) => slugOf.get(id) ?? id).join(", ");
			const consolidating = record()?.settings?.consolidate === true;
			const closeChecked = new Set([...reviews, event].filter((e) => e.chatId === ctx.chatId && e.kind === "check" && e.check === "close").map((e) => e.itemId));
			const attemptedHere = [...new Set([...reviews, event].filter((e) => e.chatId === ctx.chatId && e.kind === "review").map((e) => e.itemId))];
			const closeOwed = attemptedHere.filter((id) => !closeChecked.has(id));
			const closeStep = consolidating && closeOwed.length
				? `Before the closing summary, the close: one blank-page retrieval per item, written from scratch with nothing on screen (state the item's central statement or step again), each graded with record_review and check: "close". Still owed on: ${names(closeOwed)}. `
				: "";
			const nextStep = queue.ready.length
				? `Now ask the deferred retry on ${names(queue.ready.slice(0, 1))}: a DIFFERENT question from both earlier ones, at the same rung as the one that failed (for a stale item, another plain K question), with no reminder of the repair.`
				: queue.remaining.length
					? "Move to the next item."
					: record()?.settings?.timeboxMin
						? `All items and retries are done. ${closeStep}Then give the closing summary and call close_session with the hand-off (verdicts: []). The sitting is not closed until close_session succeeds.`
						: `All items and retries are done. ${closeStep}Then close the session.`;
			const followUpsLeft = MAX_FOLLOW_UPS - onItem.filter((e) => e.kind === "followup").length - (followUp ? 1 : 0);
			const climb = `You may climb one rung: a harder question on this item (U or S, then a P step), graded with followUp: true; it does not move the schedule. Otherwise: ${nextStep}`;
			const instruction = check
				? `${check === "repair" ? "Repair check" : "Close check"} logged (never moves the schedule, and it is not the retry). ${nextStep}`
				: followUp
				? rating >= 3
					? followUpsLeft > 0 ? `Follow-up held (logged, not scheduled). ${climb}` : `Follow-up held (logged, not scheduled). ${nextStep}`
					: `The harder rung slipped. It gets no retry, and it lowers this item's first attempt one step, so the item comes back sooner: say in one line what was missing, then: ${nextStep}`
				: retry
				? rating === 1
					? `The retry also failed. Stop drilling this item: note it for a teach session (offer it in the closing summary). ${nextStep}`
					: `Retry logged; it does not move the schedule. ${nextStep}`
				: rating === 1 && event.noRetry && !input.noRetry
					? `Again: give one short repair aimed at the exact gap, but no retry. Nothing is left to interleave, so a retry now would only test the repair; the item comes back in the next review. ${nextStep}`
					: rating === 1 && event.noRetry
					? `No retry: the learner says this isn't consolidated. Give at most a one-line pointer, note it for a teach session in the closing summary, and move on. ${nextStep}`
					: rating === 1
					? queue.ready[0] === itemId
						? "Again: give one short repair aimed at the exact gap. Nothing is left to interleave, so then ask the retry: a DIFFERENT question about this item."
						: `Again: give one short repair aimed at the exact gap now, but do NOT retry yet. The retry waits until ${RETRY_GAP} other items have been asked (or until none are left), so it tests retrieval rather than the repair you just gave. Then: ${nextStep}`
					: rating >= 3 ? `${RATING_LABELS[rating]} on this rung. ${climb}` : nextStep;
			// Graduation (consolidation plan §4): a first attempt that lifts stability past the mature line.
			const matured = !retry && !followUp && !check && before && after && memoryStage(before) === "learning" && memoryStage(after) === "mature";
			return ok({
				ok: true, rating: RATING_LABELS[rating], kind: event.kind, ...(nextDue ? { nextDue } : {}),
				...(after?.daysTo90 != null ? { stability: Math.round(after.daysTo90 * 10) / 10, stage: memoryStage(after) } : {}),
				...(matured ? { matured: `This item is now mature (stability ≥ ${MATURE_STABILITY_DAYS} days): from here on it is reviewed, not consolidated. Say so in the closing summary.` } : {}),
				retries: { waiting: queue.waiting.map((id) => slugOf.get(id) ?? id), ready: queue.ready.map((id) => slugOf.get(id) ?? id) },
				instruction,
			});
		},
	};

	return { dueItems, pickItems, recordReview };
}
