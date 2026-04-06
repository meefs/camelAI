import { useLoaderData } from "react-router";
import type { Route } from "./+types/_auth.login";
import { LoginForm } from "@/components/auth/login-form";

export function meta() {
  return [
    { title: "Sign In - camelAI" },
    { name: "description", content: "Sign in to your camelAI account" },
  ];
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_denied: 'You cancelled the sign-in.',
  oauth_state_invalid: 'Sign-in expired. Please try again.',
  oauth_race_condition: 'Sign-in conflict. Please try again.',
  oauth_email_domain_blocked: 'Sign-up from this email domain is not allowed.',
  oauth_failed: 'Sign-in failed. Please try again.',
  oauth_invalid: 'Invalid sign-in response. Please try again.',
  oauth_config: 'OAuth is not configured. Please contact support.',
  oauth_banned: 'This account has been blocked.',
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const redirectTo = getSafeRedirect(url.searchParams.get("redirect"));
  const errorCode = url.searchParams.get("error");
  const oauthError = errorCode
    ? (OAUTH_ERROR_MESSAGES[errorCode] ?? null)
    : null;
  return { redirectTo, oauthError };
}

export default function LoginPage() {
  const { redirectTo, oauthError } = useLoaderData<typeof loader>();
  return <LoginForm redirectTo={redirectTo} oauthError={oauthError} />;
}

function getSafeRedirect(redirect: string | null): string {
  if (!redirect) return "/";
  // Extract just the path portion (before any query string) for safety checks.
  // Query params may contain colons (e.g. redirect_uri=https://...) which are safe.
  const pathPart = redirect.split("?")[0];
  if (
    pathPart.startsWith("/") &&
    !pathPart.startsWith("//") &&
    !pathPart.includes(":")
  ) {
    return redirect;
  }
  return "/";
}
