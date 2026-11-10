import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { answerForPresentation } from "../src/core/answer-presentation.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import {
	attemptedNodes,
	blockingPrerequisites,
	evidenceFromMessages,
	goBackMessage,
	mathPitch,
	nodeStatus,
	prerequisiteChain,
	type MathEvidence,
	type MathOutcome,
} from "../src/core/math-evidence.ts";
import { pastedImageExtension, savePastedImage } from "../src/server/pasted-images.ts";
import { allSegmentPaths, effectiveProfileSegments } from "../src/agent/prompt-segments.ts";
import { isValidSegmentPath } from "../src/core/prompt-segments.ts";
import { promptOverrides } from "../src/store/prompt-overrides.ts";

const tree = {
	nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }],
	edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
} as never;

let serial = 0;
const entry = (nodeId: string, dimension: MathEvidence["dimension"], outcome: MathOutcome, hints = 0): MathEvidence =>
	({ id: `e${serial++}`, nodeId, dimension, outcome, hints, note: "n" });

describe("math profile composition", () => {
	it("replaces conflicting doctrine and adds mastery rules only when on", () => {
		const standard = composeInstructions("teacher");
		const math = composeInstructions("teacher", {}, "math");
		assert.match(standard, /Real definitions/);
		assert.doesNotMatch(standard, /Definitions are earned/);
		assert.doesNotMatch(math, /Real definitions/);
		assert.match(math, /Definitions are earned/);
		assert.match(math, /record_evidence/);
		assert.ok(math.indexOf("Mastery and the map") < math.indexOf("The question tools"), "shared mechanics stay last");
	});
	it("gives the prober written-only doctrine", () => {
		const math = composeInstructions("prober", {}, "math");
		assert.match(math, /exposure only/);
		assert.doesNotMatch(math, /Enter near the top/);
	});
	it("lists math segments for Settings and honors their overrides only when switched on", (t) => {
		const key = "profiles/math/teacher/05-method.md";
		assert.equal(isValidSegmentPath(key), true);
		assert.equal(isValidSegmentPath("profiles/math/../../secret.md"), false);
		assert.ok(allSegmentPaths().includes(key));
		const segment = effectiveProfileSegments("math", {}).find((s) => s.path === key);
		assert.match(segment!.sourceText, /Definitions are earned/);
		assert.equal(segment!.enabled, false);
		t.after(() => promptOverrides.deleteOverride(key));
		promptOverrides.writeOverride(key, "MY MATH METHOD");
		assert.doesNotMatch(composeInstructions("teacher", {}, "math"), /MY MATH METHOD/);
		assert.match(composeInstructions("teacher", { [key]: true }, "math"), /MY MATH METHOD/);
	});
	it("leaves practice untouched", () => {
		assert.equal(composeInstructions("practice", {}, "math"), composeInstructions("practice"));
	});
});

describe("mastery evidence", () => {
	it("requires recall plus a deeper dimension", () => {
		assert.equal(nodeStatus("a", []), "none");
		assert.equal(nodeStatus("a", [entry("a", "K", "correct")]), "in_progress");
		assert.equal(nodeStatus("a", [entry("a", "K", "correct"), entry("a", "S", "correct_slow", 1)]), "solid");
	});
	it("treats two hints as exposure and a later miss as reopening", () => {
		assert.equal(nodeStatus("a", [entry("a", "K", "correct"), entry("a", "P", "correct", 2)]), "in_progress");
		assert.equal(nodeStatus("a", [entry("a", "K", "correct"), entry("a", "S", "correct"), entry("a", "S", "incorrect")]), "in_progress");
	});
	it("walks the prerequisite chain nearest first", () => {
		assert.deepEqual(prerequisiteChain(tree, "c"), ["b", "a"]);
	});
	it("gates forward moves but never staying or going back", () => {
		assert.deepEqual(blockingPrerequisites(tree, "b", "a", []), ["a"]);
		assert.deepEqual(blockingPrerequisites(tree, "b", "a", [entry("a", "K", "assumed")]), []);
		assert.deepEqual(blockingPrerequisites(tree, "b", "a", [entry("a", "K", "learner_override")]), []);
		assert.deepEqual(blockingPrerequisites(tree, "a", "c", []), [], "going back");
		assert.deepEqual(blockingPrerequisites(tree, "c", "c", []), [], "staying");
	});
	it("asks for a step down below the band", () => {
		assert.equal(mathPitch([entry("a", "K", "incorrect"), entry("a", "K", "incorrect")]).stepDown, false, "too little data");
		const low = ["correct", "incorrect", "incorrect", "partial"].map((o) => entry("a", "K", o as MathOutcome));
		assert.equal(mathPitch(low).stepDown, true);
		assert.equal(mathPitch(Array.from({ length: 5 }, () => entry("a", "K", "correct"))).stepDown, false);
	});
	it("reads successful calls from the record and real attempts only", () => {
		const call = (id: string, name: string, args: object) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
		const result = (toolCallId: string, toolName: string, text: string, isError = false) => ({ role: "toolResult", toolCallId, toolName, isError, content: [{ type: "text", text }] });
		const good = { nodeId: "a", dimension: "K", outcome: "correct", hints: 0, note: "n" };
		const messages = [
			call("1", "record_evidence", good), result("1", "record_evidence", "{}"),
			call("2", "record_evidence", good), result("2", "record_evidence", "bad", true),
			call("3", "explain", { nodeId: "a" }), result("3", "explain", JSON.stringify({ kind: "explain", text: "attempt" })),
			call("4", "explain", { nodeId: "b" }), result("4", "explain", JSON.stringify({ kind: "explain", dontKnow: true })),
		];
		assert.deepEqual(evidenceFromMessages(messages).map((e) => e.id), ["1"]);
		assert.deepEqual([...attemptedNodes(messages)], ["a"]);
	});
	it("writes a go-back request naming the node", () => {
		assert.match(goBackMessage({ id: "quotient", title: "Quotient topology" }), /"Quotient topology" \(node quotient\)/);
	});
});

