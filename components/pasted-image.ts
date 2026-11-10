/** Stores a clipboard image on the server and returns its readable path. */
export async function uploadPastedImage(image: Blob): Promise<string> {
	const res = await fetch("/api/pasted-images", { method: "POST", body: image });
	if (!res.ok) throw new Error(`The image could not be saved (${res.status}).`);
	return ((await res.json()) as { path: string }).path;
}
