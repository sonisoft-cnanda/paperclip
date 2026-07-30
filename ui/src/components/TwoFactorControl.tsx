import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Stage =
  | { kind: "idle" }
  /** Secret issued and QR rendered; waiting for the user to confirm a code. */
  | { kind: "enrolling"; totpURI: string; qrSvg: string; backupCodes: string[] }
  /** Enrollment confirmed — last chance to copy the backup codes. */
  | { kind: "enrolled"; backupCodes: string[] };

function BackupCodes({ codes, title }: { codes: string[]; title: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <p className="text-xs font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Save these somewhere safe. Each one works once, and they cannot be shown again — generating
        a new set replaces them.
      </p>
      <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <Button
        type="button"
        variant="outline"
        className="mt-3"
        onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}
      >
        Copy codes
      </Button>
    </div>
  );
}

/**
 * Two-factor authentication (TOTP) enrollment for the signed-in user.
 *
 * User-scoped rather than company-scoped, so unlike the sibling controls on
 * this page it takes no `companyId`. The QR code is rendered server-side (see
 * POST /api/auth/totp-qr) so the published @paperclipai/ui package gains no QR
 * dependency.
 */
export function TwoFactorControl() {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: queryKeys.auth.config,
    queryFn: () => authApi.getAuthConfig(),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const enabled = sessionQuery.data?.user.twoFactorEnabled ?? false;
  const enforcement = configQuery.data?.twoFactor.enforcement ?? "optional";

  const refreshSession = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
  };

  const reset = () => {
    setPassword("");
    setCode("");
    setError(null);
  };

  const startMutation = useMutation({
    mutationFn: async () => {
      const { totpURI, backupCodes } = await authApi.twoFactor.enable({ password });
      const qrSvg = await authApi.twoFactor.renderQr(totpURI);
      return { totpURI, qrSvg, backupCodes };
    },
    onSuccess: ({ totpURI, qrSvg, backupCodes }) => {
      setError(null);
      setPassword("");
      setStage({ kind: "enrolling", totpURI, qrSvg, backupCodes });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not start enrollment"),
  });

  const confirmMutation = useMutation({
    mutationFn: () => authApi.twoFactor.verifyTotp({ code: code.trim() }),
    onSuccess: async () => {
      const backupCodes = stage.kind === "enrolling" ? stage.backupCodes : [];
      setError(null);
      setCode("");
      setStage({ kind: "enrolled", backupCodes });
      await refreshSession();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "That code was not accepted"),
  });

  const disableMutation = useMutation({
    mutationFn: () => authApi.twoFactor.disable({ password }),
    onSuccess: async () => {
      reset();
      setStage({ kind: "idle" });
      await refreshSession();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not turn off two-factor"),
  });

  const regenerateMutation = useMutation({
    mutationFn: () => authApi.twoFactor.generateBackupCodes({ password }),
    onSuccess: (backupCodes) => {
      setError(null);
      setPassword("");
      setStage({ kind: "enrolled", backupCodes });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not generate backup codes"),
  });

  const busy =
    startMutation.isPending ||
    confirmMutation.isPending ||
    disableMutation.isPending ||
    regenerateMutation.isPending;

  // Nothing to configure when the server has the plugin switched off.
  if (configQuery.data && !configQuery.data.twoFactor.enabled) return null;
  if (configQuery.isLoading || sessionQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading security settings…</div>;
  }

  return (
    <section className="space-y-4" aria-label="Two-factor authentication">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Two-factor authentication</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {enabled
            ? "Two-factor authentication is on. You'll be asked for a code from your authenticator app each time you sign in."
            : enforcement === "required"
              ? "This instance requires two-factor authentication. Set it up now to keep access to your account."
              : "Add a second step to your sign-in using an authenticator app such as 1Password, Authy, or Google Authenticator."}
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {stage.kind === "enrolling" && (
        <div className="max-w-2xl space-y-3">
          <p className="text-sm">Scan this with your authenticator app, then enter the code it shows.</p>
          <div
            className="inline-block rounded-md bg-white p-3 [&>svg]:h-40 [&>svg]:w-40"
            // Server-rendered SVG from our own /api/auth/totp-qr endpoint.
            dangerouslySetInnerHTML={{ __html: stage.qrSvg }}
          />
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Can&apos;t scan it?</summary>
            <p className="mt-1 break-all font-mono">{stage.totpURI}</p>
          </details>
          <div className="max-w-xs">
            <Label htmlFor="two-factor-code">Authentication code</Label>
            <Input
              id="two-factor-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={busy || code.trim().length === 0}
              onClick={() => confirmMutation.mutate()}
            >
              {confirmMutation.isPending ? "Verifying…" : "Verify and turn on"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                reset();
                setStage({ kind: "idle" });
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {stage.kind === "enrolled" && stage.backupCodes.length > 0 && (
        <div className="max-w-2xl">
          <BackupCodes codes={stage.backupCodes} title="Your backup codes" />
        </div>
      )}

      {stage.kind !== "enrolling" && (
        <div className="max-w-xs space-y-3">
          <div>
            <Label htmlFor="two-factor-password">Confirm your password</Label>
            <Input
              id="two-factor-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {!enabled && (
              <Button
                type="button"
                disabled={busy || password.length === 0}
                onClick={() => startMutation.mutate()}
              >
                {startMutation.isPending ? "Starting…" : "Set up two-factor"}
              </Button>
            )}
            {enabled && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || password.length === 0}
                  onClick={() => regenerateMutation.mutate()}
                >
                  {regenerateMutation.isPending ? "Generating…" : "New backup codes"}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy || password.length === 0 || enforcement === "required"}
                  title={
                    enforcement === "required"
                      ? "This instance requires two-factor authentication."
                      : undefined
                  }
                  onClick={() => disableMutation.mutate()}
                >
                  {disableMutation.isPending ? "Turning off…" : "Turn off"}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
