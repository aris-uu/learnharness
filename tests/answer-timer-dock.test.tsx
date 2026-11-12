import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { readAnswerTimerSeconds } from "../components/answer-timer.tsx";
import type { QuestionAnswerData, QuizToolInput } from "../src/core/question-core.ts";

/**
 * The dock's answer timer under a synthetic DOM: starts on first show,
 * pause excludes time, reset zeroes, the submit carries elapsedSeconds,
 * and the stored snapshot resumes a remount (the reload path).
 */

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
const localStorage = {
	get length() { return store.size; },
	key: (i: number) => [...store.keys()][i] ?? null,
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, String(v)),
	removeItem: (k: string) => void store.delete(k),
};
Object.assign(dom.window, { localStorage });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;

const input: QuizToolInput = {
	question: "Pick one",
	options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
	correctAnswer: "yes",
	explanation: "Yes is correct.",
} as QuizToolInput;

const value = (host: HTMLElement) => host.querySelector('[data-testid="answer-timer-value"]')?.textContent ?? null;
const click = async (host: HTMLElement, testId: string) =>
	act(async () => { host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click(); });

test("answer timer: first show, pause/resume, reset, submit, remount resume", async (t) => {
	t.after(() => { Date.now = realNow; });
	const host = document.createElement("div"); document.body.append(host);
	let root = createRoot(host);
	let submitted: QuestionAnswerData | undefined;
	const render = (expanded: boolean) => act(async () => root.render(
		<QuestionDock toolName="quiz" toolCallId="q1" questionKey="key-1" input={input} expanded={expanded}
			onExpand={() => {}} onSubmit={(a) => { submitted = a; }} dictationClaim={false} />,
	));
	try {
		// Not shown yet (e.g. an unrevealed teach check): no timer.
		await render(false);
		assert.equal(value(host), null);
		assert.equal(readAnswerTimerSeconds("key-1"), undefined);

		// First show starts it.
		await render(true);
		assert.equal(value(host), "0:00");
		clock += 83_000;
		await render(true); // re-render reads the latest tick; elapsed is computed at read time
		assert.equal(readAnswerTimerSeconds("key-1"), 83);

		// Paused time never counts.
		await click(host, "answer-timer-toggle");
		assert.match(value(host)!, /^paused 1:23$/);
		clock += 600_000;
		assert.equal(readAnswerTimerSeconds("key-1"), 83);
		await click(host, "answer-timer-toggle");
		clock += 7_000;
		assert.equal(readAnswerTimerSeconds("key-1"), 90);

		// Reset zeroes and keeps running.
		await click(host, "answer-timer-reset");
		assert.equal(value(host), "0:00");
		clock += 5_000;
		assert.equal(readAnswerTimerSeconds("key-1"), 5);

		// Remount (the reload path): the stored snapshot resumes, closed time not counted.
		await act(async () => root.unmount());
		clock += 3_600_000;
		assert.equal(readAnswerTimerSeconds("key-1"), 5, "stored snapshot after unmount");
		root = createRoot(host);
		await render(false); // a stored snapshot resumes even before the dock is expanded
		assert.equal(value(host), "0:05");
		clock += 10_000;
		await render(true);

		// The submit carries the active seconds.
		await act(async () => { host.querySelector<HTMLButtonElement>('[role="radio"]')!.click(); });
		await act(async () => { host.querySelector<HTMLFormElement>("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
		assert.equal(submitted?.elapsedSeconds, 15);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
