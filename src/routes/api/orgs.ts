import type { Route } from "./+types/orgs";
import { requireAuthContext } from "@/lib/auth.server";
import { getUserOrgs } from "@/lib/auth-do";
import { getAuthEnv } from "@/lib/auth-helpers";
import { getEnv } from "@/lib/cloudflare.server";

/**
 * The user's full org list with names + archived filtering — i.e. the per-org
 * ORG.getInfo() fan-out that used to run inside getAuthContext on every page
 * load. It was the dominant auth latency (a single cold OrgDO could stall the
 * request ~1.4s), so it now lives here and is fetched lazily by the workspace
 * switcher, which is the only consumer that needs org names.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgs = await getUserOrgs(authEnv, authContext.user.id);
  return { orgs };
}
