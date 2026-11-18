/**
 * Retention mode, phase 2: review sessions — the rating table, the review
 * log, the reviewer's tools and prompt, and the review phase seam.
 * Design: docs/retention-mode-plan.md §5–§6.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { EvidenceRecord, EvidenceStore } from "../src/core/math-evidence.ts";
import { ratingFor, retryQueue, reviewNodeIds, type ReviewEvent, type ReviewStore } from "../src/core/memory/review.ts";
import { phaseAt3Lh } from "../src/core/phases.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { createReviewStore } from "../src/store/memory.ts";
import { createReviewerTools } from "../src/agent/tools.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const record = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
	id: "r", chatId: "teach1", nodeId: "compact", nodeTitle: "Compact subsets", dimension: "K", outcome: "correct",
	hints: 0, note: "stated it", recordedAt: iso(T0), ...over,
});

describe("grade → rating", () => {
	it("follows the plan's table", () => {
		assert.equal(ratingFor({ outcome: "incorrect", hints: 0 }), 1);
		assert.equal(ratingFor({ outcome: "correct", hints: 2 }), 1);
		assert.equal(ratingFor({ outcome: "partial", hints: 0 }), 1, "a partial is load-bearing unless said otherwise");
		assert.equal(ratingFor({ outcome: "partial", hints: 0, loadBearing: false }), 2);
		assert.equal(ratingFor({ outcome: "correct_slow", hints: 0 }), 2);
		assert.equal(ratingFor({ outcome: "correct", hints: 1 }), 2);
		assert.equal(ratingFor({ outcome: "correct", hints: 0 }), 3);
		assert.equal(ratingFor({ outcome: "correct", hints: 0, confidence: 95, elapsedSeconds: 40, expectedSeconds: 60 }), 4);
		assert.equal(ratingFor({ outcome: "correct", hints: 0, confidence: 95, elapsedSeconds: 90, expectedSeconds: 60 }), 3, "slow is not Easy");
		assert.equal(ratingFor({ outcome: "correct", hints: 0, confidence: 80, elapsedSeconds: 10, expectedSeconds: 60 }), 3);
	});
});

describe("review slugs", () => {
	it("uses the node's slug and suffixes repeats", () => {
		assert.deepEqual([...reviewNodeIds(["a#compact", "b#compact", "c#Weird Id!"])], [["compact", "a#compact"], ["compact-2", "b#compact"], ["weird-id", "c#Weird Id!"]]);
	});
});

describe("deferred retries", () => {
	const ev = (itemId: string, minute: number, rating: 1 | 3, kind: "review" | "retry" = "review", over: Partial<ReviewEvent> = {}): ReviewEvent => ({
		id: `${itemId}-${minute}`, itemId, chatId: "rev", at: iso(T0 + minute * 60_000), kind, rating,
		dimension: "K", outcome: rating === 1 ? "incorrect" : "correct", hints: 0, question: "q", note: "n", ...over,
	});
	const picked = ["a", "b", "c", "d"];
	it("an Again waits behind two other first attempts", () => {
		assert.deepEqual(retryQueue([ev("a", 1, 1)], picked), { waiting: ["a"], ready: [], remaining: ["b", "c", "d"] });
		assert.deepEqual(retryQueue([ev("a", 1, 1), ev("b", 2, 3)], picked).waiting, ["a"]);
		assert.deepEqual(retryQueue([ev("a", 1, 1), ev("b", 2, 3), ev("c", 3, 3)], picked).ready, ["a"]);
	});
	it("is ready once nothing else is left, and done once retried", () => {
		const events = [ev("a", 1, 3), ev("b", 2, 3), ev("c", 3, 3), ev("d", 4, 1)];
		assert.deepEqual(retryQueue(events, picked).ready, ["d"]);
		assert.deepEqual(retryQueue([...events, ev("d", 5, 3, "retry")], picked), { waiting: [], ready: [], remaining: [] });
	});
	it("never queues an item the learner said was not consolidated", () => {
		assert.deepEqual(retryQueue([ev("a", 1, 1, "review", { noRetry: true })], picked).waiting, []);
	});
});

describe("review log store", () => {
	const event = (over: Partial<ReviewEvent>): ReviewEvent => ({
		id: "e", itemId: "teach1#compact", chatId: "rev1", at: iso(T0), kind: "review", rating: 3,
		dimension: "K", outcome: "correct", hints: 0, question: "q", note: "n", ...over,
	});
	it("round-trips, skips corrupt lines, and removes by session or seeding session", (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviews-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const file = path.join(dir, "memory", "reviews.jsonl");
		const store = createReviewStore(file);
		assert.deepEqual(store.list(), []);
		store.append(event({ id: "1" }));
		store.append(event({ id: "2", chatId: "rev2", itemId: "teach2#x" }));
		store.append(event({ id: "3", chatId: "rev2" }));
		fs.appendFileSync(file, "not json\n" + JSON.stringify({ ...event({ id: "4" }), rating: 7 }) + "\n");
		assert.deepEqual(store.list().map((e) => e.id), ["1", "2", "3"]);
		assert.equal(store.removeChat("teach1"), 2, "events on items seeded by teach1 go with it");
		assert.deepEqual(store.list().map((e) => e.id), ["2"]);
		assert.equal(store.removeChat("rev2"), 1);
		assert.deepEqual(store.list(), []);
	});
});

describe("reviewer tools", () => {
	function setup(now: number) {
		const evidence: EvidenceRecord[] = [
			record({ id: "a" }), record({ id: "b", dimension: "U" }),
			record({ id: "c", nodeId: "hausdorff", nodeTitle: "Hausdorff" }), record({ id: "d", nodeId: "hausdorff", nodeTitle: "Hausdorff", dimension: "S" }),
			record({ id: "e", nodeId: "fresh", nodeTitle: "Fresh", recordedAt: iso(now - 1000) }), record({ id: "f", nodeId: "fresh", nodeTitle: "Fresh", dimension: "U", recordedAt: iso(now - 1000) }),
		];
		const evidenceStore: EvidenceStore = { exists: () => true, list: () => [...evidence], append: () => {}, replaceAll: () => {}, removeChat: () => 0 };
		const reviews: ReviewEvent[] = [];
		const reviewStore: ReviewStore = { list: () => [...reviews], append: (e) => { reviews.push(e); }, removeChat: () => 0 };
		const teachTree: PlanTree = { nodes: [{ id: "hausdorff", title: "Hausdorff" }, { id: "compact", title: "Compact subsets" }, { id: "fresh", title: "Fresh" }], edges: [{ from: "hausdorff", to: "compact" }], version: 1 } as PlanTree;
		const review = { messages: [] as unknown[], tree: undefined as PlanTree | undefined };
		const chatStore = {
			getChat: (id: string) => (id === "teach1" ? { messages: [], tree: teachTree } : id === "rev1" ? review : undefined),
			listChats: () => [{ id: "teach1", title: "Topology" }],
			saveTree: (_id: string, tree: PlanTree) => { review.tree = tree; },
		};
		const tools = createReviewerTools({ chatId: "rev1", chatStore: chatStore as never, evidenceStore, reviewStore, now: () => now });
		const call = async (name: string, input: unknown, id = "t") => {
			const result = await tools[name]!.execute(id, input as never) as { isError?: boolean; details?: any; content: Array<{ text: string }> };
			return result;
		};
		const answer = (nodeId: string, callId: string) => {
			review.messages.push(
				{ role: "assistant", content: [{ type: "toolCall", id: callId, name: "explain", arguments: { nodeId } }] },
				{ role: "toolResult", toolCallId: callId, toolName: "explain", content: [{ type: "text", text: JSON.stringify({ answer: "…" }) }] },
			);
		};
		return { tools, call, answer, reviews, review };
	}

	it("offers exactly the review toolset", () => {
		const { tools } = setup(T0 + 60 * DAY);
		assert.deepEqual(Object.keys(tools).sort(), ["ask_user_question", "due_items", "explain", "pick_items", "record_review", "search_evidence"]);
	});

	it("due_items ranks a due prerequisite first and leaves fresh items out", async () => {
		const { call } = setup(T0 + 60 * DAY);
		const { details } = await call("due_items", {});
		assert.deepEqual(details.candidates.map((c: { itemId: string }) => c.itemId), ["teach1#hausdorff", "teach1#compact"]);
		assert.equal(details.candidates[0].session, "Topology");
		assert.deepEqual(details.candidates[1].duePrereqs, ["teach1#hausdorff"]);
		assert.equal(details.candidates[0].firstReview, true, "never reviewed: the first question goes to a credited dimension");
	});

	it("pick_items writes the session map with prerequisite edges, and refuses items not due", async () => {
		const { call, review } = setup(T0 + 60 * DAY);
		const refused = await call("pick_items", { itemIds: ["teach1#fresh"] });
		assert.equal(refused.isError, true);
		const picked = await call("pick_items", { itemIds: ["teach1#hausdorff", "teach1#compact"] });
		assert.equal(picked.isError, undefined);
		assert.deepEqual(review.tree!.nodes.map((n) => n.id), ["hausdorff", "compact"]);
		assert.deepEqual(review.tree!.edges, [{ from: "hausdorff", to: "compact" }]);
		const forced = await call("pick_items", { itemIds: ["teach1#fresh"], override: true });
		assert.equal(forced.isError, undefined);
	});

	it("record_review defers an Again's retry behind other items", async () => {
		const { call, answer } = setup(T0 + 60 * DAY);
		await call("pick_items", { itemIds: ["teach1#hausdorff", "teach1#compact"] });
		answer("hausdorff", "x1");
		const again = await call("record_review", { nodeId: "hausdorff", dimension: "K", outcome: "incorrect", hints: 0, question: "q1", note: "n" }, "g1");
		assert.match(again.details.instruction, /do NOT retry yet/);
		assert.deepEqual(again.details.retries, { waiting: ["hausdorff"], ready: [] });
		answer("compact", "x2");
		const next = await call("record_review", { nodeId: "compact", dimension: "K", outcome: "correct", hints: 0, question: "q2", note: "n" }, "g2");
		assert.match(next.details.instruction, /deferred retry on hausdorff/, "nothing else is left, so the retry is ready");
	});

	it("record_review: needs a pick and an attempt; the first attempt moves the schedule, later ones are retries", async () => {
		const { call, answer, reviews } = setup(T0 + 60 * DAY);
		const grade = { nodeId: "compact", dimension: "P", outcome: "partial", hints: 0, question: "Prove compact ⊂ Hausdorff is closed", note: "asserted disjointness" };
		assert.equal((await call("record_review", grade)).isError, true, "no pick yet");
		await call("pick_items", { itemIds: ["teach1#compact"] });
		assert.equal((await call("record_review", { ...grade, outcome: "correct" })).isError, true, "correct needs a submitted attempt");
		answer("compact", "x1");
		const first = await call("record_review", grade, "g1");
		assert.equal(first.details.rating, "Again");
		assert.equal(first.details.kind, "review");
		assert.match(first.details.instruction, /DIFFERENT question/);
		assert.ok(Date.parse(first.details.nextDue) >= T0 + 61 * DAY - 1000);
		const retry = await call("record_review", { ...grade, outcome: "correct", question: "State the tube lemma" }, "g2");
		assert.equal(retry.details.kind, "retry");
		assert.deepEqual(reviews.map((e) => [e.kind, e.rating]), [["review", 1], ["retry", 3]]);
		assert.ok(reviews[0]!.predicted! < 0.85);
	});
});

describe("reviewer prompt and phase", () => {
	it("composes its own base and the curated shared appendix, not the teaching base or planning", () => {
		const prompt = composeInstructions("reviewer");
		assert.match(prompt, /You are running a review session/);
		assert.match(prompt, /Never reuse a past question/);
		assert.doesNotMatch(prompt, /plan_init/);
		assert.match(prompt, /Confidence/);
	});

	it("a clean pick_items result ends the review's planning, as probe_done does", () => {
		const messages = [
			{ id: "m1", role: "assistant", content: [{ type: "toolCall", id: "p", name: "pick_items", arguments: { itemIds: ["a#b"] } }] },
			{ id: "m2", role: "toolResult", toolCallId: "p", toolName: "pick_items", content: [{ type: "text", text: "{}" }] },
			{ id: "m3", role: "assistant", content: [{ type: "toolCall", id: "q", name: "explain", arguments: { nodeId: "b" } }] },
		] as unknown as LhMessage[];
		assert.equal(phaseAt3Lh(messages, 0), "probe");
		assert.equal(phaseAt3Lh(messages, 1), "plan");
		assert.equal(phaseAt3Lh(messages, 2), "teach");
		const failed = [{ ...messages[0] }, { ...messages[1], isError: true }] as unknown as LhMessage[];
		assert.equal(phaseAt3Lh(failed), "probe");
	});
});
