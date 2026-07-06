/**
 * Cloudflare Access JWT validation for the eval reports service. Access fronts the
 * evals hostname and stamps each allowed request with a signed JWT in
 * Cf-Access-Jwt-Assertion; we re-validate it at the worker so the API cannot be
 * reached with a bare workers.dev URL or a misconfigured route.
 *
 * Self-contained RS256 verifier modeled on workers/main/src/helpers/proxy-auth-core.ts
 * (WebCrypto + edge-cached JWKS with a kid-miss refetch); kept local so this worker
 * has no dependency on the main worker's auth stack.
 */

interface Jwk extends JsonWebKey {
	kid?: string;
}

/** Keys rotate on the order of weeks; short TTL + kid-miss bypass keeps rotation safe. */
const JWKS_CACHE_TTL_SECONDS = 3600;

export interface AccessConfig {
	/** Team domain, e.g. "https://qaml.cloudflareaccess.com". Also the JWT issuer. */
	teamDomain: string;
	/** Access application AUD tag. */
	aud: string;
}

export interface AccessIdentity {
	email?: string;
	/** Service-token client id (Access sets `common_name` for service-token auth). */
	commonName?: string;
	subject?: string;
}

function base64urlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJwtPart<T>(part: string): T {
	return JSON.parse(new TextDecoder().decode(base64urlDecode(part))) as T;
}

async function loadJwks(
	jwksUrl: string,
	options: { bypassCache: boolean },
): Promise<{ keys?: Jwk[] }> {
	const cache = caches.default;
	if (!options.bypassCache) {
		const cached = await cache.match(jwksUrl);
		if (cached) return (await cached.json()) as { keys?: Jwk[] };
	}
	const response = await fetch(jwksUrl);
	if (!response.ok) {
		throw new Error(`Access certs fetch failed (${response.status})`);
	}
	const body = await response.text();
	await cache.put(
		jwksUrl,
		new Response(body, {
			headers: {
				"content-type": "application/json",
				"cache-control": `public, max-age=${JWKS_CACHE_TTL_SECONDS}`,
			},
		}),
	);
	return JSON.parse(body) as { keys?: Jwk[] };
}

/**
 * Validate the Access JWT on a request. Returns the caller identity, or null when
 * the token is missing or invalid (caller should respond 403).
 */
export async function verifyAccess(
	request: Request,
	config: AccessConfig,
): Promise<AccessIdentity | null> {
	const token = request.headers.get("cf-access-jwt-assertion");
	if (!token) return null;
	try {
		const payload = await verifyAccessJwt(token, config);
		return {
			email: typeof payload.email === "string" ? payload.email : undefined,
			commonName:
				typeof payload.common_name === "string" ? payload.common_name : undefined,
			subject: typeof payload.sub === "string" ? payload.sub : undefined,
		};
	} catch (error) {
		console.warn("Access JWT validation failed:", error);
		return null;
	}
}

async function verifyAccessJwt(
	token: string,
	config: AccessConfig,
): Promise<Record<string, unknown>> {
	const issuer = config.teamDomain.replace(/\/+$/, "");
	if (!issuer || !config.aud) {
		throw new Error("CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are not configured");
	}
	const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
	if (!encodedHeader || !encodedPayload || !encodedSignature) {
		throw new Error("Malformed Access JWT");
	}
	const header = decodeJwtPart<{ alg?: string; kid?: string }>(encodedHeader);
	if (header.alg !== "RS256" || typeof header.kid !== "string") {
		throw new Error("Unsupported Access JWT");
	}

	const jwksUrl = `${issuer}/cdn-cgi/access/certs`;
	let jwks = await loadJwks(jwksUrl, { bypassCache: false });
	let jwk = jwks.keys?.find((key) => key.kid === header.kid);
	if (!jwk) {
		// Key rotation: the cached JWKS may predate this kid; refetch from origin.
		jwks = await loadJwks(jwksUrl, { bypassCache: true });
		jwk = jwks.keys?.find((key) => key.kid === header.kid);
	}
	if (!jwk) throw new Error("Access signing key was not found");

	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		base64urlDecode(encodedSignature),
		new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
	);
	if (!valid) throw new Error("Access JWT signature is invalid");

	const payload = decodeJwtPart<Record<string, unknown>>(encodedPayload);
	const now = Math.floor(Date.now() / 1000);
	if (payload.iss !== issuer) throw new Error("Access JWT issuer is invalid");
	if (typeof payload.exp !== "number" || payload.exp <= now) {
		throw new Error("Access JWT is expired");
	}
	if (typeof payload.nbf === "number" && payload.nbf > now) {
		throw new Error("Access JWT is not active yet");
	}
	const audiences = Array.isArray(payload.aud)
		? payload.aud
		: typeof payload.aud === "string"
			? [payload.aud]
			: [];
	if (!audiences.includes(config.aud)) {
		throw new Error("Access JWT audience is invalid");
	}
	return payload;
}
