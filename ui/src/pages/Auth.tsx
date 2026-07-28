import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up";
// `step` is deliberately separate from `mode`: `mode` drives the heading, field
// set, button label and footer toggle, and threading a third value through all
// of them would conflate "which form" with "how far through it we are".
type AuthStep = "credentials" | "two_factor";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [step, setStep] = useState<AuthStep>("credentials");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = "auth-error";

  const nextPath = useMemo(
    () => searchParams.get("next") || getRememberedInvitePath() || "/",
    [searchParams],
  );
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  // Guarded on `step`: during a 2FA challenge BetterAuth has deleted the
  // credential session, so `session` is null here anyway — but if a stale
  // cached session were still present this effect would otherwise bounce the
  // user straight off the code-entry step.
  useEffect(() => {
    if (session && step === "credentials") {
      navigate(nextPath, { replace: true });
    }
  }, [session, step, navigate, nextPath]);

  const authConfigQuery = useQuery({
    queryKey: queryKeys.auth.config,
    queryFn: () => authApi.getAuthConfig(),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const ssoProviders = authConfigQuery.data?.sso.providers ?? [];

  const completeSignIn = async () => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    navigate(nextPath, { replace: true });
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in") {
        return await authApi.signInEmail({ email: email.trim(), password });
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      return { status: "signed_in" as const };
    },
    onSuccess: async (result) => {
      // A 2FA challenge is a *successful* HTTP response with no session behind
      // it, so it must not fall through to the navigate below.
      if (result?.status === "two_factor_required") {
        setError(null);
        setPassword("");
        setStep("two_factor");
        return;
      }
      await completeSignIn();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const code = totpCode.trim();
      if (useBackupCode) {
        await authApi.twoFactor.verifyBackupCode({ code });
        return;
      }
      await authApi.twoFactor.verifyTotp({ code });
    },
    onSuccess: completeSignIn,
    onError: (err) => {
      setError(err instanceof Error ? err.message : "That code was not accepted");
    },
  });

  const ssoMutation = useMutation({
    mutationFn: (providerId: string) => authApi.signInSso(providerId),
    onSuccess: (url) => {
      window.location.assign(url);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Could not start SSO sign-in");
    },
  });

  const canSubmit =
    step === "two_factor"
      // Backup codes are not 6-digit TOTP values, so only require non-empty.
      ? totpCode.trim().length > 0
      : email.trim().length > 0 &&
        password.trim().length > 0 &&
        (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip</span>
          </div>

          <h1 className="text-xl font-semibold">
            {step === "two_factor"
              ? "Two-factor authentication"
              : mode === "sign_in"
                ? "Sign in to Paperclip"
                : "Create your Paperclip account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {step === "two_factor"
              ? useBackupCode
                ? "Enter one of the backup codes you saved when you set up two-factor authentication."
                : "Enter the 6-digit code from your authenticator app."
              : mode === "sign_in"
                ? "Use your email and password to access this instance."
                : "Create an account for this instance. Email confirmation is not required in v1."}
          </p>

          <form
            className="mt-6 space-y-4"
            method="post"
            action={
              step === "two_factor"
                ? "/api/auth/two-factor/verify-totp"
                : mode === "sign_up"
                  ? "/api/auth/sign-up/email"
                  : "/api/auth/sign-in/email"
            }
            onSubmit={(event) => {
              event.preventDefault();
              if (mutation.isPending || verifyMutation.isPending) return;
              if (!canSubmit) {
                setError(
                  step === "two_factor"
                    ? "Please enter your code."
                    : "Please fill in all required fields.",
                );
                return;
              }
              if (step === "two_factor") {
                verifyMutation.mutate();
                return;
              }
              mutation.mutate();
            }}
          >
            {step === "two_factor" && (
              <div>
                <label htmlFor="totp" className="text-xs text-muted-foreground mb-1 block">
                  {useBackupCode ? "Backup code" : "Authentication code"}
                </label>
                <input
                  id="totp"
                  name="code"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value)}
                  inputMode={useBackupCode ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  placeholder={useBackupCode ? "" : "123456"}
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
              </div>
            )}
            {step === "credentials" && mode === "sign_up" && (
              <div>
                <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">Name</label>
                <input
                  id="name"
                  name="name"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
              </div>
            )}
            {step === "credentials" && (
            <>
            <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">Email</label>
              <input
                id="email"
                name="email"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                autoFocus={mode === "sign_in"}
              />
            </div>
            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">Password</label>
              <input
                id="password"
                name="password"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
            </div>
            </>
            )}
            {error && (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={mutation.isPending || verifyMutation.isPending}
              aria-disabled={!canSubmit || mutation.isPending || verifyMutation.isPending}
              className={`w-full ${!canSubmit && !mutation.isPending && !verifyMutation.isPending ? "opacity-50" : ""}`}
            >
              {mutation.isPending || verifyMutation.isPending
                ? "Working…"
                : step === "two_factor"
                  ? "Verify"
                  : mode === "sign_in"
                    ? "Sign In"
                    : "Create Account"}
            </Button>
          </form>

          {step === "credentials" && mode === "sign_in" && ssoProviders.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="relative py-1 text-center">
                <span className="bg-background relative z-10 px-2 text-xs text-muted-foreground">or</span>
                <span className="absolute inset-x-0 top-1/2 border-t border-border" aria-hidden="true" />
              </div>
              {ssoProviders.map((provider) => (
                <Button
                  key={provider.providerId}
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={ssoMutation.isPending}
                  onClick={() => ssoMutation.mutate(provider.providerId)}
                >
                  {ssoMutation.isPending ? "Redirecting…" : `Sign in with ${provider.displayName}`}
                </Button>
              ))}
            </div>
          )}

          {step === "two_factor" ? (
            <div className="mt-5 space-y-2 text-sm text-muted-foreground">
              <div>
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-2"
                  onClick={() => {
                    setError(null);
                    setTotpCode("");
                    setUseBackupCode(!useBackupCode);
                  }}
                >
                  {useBackupCode ? "Use your authenticator app instead" : "Use a backup code instead"}
                </button>
              </div>
              <div>
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-2"
                  onClick={() => {
                    setError(null);
                    setTotpCode("");
                    setUseBackupCode(false);
                    setStep("credentials");
                  }}
                >
                  Back to sign in
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-5 text-sm text-muted-foreground">
              {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => {
                  setError(null);
                  setMode(mode === "sign_in" ? "sign_up" : "sign_in");
                }}
              >
                {mode === "sign_in" ? "Create one" : "Sign in"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
