import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { mathPlanWarnings, MATH_PLAN_NODE_SOFT_LIMIT, successfulPlanInits } from "../src/agent/tools/plan.ts";
import { evidenceFromMessages, habitsOf } from "../src/core/math-evidence.ts";
import type { Attempt } from "../src/core/math-concepts.ts";
import { createMathStore } from "../src/store/math.ts";

describe("math habit tags", () => {
	it("keeps known tags once and drops unknown ones", () => {
		assert.deepEqual(habitsOf(["unjustified_step", "bogus", "unjustified_step", "dropped_term"]), ["unjustified_step", "dropped_term"]);
		assert.equal(habitsOf(["bogus"]), undefined);
		assert.equal(habitsOf("unjustified_step"), undefined);
		assert.equal(habitsOf(undefined), undefined);
	});

	it("reads habits from successful record_evidence calls, absent when untagged", () => {
		const messages = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "t1", name: "record_evidence", arguments: { nodeId: "n", dimension: "P", outcome: "partial", hints: 0, note: "asserted", habits: ["unjustified_step", "nope"] } },
				{ type: "toolCall", id: "t2", name: "record_evidence", arguments: { nodeId: "n", dimension: "K", outcome: "correct", hints: 0, note: "stated" } },
			] },
			{ role: "toolResult", toolCallId: "t1", toolName: "record_evidence", content: [{ type: "text", text: "{}" }] },
			{ role: "toolResult", toolCallId: "t2", toolName: "record_evidence", content: [{ type: "text", text: "{}" }] },
		];
		const [tagged, plain] = evidenceFromMessages(messages);
		assert.deepEqual(tagged!.habits, ["unjustified_step"]);
		assert.equal("habits" in plain!, false);
	});

	it("round-trips tagged attempts and rejects invalid tags", (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const store = createMathStore(dir);
		const base: Attempt = { id: "a", conceptId: "n-concept", chatId: "c", at: "2026-11-18T00:00:00.000Z", source: "teach", role: "attempt", dimension: "P", outcome: "partial", hints: 0, note: "x", rating: 1 };
		store.appendAttempt({ ...base, habits: ["backward_only"] });
		fs.appendFileSync(store.files.attempts, `${JSON.stringify({ ...base, id: "b", habits: ["made_up"] })}\n`);
		assert.deepEqual(store.attempts().map((r) => [r.id, r.habits]), [["a", ["backward_only"]]]);
		assert.throws(() => store.appendAttempt({ ...base, id: "c", habits: ["made_up" as never] }), /invalid attempt/);
	});

	it("puts the habit doctrine in the math teacher only", () => {
		assert.match(composeInstructions("teacher", {}, "math"), /unjustified_step/);
		assert.doesNotMatch(composeInstructions("teacher"), /unjustified_step/);
		assert.doesNotMatch(composeInstructions("prober", {}, "math"), /pre-submit checklist/);
	});
});

describe("math plan scope warnings", () => {
	it("warns past the node limit and from the third map, never blocks", () => {
		assert.deepEqual(mathPlanWarnings(MATH_PLAN_NODE_SOFT_LIMIT, 1), []);
		assert.equal(mathPlanWarnings(MATH_PLAN_NODE_SOFT_LIMIT + 1, 0).length, 1);
		assert.match(mathPlanWarnings(10, 2)[0]!, /map number 3/);
		assert.equal(mathPlanWarnings(30, 3).length, 2);
	});

	it("counts only successful earlier plan_init results", () => {
		const messages = [
			{ role: "toolResult", toolName: "plan_init", details: { ok: true } },
			{ role: "toolResult", toolName: "plan_init", isError: true, details: { ok: true } },
			{ role: "toolResult", toolName: "plan_init", details: { ok: false } },
			{ role: "toolResult", toolName: "explain", details: { ok: true } },
			{ role: "toolResult", toolName: "plan_init", details: { ok: true } },
		];
		assert.equal(successfulPlanInits(messages), 2);
	});
});
