import type { Run } from "../../src/types";
import type { TranscriptArtifact } from "./transcript";

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}) as { error?: string });
		throw new Response((body as { error?: string }).error ?? `HTTP ${res.status}`, {
			status: res.status,
		});
	}
	return res.json() as Promise<T>;
}

export const fetchRuns = () =>
	getJson<{ runs: Run[] }>("/api/runs?limit=200").then((data) => data.runs ?? []);

export const fetchRun = (id: string) =>
	getJson<Run>(`/api/runs/${encodeURIComponent(id)}`);

export const fetchArtifactNames = (id: string) =>
	getJson<{ artifacts: string[] }>(
		`/api/runs/${encodeURIComponent(id)}/artifacts`,
	).then((data) => data.artifacts ?? []);

export const fetchArtifact = (id: string, name: string) =>
	getJson<TranscriptArtifact>(
		`/api/runs/${encodeURIComponent(id)}/artifact/${encodeURIComponent(name)}`,
	);

export const fetchLog = async (id: string) => {
	const res = await fetch(`/api/runs/${encodeURIComponent(id)}/log`);
	return res.ok ? res.text() : null;
};