describe("math tools", () => {
	const chat = { messages: [] as unknown[], tree };
	const ctx = {
		chatId: "c", chatStore: { getChat: () => chat }, jobStore: {}, spawn: () => {},
		searchAvailable: () => false,
	} as never;
	const explainArgs = { type: "check", nodeId: "a", question: "q", correctAnswer: "a" };

	it("forces written answers and adds evidence only in math mode", () => {
		const math = createTeacherTools(ctx, undefined, "math");
		assert.ok(math.explain && math.record_evidence);
		assert.equal(math.quiz, undefined);
		const standard = createTeacherTools(ctx);
		assert.ok(standard.quiz);
		assert.equal(standard.record_evidence, undefined);
		const prober = createProberTools(ctx, undefined, "math");
		assert.ok(prober.recall);
		assert.equal(prober.probe, undefined);
	});
	it("rejects a revealed answer and a blocked forward move", async () => {
		const tools = createTeacherTools(ctx, undefined, "math");
		const revealed = await tools.explain!.execute("x", explainArgs);
		assert.match(JSON.stringify(revealed), /conceal/);
		const blocked = await tools.explain!.execute("y", { ...explainArgs, nodeId: "b", conceal: true });
		assert.match(JSON.stringify(blocked), /Mastery gate/);
	});
	it("refuses credit without an attempt, and sees this run's evidence at the gate", async () => {
		const tools = createTeacherTools(ctx, undefined, "math");
		const refused = await tools.record_evidence!.execute("r1", { nodeId: "a", dimension: "K", outcome: "correct", hints: 0, note: "n" });
		assert.match(JSON.stringify(refused), /written attempt/);
		await tools.record_evidence!.execute("r2", { nodeId: "a", dimension: "K", outcome: "assumed", hints: 0, note: "probe answer" });
		const passed = await tools.explain!.execute("z", { ...explainArgs, nodeId: "b", conceal: true });
		assert.doesNotMatch(JSON.stringify(passed), /Mastery gate/);
	});
	it("hides a concealed answer on the card", () => {
		const answer = { kind: "explain" } as QuestionAnswerData;
		assert.equal(answerForPresentation(answer, { question: "q", correctAnswer: "secret", conceal: true }).committed, undefined);
		assert.equal(answerForPresentation(answer, { question: "q", correctAnswer: "shown" }).committed, "shown");
	});
});

describe("pasted images", () => {
	it("trusts content, not claims", () => {
		assert.equal(pastedImageExtension(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
		assert.equal(pastedImageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
		assert.equal(pastedImageExtension(new TextEncoder().encode("<script>alert(1)</script>")), null);
	});
	it("saves under the given folder with the given extension", (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pasted-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const saved = savePastedImage(new Uint8Array([1, 2]), "png", path.join(dir, "new"));
		assert.equal(path.extname(saved), ".png");
		assert.deepEqual([...fs.readFileSync(saved)], [1, 2]);
	});
});
