"use client";

import { useEffect, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RadialGridBackground } from "@/components/ui/radial-grid-background";
import { SlotMachinePrompt } from "@/components/ui/slot-machine-prompt";
import { AlertCircle } from "lucide-react";
import { FullLogo } from "@/components/ui/logo";

const inspirationalPrompts = [
  "Alert me in Slack whenever someone signs up with a .edu email address",
  "Build a feedback form that saves responses and emails me a daily summary",
  "Send my team a weekly metrics email with Stripe revenue every Monday",
  "Make a simple CRM for tracking investor conversations and follow-ups",
  "Create a client portal where they upload files and I get notified in Slack",
  "Build an internal calculator for sales reps to quote custom pricing",
];

type ResetPasswordFormProps = {
  token: string | null;
};

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState("");

  const submitting = fetcher.state !== "idle";
  const serverError = fetcher.data?.error as string | undefined;
  const error = validationError || serverError;
  const missingToken = !token;

  useEffect(() => {
    const redirectTarget = fetcher.data?.redirect as string | undefined;
    if (fetcher.state === "idle" && redirectTarget) {
      navigate(redirectTarget);
    }
  }, [fetcher.state, fetcher.data, navigate]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError("");

    if (!token) {
      setValidationError("Reset link is invalid or has expired.");
      return;
    }

    if (password.length < 8) {
      setValidationError("Password must be at least 8 characters");
      return;
    }

    if (password !== confirmPassword) {
      setValidationError("Passwords do not match");
      return;
    }

    fetcher.submit(JSON.stringify({ token, password }), {
      method: "post",
      action: "/api/auth/reset-password",
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
                  Set a new password
                </h1>
                <p className="text-muted-foreground text-sm text-balance">
                  Choose a new password for your account
                </p>
              </div>

              {(error || missingToken) && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertDescription>
                    {missingToken && !error
                      ? "Reset link is invalid or has expired."
                      : error}
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    disabled={missingToken}
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
                    minLength={8}
                    placeholder="Confirm your new password"
                    autoComplete="new-password"
                    disabled={missingToken}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={submitting || missingToken}
                  className="w-full"
                  size="lg"
                >
                  {submitting ? "Updating..." : "Update password"}
                </Button>
              </div>

              <div className="text-center text-sm">
                <Link
                  to="/login"
                  className="text-primary hover:underline underline-offset-4"
                >
                  Back to sign in
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
