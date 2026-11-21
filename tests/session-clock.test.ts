import { test } from "node:test";
import assert from "node:assert/strict";
import { activeMinutes, budgetNodeLimit, daysTo90, intervalDays, memoryStage, MATURE_STABILITY_DAYS, rateFsrs, resumedAfterHours, sessionClock, timeboxDoctrine } from "../src/core/index.ts";

const MIN = 60_000;
const at = (...mins: number[]) => mins.map((m) => ({ timestamp: String(m * MIN) }));

test("active minutes count gaps under 20 minutes and skip breaks", () => {
	assert.equal(activeMinutes(at(0, 5, 10, 60, 70)), 20); // 0→10, a 50-min break, 60→70
	assert.equal(activeMinutes(at(0, 5), 15 * MIN), 15); // the open stretch up to now
	assert.equal(activeMinutes(at(0, 5), 90 * MIN), 5); // now is past a break
});

test("the clock's phase follows the budget", () => {
	assert.equal(sessionClock(at(0, 10), 60, 30 * MIN).phase, "teach");
	assert.deepEqual(sessionClock(at(0, 10, 25, 40, 52), 60, 52 * MIN), { usedMin: 52, budgetMin: 60, leftMin: 8, phase: "converge" });
	assert.equal(sessionClock(at(0, 15, 30, 45, 60), 60, 61 * MIN).phase, "close");
	assert.match(timeboxDoctrine(45), /45 active minutes/);
});

test("items are mature from 21 days to 90% recall", () => {
	assert.equal(memoryStage({ state: null }), "learning");
	const state = rateFsrs(null, 3, 0);
	assert.equal(memoryStage({ state, daysTo90: MATURE_STABILITY_DAYS - 0.1 }), "learning");
	assert.equal(memoryStage({ state, daysTo90: MATURE_STABILITY_DAYS }), "mature");
	// Without a snapshot's daysTo90 it is computed: a first Good is young, an Easy-built history is not.
	assert.equal(memoryStage({ state }), daysTo90(state) >= MATURE_STABILITY_DAYS ? "mature" : "learning");
	assert.equal(memoryStage({ state }), "learning");
	let grown = state;
	for (let i = 0; i < 3; i++) grown = rateFsrs(grown, 4, grown.lastReview + intervalDays(grown, 0.9) * 86_400_000);
	assert.equal(memoryStage({ state: grown }), "mature");
});

test("breaks pause the clock and one extension widens the budget", () => {
	const msgs = at(0, 10, 19, 28);
	assert.equal(Math.round(activeMinutes(msgs, undefined, 20, [[12 * MIN, 19 * MIN]])), 21);
	const c = sessionClock(msgs, 25, 28 * MIN, { extendedMin: 15, breaks: [[28 * MIN, null]] });
	assert.equal(c.budgetMin, 40);
	assert.equal(c.onBreak, true);
	assert.equal(sessionClock(msgs, 25, 28 * MIN, { closedAt: "x" }).phase, "closed");
});

test("a sitting reopened hours later is flagged for a recap", () => {
	assert.equal(resumedAfterHours(at(0, 10), 10 * MIN + 5 * 3_600_000), 5);
	assert.equal(resumedAfterHours(at(0, 10, 10 + 6 * 60), (10 + 6 * 60 + 1) * MIN), 6, "the learner's new message is already in the record");
	assert.equal(resumedAfterHours(at(0, 10), 30 * MIN), null);
});

test("the plan limit scales with the budget", () => {
	assert.equal(budgetNodeLimit(60, true), 3);
	assert.equal(budgetNodeLimit(25, true), 1);
	assert.equal(budgetNodeLimit(60, false), 6);
	assert.match(timeboxDoctrine(45, "consolidate"), /about 3 items/);
});
