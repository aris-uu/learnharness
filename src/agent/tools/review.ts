/**
 * THE REVIEWER'S TOOLS (retention mode, phase 2 — 2026-11-18): a review
 * session picks due memory items, asks a fresh written question on each,
 * and records a graded attempt that moves the item's forgetting curve.
 * No plan_init, no mastery gate, no graph writes. The picked items become
 * this session's plan map, so `explain` keeps its nodeId contract and the
 * plan panel shows the session. Design: docs/retention-mode-plan.md §5–§6.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { attemptedNodes, habitsOf, MATH_DIMENSIONS, MATH_HABITS, type EvidenceStore, type MathDimension } from "../../core/math-evidence.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { createTree } from "../../core/plan-tree.ts";
import type { PlanEdge, PlanTree } from "../../core/contracts/plan.ts";
import { dueAt, retrievabilityAt } from "../../core/memory/fsrs.ts";
import { DEFAULT_DESIRED_RETENTION, memorySnapshot } from "../../core/memory/items.ts";
import { RATING_LABELS, ratingFor, REVIEW_OUTCOMES, MAX_FOLLOW_UPS, retryQueue, RETRY_GAP, reviewCandidates, reviewNodeIds, type ReviewEvent, type ReviewStore } from "../../core/memory/review.ts";
import { invalidInputResult } from "../tool-execute.ts";
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
	followUp: Type.Optional(Type.Boolean({ description: "This answers a harder rung asked after a clean answer on the same item (the easy-to-hard ladder). Logged; it does not move the schedule." })),
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
	const edgesOf = (chatId: string): readonly PlanEdge[] => ctx.chatStore.getChat(chatId)?.tree?.edges ?? [];
	const candidatesNow = (limit?: number) => {
		const records = ctx.evidenceStore.list();
		const reviews = ctx.reviewStore.list();
		const t = now();
		const names = titles();
		return reviewCandidates({
			snapshot: memorySnapshot(records, t, { reviews }),
			records, reviews, edgesOf, nowMs: t, limit,
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
			const snapshot = memorySnapshot(records, now(), { reviews: ctx.reviewStore.list() });
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
				for (const edge of edgesOf(item.chatId)) {
					const from = slugOf.get(`${item.chatId}#${edge.from}`);
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
			"Only the first attempt on an item in a session moves its schedule; later ones are logged as retries. After an Again the retry is deferred behind other items. Returns the rating, the next due date, the retry queue and what to do next.",
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
			const onItem = reviews.filter((e) => e.chatId === ctx.chatId && e.itemId === itemId);
			const ladder = onItem.filter((e) => e.kind === "review" || e.kind === "followup");
			if (input.followUp) {
				const problem = !onItem.some((e) => e.kind === "review")
					? "a follow-up needs a graded first attempt on this item; grade the easy rung without followUp first"
					: ladder.at(-1)!.rating < 3
						? "climb only after a clean answer: the last rung on this item was not Good or Easy"
						: onItem.filter((e) => e.kind === "followup").length >= MAX_FOLLOW_UPS
							? `at most ${MAX_FOLLOW_UPS} follow-ups per item; move on`
							: undefined;
				if (problem) return invalidInputResult(RECORD_REVIEW_TOOL, [`followUp on ${input.nodeId}: ${problem}.`]);
			}
			const before = memorySnapshot(ctx.evidenceStore.list(), t, { reviews }).find((item) => item.id === itemId);
			const followUp = input.followUp === true;
			const retry = !followUp && onItem.length > 0;
			// NOTHING TO INTERLEAVE (owner, 2026-11-19): an Again on the last
			// first attempt, with no other retry still owed, would be retried
			// straight after its repair, which measures the repair. Skip it:
			// the item is due again within a day, and that review is the retry.
			const sessionSoFar = reviews.filter((e) => e.chatId === ctx.chatId);
			const queueBefore = retryQueue(sessionSoFar, [...(picks()?.values() ?? [])]);
			const lastFirst = !followUp && !retry && queueBefore.remaining.length === 1 && queueBefore.remaining[0] === itemId;
			const nothingToInterleave = lastFirst && queueBefore.waiting.length === 0 && queueBefore.ready.length === 0;
			const rating = ratingFor(input);
			const habits = habitsOf(input.habits);
			const event: ReviewEvent = {
				id: toolCallId, itemId, chatId: ctx.chatId, at: new Date(t).toISOString(),
				kind: followUp ? "followup" : retry ? "retry" : "review", rating,
				dimension: input.dimension as MathDimension, outcome: input.outcome, hints: input.hints,
				...(input.loadBearing !== undefined ? { loadBearing: input.loadBearing } : {}),
				...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
				...(input.elapsedSeconds !== undefined ? { elapsedSeconds: input.elapsedSeconds } : {}),
				...(input.expectedSeconds !== undefined ? { expectedSeconds: input.expectedSeconds } : {}),
				question: input.question, note: input.note,
				...(habits ? { habits } : {}),
				...((input.noRetry || nothingToInterleave) && rating === 1 ? { noRetry: true } : {}),
				...(before?.state ? { predicted: Math.round(retrievabilityAt(before.state, t) * 1000) / 1000 } : {}),
			};
			ctx.reviewStore.append(event);
			const after = memorySnapshot(ctx.evidenceStore.list(), t, { reviews: [...reviews, event] }).find((item) => item.id === itemId);
			const nextDue = after?.state ? new Date(dueAt(after.state, DEFAULT_DESIRED_RETENTION, retry || followUp ? undefined : rating)).toISOString() : undefined;
			const slugs = picks()!;
			const slugOf = new Map([...slugs].map(([slug, id]) => [id, slug]));
			const queue = retryQueue([...reviews, event].filter((e) => e.chatId === ctx.chatId), [...slugs.values()]);
			const names = (ids: readonly string[]) => ids.map((id) => slugOf.get(id) ?? id).join(", ");
			const nextStep = queue.ready.length
				? `Now ask the deferred retry on ${names(queue.ready.slice(0, 1))}: a DIFFERENT question from both earlier ones, at the same rung as the one that failed (for a stale item, another plain K question), with no reminder of the repair.`
				: queue.remaining.length
					? "Move to the next item."
					: "All items and retries are done: close the session.";
			const followUpsLeft = MAX_FOLLOW_UPS - onItem.filter((e) => e.kind === "followup").length - (followUp ? 1 : 0);
			const climb = `You may climb one rung: a harder question on this item (U or S, then a P step), graded with followUp: true; it does not move the schedule. Otherwise: ${nextStep}`;
			const instruction = followUp
				? rating >= 3
					? followUpsLeft > 0 ? `Follow-up held (logged, not scheduled). ${climb}` : `Follow-up held (logged, not scheduled). ${nextStep}`
					: `The harder rung slipped. It does not move the schedule and gets no retry: say in one line what was missing, then: ${nextStep}`
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
			return ok({
				ok: true, rating: RATING_LABELS[rating], kind: event.kind, ...(nextDue ? { nextDue } : {}),
				retries: { waiting: queue.waiting.map((id) => slugOf.get(id) ?? id), ready: queue.ready.map((id) => slugOf.get(id) ?? id) },
				instruction,
			});
		},
	};

	return { dueItems, pickItems, recordReview };
}
