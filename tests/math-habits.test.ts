import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { mathPlanWarnings, MATH_PLAN_NODE_SOFT_LIMIT, successfulPlanInits } from "../src/agent/tools/plan.ts";
import { evidenceFromMessages, habitsOf, type EvidenceRecord } from "../src/core/math-evidence.ts";
import { createEvidenceStore } from "../src/store/evidence.ts";

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

	it("round-trips tagged ledger records and rejects invalid tags", (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habits-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const file = path.join(dir, "evidence.jsonl");
		const store = createEvidenceStore(file);
		const base: EvidenceRecord = { id: "a", chatId: "c", nodeId: "n", nodeTitle: "N", dimension: "P", outcome: "partial", hints: 0, note: "x", recordedAt: "2026-11-18T00:00:00.000Z" };
		store.append({ ...base, habits: ["backward_only"] });
		fs.appendFileSync(file, `${JSON.stringify({ ...base, id: "b", habits: ["made_up"] })}\n`);
		assert.deepEqual(store.list().map((r) => [r.id, r.habits]), [["a", ["backward_only"]]]);
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
