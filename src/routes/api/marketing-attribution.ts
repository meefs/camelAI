import type { Route } from "./+types/marketing-attribution";
import { getEnv } from "@/lib/cloudflare.server";
import {
  attributionCookie,
  attributionFromSearch,
  getMarketingAttribution,
} from "@/lib/marketing-attribution.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const result = await getMarketingAttribution(request, getEnv(context).APP_KV);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    attributionId?: string;
    search?: string;
  };
  const result = await getMarketingAttribution(
    request,
    getEnv(context).APP_KV,
    body.attributionId,
    attributionFromSearch(body.search ?? ""),
  );
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (result.id) headers.set("Set-Cookie", attributionCookie(result.id));
  return Response.json(result, { headers });
}
