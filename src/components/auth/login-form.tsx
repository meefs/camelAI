"use client";

import { useState, useEffect } from "react";
import { useNavigate, Link, useFetcher } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RadialGridBackground } from "@/components/ui/radial-grid-background";
import { SlotMachinePrompt } from "@/components/ui/slot-machine-prompt";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { FullLogo } from "@/components/ui/logo";
import { OAuthButtons, OAuthDivider } from "@/components/auth/oauth-buttons";

const inspirationalPrompts = [
  "Alert me in Slack whenever someone signs up with a .edu email address",
  "Build a feedback form that saves responses and emails me a daily summary",
  "Send my team a weekly metrics email with Stripe revenue every Monday",
  "Make a simple CRM for tracking investor conversations and follow-ups",
  "Create a client portal where they upload files and I get notified in Slack",
  "Build an internal calculator for sales reps to quote custom pricing",
];

type LoginFormProps = {
  redirectTo: string;
  oauthError?: string | null;
  passwordResetSuccess?: boolean;
};

export function LoginForm({
  redirectTo,
  oauthError,
  passwordResetSuccess = false,
}: LoginFormProps) {
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submitting = fetcher.state !== "idle";
  const error = fetcher.data?.error as string | undefined;

  const signupHref =
    redirectTo === "/"
      ? "/signup"
      : `/signup?redirect=${encodeURIComponent(redirectTo)}`;

  // Navigate on successful login
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetcher.submit(JSON.stringify({ email, password }), {
      method: "post",
      action: "/api/auth/login",
      encType: "application/json",
    });
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
                  Welcome back
                </h1>
                <p className="text-muted-foreground text-sm text-balance">
                  Sign in to your account
                </p>
              </div>

              {oauthError && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertDescription>{oauthError}</AlertDescription>
                </Alert>
              )}

              {passwordResetSuccess && (
                <Alert>
                  <CheckCircle2 className="size-4" />
                  <AlertDescription>
                    Password updated. Sign in with your new password.
                  </AlertDescription>
                </Alert>
              )}

              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <OAuthButtons redirectUrl={redirectTo} disabled={submitting} />

              <OAuthDivider text="or continue with email" />

              <div className="grid gap-4">
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
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="password">Password</Label>
                    <Link
                      to="/forgot-password"
                      className="text-muted-foreground text-xs hover:text-primary hover:underline underline-offset-4"
                    >
                      Forgot password?
                    </Link>
                  </div>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="Your password"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full"
                  size="lg"
                >
                  {submitting ? "Signing in..." : "Sign in"}
                </Button>
              </div>

              <div className="text-center text-sm">
                Don&apos;t have an account?{" "}
                <Link
                  to={signupHref}
                  className="text-primary hover:underline underline-offset-4"
                >
                  Sign up
                </Link>
              </div>

              <div className="text-center text-xs text-muted-foreground">
                <p>Looking for camelStream, the flat-rate inference API?</p>
                <a
                  href="https://stream.camelai.com/login?utm_source=camelai_dev&utm_medium=auth_rescue"
                  className="hover:underline underline-offset-4"
                >
                  Log in at stream.camelai.com →
                </a>
              </div>

              <div className="text-center text-xs text-muted-foreground">
                Looking for old camelAI?{" "}
                <a
                  href="https://app.camelai.com"
                  className="hover:underline underline-offset-4"
                >
                  Open old camelAI
                </a>
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
