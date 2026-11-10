import {
	clampChatLevel,
	effectiveSettings,
	getChat,
	parseSettingsBody,
	stores,
	validateChatSettings,
} from "@/src/server";
import type { ChatSettings } from "@/src/core";
import { TEACHING_PROFILES, type TeachingProfile } from "@/src/core";

/**
 * The per-chat model control (model-control wave): replace-whole settings —
 * the picker sends the complete desired object ({} clears all overrides).
 * PER-SESSION MODELS (owner, 2026-09-28): this route is THE in-session
 * writer — the composer's control binds the session's own record; the
 * strong slot is only the birth default and never reaches an existing
 * session again.
 * Validation is the catalog gate (src/server/model-catalog.ts): unknown
 * provider/model is a 400. Thinking levels never reject (owner,
 * interlude 2026-09-22): a pinned level clamps to the named model's
 * nearest supported and the clamped value is stored. Effective next turn
 * by construction (agents are stateless per turn).
 *
 * The body parsing itself is shared with the draft route
 * (src/server/settings-body.ts, default-settings wave 2026-09-18).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const body = await req.json().catch(() => null);
	const parsed = parseSettingsBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

	const verdict = validateChatSettings(parsed.settings);
	if (!verdict.ok) {
		return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
	}

	// Replace-whole persists the validated, level-clamped object — no
	// merges, so a stale client can never resurrect a cleared override.
	// Clamp-on-write (owner, interlude 2026-09-22): a pinned thinking
	// level never rejects — it clamps to the named model's nearest
	// supported (body model, else the record's strong slot).
	const settings = clampChatLevel(parsed.settings, effectiveSettings().models.strong);
	// The profile has its own writer below; a model pick must not clear it.
	const profile = getChat(id)?.settings?.profile;
	const merged: ChatSettings = profile ? { ...settings, profile } : settings;
	stores.chatStore.saveSettings(id, merged);
	return Response.json({ settings: merged });
}

/** Turns a teaching profile on (name) or off (null) for this session. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind === "practice") return Response.json({ error: "Practice sessions have no teaching profile" }, { status: 400 });
	const body = (await req.json().catch(() => null)) as { profile?: unknown } | null;
	const requested = body?.profile;
	if (requested !== null && !TEACHING_PROFILES.includes(requested as TeachingProfile)) {
		return Response.json({ error: `profile must be null or one of: ${TEACHING_PROFILES.join(", ")}` }, { status: 400 });
	}
	const { profile: _previous, ...rest } = chat.settings ?? {};
	const settings: ChatSettings = requested === null ? rest : { ...rest, profile: requested as TeachingProfile };
	stores.chatStore.saveSettings(id, settings);
	return Response.json({ settings });
}
