interface Env {
	RUNS_BUCKET: R2Bucket;
	ASSETS: Fetcher;

	/** Cloudflare Access team domain (issuer), e.g. "https://qaml.cloudflareaccess.com". */
	CF_ACCESS_TEAM_DOMAIN: string;
	/** Access application AUD tag for the evals hostname. */
	CF_ACCESS_AUD: string;
	/** Set to "0" to disable Access validation (local `wrangler dev` only). */
	CF_ACCESS_ENABLED?: string;
}

declare module "*.md?raw" {
	const text: string;
	export default text;
}
