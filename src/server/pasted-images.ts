import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

export function pastedImagesDir(): string {
	return path.join(PATHS.data, "pasted-images");
}

/** The extension for real image bytes, or null. The content decides, not a header. */
export function pastedImageExtension(bytes: Uint8Array): "png" | "jpg" | "webp" | "gif" | null {
	const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
	if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
	if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "gif";
	return null;
}

/** Saves a pasted image and returns the absolute path the tutor can read. */
export function savePastedImage(bytes: Uint8Array, extension: string, dir: string = pastedImagesDir()): string {
	fs.mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = path.join(dir, `scratchwork-${stamp}-${randomBytes(3).toString("hex")}.${extension}`);
	fs.writeFileSync(file, bytes, { mode: 0o600 });
	return file;
}
