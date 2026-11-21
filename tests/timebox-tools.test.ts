import { test } from "node:test";
import assert from "node:assert/strict";
import { timeboxTools } from "../src/agent/tools/timebox.ts";

function setup(messages: unknown[] = []) {
	const chat: any = { id: "c1", messages, tree: { nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }], edges: [] }, settings: { timeboxMin: 60 } };
	const chatStore: any = { getChat: () => chat, saveSettings: (_id: string, s: unknown) => { chat.settings = s; } };
	const tools = timeboxTools({ chatId: "c1", chatStore });
	const call = async (name: string, input: unknown) => {
		const r: any = await tools[name]!.execute("t", input as never);
		return { error: r.isError === true || r.details?.ok === false, text: r.content?.[0]?.text ?? "" };
	};
	return { chat, call };
}

const evidence = (nodeId: string, outcome: string) => [
	{ role: "assistant", content: [{ type: "toolCall", id: `e-${nodeId}`, name: "record_evidence", arguments: { nodeId, dimension: "K", outcome, hints: 0, note: "n" } }] },
	{ role: "toolResult", toolCallId: `e-${nodeId}`, toolName: "record_evidence", content: [{ type: "text", text: "{\"ok\":true}" }], details: { ok: true }, isError: false },
];

test("set_goals needs plan slugs and the learner's agreement to change", async () => {
	const { chat, call } = setup();
	assert.equal((await call("set_goals", { goals: [{ id: "g1", text: "Prove A", nodeIds: ["zz"] }] })).error, true);
	assert.equal((await call("set_goals", { goals: [{ id: "g1", text: "Prove A", nodeIds: ["a"] }] })).error, false);
	assert.equal(chat.settings.timebox.goals[0].status, "open");
	assert.equal((await call("set_goals", { goals: [{ id: "g2", text: "Prove B", nodeIds: ["b"] }] })).error, true);
	assert.equal((await call("set_goals", { goals: [{ id: "g2", text: "Prove B", nodeIds: ["b"] }], learnerAgreed: true })).error, false);
});

test("close_session refuses an unbacked \"met\" and closes with verdicts and a hand-off", async () => {
	const { chat, call } = setup([...evidence("a", "correct"), ...evidence("b", "partial")]);
	await call("set_goals", { goals: [{ id: "g1", text: "Prove A", nodeIds: ["a"] }, { id: "g2", text: "Prove B", nodeIds: ["b"] }] });
	const handoff = "A holds; B fragile (unjustified_step). Next: B from the chart.";
	assert.equal((await call("close_session", { verdicts: [{ goalId: "g1", status: "met" }], handoff })).error, true, "a verdict per goal");
	assert.equal((await call("close_session", { verdicts: [{ goalId: "g1", status: "met" }, { goalId: "g2", status: "met" }], handoff })).error, true, "b has no credited evidence");
	assert.equal((await call("close_session", { verdicts: [{ goalId: "g1", status: "met" }, { goalId: "g2", status: "partial" }], handoff })).error, false);
	assert.ok(chat.settings.timebox.closedAt);
	assert.deepEqual(chat.settings.timebox.goals.map((g: any) => g.status), ["met", "partial"]);
	assert.equal((await call("set_goals", { goals: [{ id: "g3", text: "x y z", nodeIds: ["a"] }], learnerAgreed: true })).error, true, "closed");
});
