/**
 * Unit tests — the answer timer's pure state (src/core/answer-timer.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	answerTimerElapsedMs,
	answerTimerKey,
	answerTimerSeconds,
	formatElapsed,
	parseStoredAnswerTimer,
	pauseAnswerTimer,
	resetAnswerTimer,
	restoreAnswerTimer,
	resumeAnswerTimer,
	snapshotAnswerTimer,
	startAnswerTimer,
} from "../src/core/index.ts";

describe("answer timer state", () => {
	it("counts from start while running", () => {
		const s = startAnswerTimer(1_000);
		assert.equal(answerTimerElapsedMs(s, 4_500), 3_500);
		assert.equal(answerTimerSeconds(s, 4_500), 3);
	});

	it("paused time never counts", () => {
		let s = startAnswerTimer(0);
		s = pauseAnswerTimer(s, 10_000);
		assert.equal(answerTimerSeconds(s, 600_000), 10, "frozen while paused");
		s = resumeAnswerTimer(s, 600_000);
		assert.equal(answerTimerSeconds(s, 605_000), 15);
	});

	it("pause and resume are idempotent", () => {
		const running = startAnswerTimer(0);
		assert.equal(resumeAnswerTimer(running, 5_000), running);
		const paused = pauseAnswerTimer(running, 2_000);
		assert.equal(pauseAnswerTimer(paused, 9_000), paused);
	});

	it("reset zeroes and keeps the running/paused state", () => {
		const running = resetAnswerTimer(startAnswerTimer(0), 50_000);
		assert.equal(answerTimerSeconds(running, 52_000), 2, "running restarts from the reset");
		const paused = resetAnswerTimer(pauseAnswerTimer(startAnswerTimer(0), 9_000), 50_000);
		assert.equal(paused.runningSince, null, "paused stays paused");
		assert.equal(answerTimerSeconds(paused, 99_000), 0);
	});

	it("restore never counts the time the page was closed", () => {
		const snap = snapshotAnswerTimer(startAnswerTimer(0), 30_000);
		assert.deepEqual(snap, { elapsedMs: 30_000, paused: false, updatedAt: 30_000 });
		const restored = restoreAnswerTimer(snap, 3_600_000);
		assert.equal(answerTimerSeconds(restored, 3_605_000), 35);
		const pausedSnap = snapshotAnswerTimer(pauseAnswerTimer(startAnswerTimer(0), 7_000), 20_000);
		assert.equal(restoreAnswerTimer(pausedSnap, 99_000).runningSince, null);
	});

	it("parses stored snapshots defensively", () => {
		assert.deepEqual(parseStoredAnswerTimer({ elapsedMs: 5, paused: true, updatedAt: 1 }), { elapsedMs: 5, paused: true, updatedAt: 1 });
		assert.equal(parseStoredAnswerTimer(null), undefined);
		assert.equal(parseStoredAnswerTimer({ elapsedMs: -1, paused: true, updatedAt: 1 }), undefined);
		assert.equal(parseStoredAnswerTimer({ elapsedMs: 5, paused: "no", updatedAt: 1 }), undefined);
		assert.equal(parseStoredAnswerTimer({ elapsedMs: 5, paused: false }), undefined);
	});

	it("keys by toolCallId", () => {
		assert.equal(answerTimerKey("call_1"), "lh:answer-timer:call_1");
	});
});

describe("formatElapsed", () => {
	it("m:ss under an hour, h:mm:ss from an hour on", () => {
		assert.equal(formatElapsed(0), "0:00");
		assert.equal(formatElapsed(83), "1:23");
		assert.equal(formatElapsed(599), "9:59");
		assert.equal(formatElapsed(3_599), "59:59");
		assert.equal(formatElapsed(3_600), "1:00:00");
		assert.equal(formatElapsed(3_725), "1:02:05");
		assert.equal(formatElapsed(-4), "0:00");
	});
});
