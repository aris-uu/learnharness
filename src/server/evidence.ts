import { backfillEvidence } from "../core/math-evidence.ts";
import { stores } from "./stores.ts";

/** The startup hook (instrumentation.ts): seeds the global evidence ledger
 *  once. A failure leaves no file, so it retries on the next start. */
export function initializeEvidenceLedger(): void {
	try {
		const seeded = backfillEvidence(stores.chatStore, stores.evidenceStore);
		if (seeded !== null) console.info(`[evidence] ledger seeded with ${seeded} record(s) from existing sessions`);
	} catch (error) {
		console.error("[evidence] ledger backfill failed:", error);
	}
}
