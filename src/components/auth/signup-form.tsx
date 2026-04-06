"use client";

import { useState, useEffect } from "react";
import { useNavigate, Link, useFetcher } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RadialGridBackground } from "@/components/ui/radial-grid-background";
import { SlotMachinePrompt } from "@/components/ui/slot-machine-prompt";
import { AlertCircle } from "lucide-react";
import { FullLogo } from "@/components/ui/logo";
import { OAuthButtons, OAuthDivider } from "@/components/auth/oauth-buttons";
import { TurnstileWidget } from "@/components/auth/turnstile-widget";

const inspirationalPrompts = [
  "Alert me in Slack whenever someone signs up with a .edu email address",
  "Build a feedback form that saves responses and emails me a daily summary",
  "Send my team a weekly metrics email with Stripe revenue every Monday",
  "Make a simple CRM for tracking investor conversations and follow-ups",
  "Create a client portal where they upload files and I get notified in Slack",
  "Build an internal calculator for sales reps to quote custom pricing",
];

type SignupFormProps = {
  redirectTo: string;
  turnstileSiteKey: string | null;
  turnstileAction: string;
  emailSignupEnabled: boolean;
};

export function SignupForm({
  redirectTo,
  turnstileSiteKey,
  turnstileAction,
  emailSignupEnabled,
}: SignupFormProps) {
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [validationError, setValidationError] = useState("");

  const submitting = fetcher.state !== "idle";
  const serverError = fetcher.data?.error as string | undefined;
  const error = validationError || serverError;
  const requiresTurnstile = Boolean(turnstileSiteKey);

  const loginHref =
    redirectTo === "/"
      ? "/login"
      : `/login?redirect=${encodeURIComponent(redirectTo)}`;

  // Navigate on successful signup
  useEffect(() => {
    const redirectTarget = fetcher.data?.redirect as string | undefined;
    if (fetcher.state === "idle" && redirectTarget) {
      navigate(redirectTarget);
      return;
    }
    if (fetcher.state === "idle" && fetcher.data && !fetcher.data.error) {
      navigate(redirectTo);
    }
  }, [fetcher.state, fetcher.data, navigate, redirectTo]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.error && requiresTurnstile) {
      setTurnstileToken(null);
      setTurnstileResetKey((current) => current + 1);
    }
  }, [fetcher.state, fetcher.data, requiresTurnstile]);

  useEffect(() => {
    if (turnstileToken && validationError === "Complete the security check") {
      setValidationError("");
    }
  }, [turnstileToken, validationError]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError("");

    if (password !== confirmPassword) {
      setValidationError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setValidationError("Password must be at least 8 characters");
      return;
    }

    if (!emailSignupEnabled) {
      setValidationError("Email signup is temporarily unavailable");
      return;
    }

    if (requiresTurnstile && !turnstileToken) {
      setValidationError("Complete the security check");
      return;
    }

    fetcher.submit(
      JSON.stringify({
        email,
        password,
        name: name || undefined,
        redirectTo,
        turnstileToken: turnstileToken || undefined,
      }),
      {
        method: "post",
        action: "/api/auth/signup",
        encType: "application/json",
      },
    );
  };

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center md:justify-start">
          <Link to="/">
            <FullLogo className="h-6" />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="text-xl font-semibold tracking-tight">
                  Create an account
                </h1>
                <p className="text-muted-foreground text-sm text-balance">
                  Get started with camelAI
                </p>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <OAuthButtons redirectUrl={redirectTo} disabled={submitting} />

              <OAuthDivider text="or sign up with email" />

              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="name">Name (optional)</Label>
                  <Input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="At least 8 characters"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="confirmPassword">Confirm password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    placeholder="Confirm your password"
                  />
                </div>
                {turnstileSiteKey ? (
                  <TurnstileWidget
                    siteKey={turnstileSiteKey}
                    action={turnstileAction}
                    resetKey={turnstileResetKey}
                    onTokenChange={setTurnstileToken}
                  />
                ) : null}
                {!emailSignupEnabled ? (
                  <p className="text-muted-foreground text-xs">
                    Email signup is temporarily unavailable while the security
                    check is being configured.
                  </p>
                ) : null}
                <Button
                  type="submit"
                  disabled={submitting || !emailSignupEnabled}
                  className="w-full"
                  size="lg"
                >
                  {submitting ? "Creating account..." : "Create account"}
                </Button>
              </div>

              <div className="text-center text-sm">
                Already have an account?{" "}
                <Link
                  to={loginHref}
                  className="text-primary hover:underline underline-offset-4"
                >
                  Sign in
                </Link>
              </div>
            </form>
          </div>
        </div>
      </div>
      <div className="bg-muted relative hidden lg:block">
        <RadialGridBackground />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            Software on demand.
          </h2>
          <SlotMachinePrompt prompts={inspirationalPrompts} />
        </div>
      </div>
    </div>
  );
}
