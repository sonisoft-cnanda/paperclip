import {
  authClientConfigSchema,
  authSessionSchema,
  currentUserProfileSchema,
  type AuthClientConfig,
  type AuthSession,
  type CurrentUserProfile,
  type UpdateCurrentUserProfile,
} from "@paperclipai/shared";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";

type AuthErrorBody =
  | {
    code?: string;
    message?: string;
    error?: string | { code?: string; message?: string };
  }
  | null;

export class AuthApiError extends Error {
  status: number;
  code: string | null;
  body: unknown;

  constructor(message: string, status: number, body: unknown, code: string | null = null) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function toSession(value: unknown): AuthSession | null {
  const direct = authSessionSchema.safeParse(value);
  if (direct.success) return direct.data;

  if (!value || typeof value !== "object") return null;
  const nested = authSessionSchema.safeParse((value as Record<string, unknown>).data);
  return nested.success ? nested.data : null;
}

/**
 * A password sign-in either completes, or is held pending a second factor.
 * BetterAuth signals the latter with HTTP 200 + `{ twoFactorRedirect: true }`,
 * having already deleted the credential session it briefly created.
 */
export type SignInResult =
  | { status: "signed_in" }
  | { status: "two_factor_required"; methods: string[] };

export type TwoFactorEnableResult = {
  totpURI: string;
  backupCodes: string[];
};

function toSignInResult(payload: unknown): SignInResult {
  if (payload && typeof payload === "object") {
    const body = payload as { twoFactorRedirect?: unknown; twoFactorMethods?: unknown };
    if (body.twoFactorRedirect === true) {
      const methods = Array.isArray(body.twoFactorMethods)
        ? body.twoFactorMethods.filter((m): m is string => typeof m === "string")
        : [];
      return { status: "two_factor_required", methods };
    }
  }
  return { status: "signed_in" };
}

function extractAuthError(payload: AuthErrorBody, status: number) {
  const nested =
    payload?.error && typeof payload.error === "object"
      ? payload.error
      : null;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof payload?.code === "string"
        ? payload.code
        : null;
  const message =
    typeof nested?.message === "string" && nested.message.trim().length > 0
      ? nested.message
      : typeof payload?.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : typeof payload?.error === "string" && payload.error.trim().length > 0
          ? payload.error
          : `Request failed: ${status}`;

  return new AuthApiError(message, status, payload, code);
}

// Rich diagnostics for auth requests. Network-layer failures (Safari
// "Load failed" / Chrome "Failed to fetch") throw a TypeError *before* any
// HTTP response, so they are indistinguishable from a bad password in the UI
// unless we log the resolved request URL + origin here. See PAP-13466.
function resolveAuthUrl(path: string) {
  const relative = `/api/auth${path}`;
  try {
    return new URL(relative, window.location.origin).href;
  } catch {
    return relative;
  }
}

function logAuthNetworkFailure(method: string, path: string, error: unknown) {
  // eslint-disable-next-line no-console
  console.error("[auth] request failed at the network layer (no HTTP response)", {
    method,
    requestUrl: resolveAuthUrl(path),
    pageOrigin: typeof window !== "undefined" ? window.location.origin : "(no window)",
    pageHref: typeof window !== "undefined" ? redactUrlSecrets(window.location.href) : "(no window)",
    credentials: "include",
    online: typeof navigator !== "undefined" ? navigator.onLine : "(no navigator)",
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    error,
    hint:
      "This means the browser never got a response from the server. Common causes: " +
      "the page origin differs from the API host (mixed http/https, wrong hostname/port, " +
      "or a proxy/tunnel that only forwards the page but not /api), an SSL error, or the " +
      "connection was reset. A wrong password would instead return HTTP 401, not this.",
  });
}

function logAuthHttpError(method: string, path: string, status: number, statusText: string, body: unknown) {
  // eslint-disable-next-line no-console
  console.error("[auth] request returned an error status", {
    method,
    requestUrl: resolveAuthUrl(path),
    status,
    statusText,
    body,
  });
}

async function authPost(path: string, body: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`/api/auth${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    logAuthNetworkFailure("POST", path, networkError);
    throw networkError;
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    logAuthHttpError("POST", path, res.status, res.statusText, payload);
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return payload;
}

async function authPatch<T>(path: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return parse(payload);
}

export const authApi = {
  getSession: async (): Promise<AuthSession | null> => {
    const res = await fetch("/api/auth/get-session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return null;
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Failed to load session (${res.status})`);
    }
    const direct = toSession(payload);
    if (direct) return direct;
    const nested = payload && typeof payload === "object" ? toSession((payload as Record<string, unknown>).data) : null;
    return nested;
  },

  // Returns the response body rather than discarding it: when the user has 2FA
  // enabled BetterAuth answers a *successful* password sign-in with
  // `{ twoFactorRedirect: true }` and no session, so the caller must inspect
  // the body to know whether to navigate or show the TOTP step.
  signInEmail: async (input: { email: string; password: string }): Promise<SignInResult> => {
    const payload = await authPost("/sign-in/email", input);
    return toSignInResult(payload);
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  getProfile: async (): Promise<CurrentUserProfile> => {
    const res = await fetch("/api/auth/profile", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((payload as { error?: string } | null)?.error ?? `Failed to load profile (${res.status})`);
    }
    return currentUserProfileSchema.parse(payload);
  },

  updateProfile: async (input: UpdateCurrentUserProfile): Promise<CurrentUserProfile> =>
    authPatch("/profile", input, (payload) => currentUserProfileSchema.parse(payload)),

  signOut: async () => {
    await authPost("/sign-out", {});
  },

  // Auth capabilities available before sign-in (which flows are on, which SSO
  // providers are usable). Public endpoint — safe to call unauthenticated.
  getAuthConfig: async (): Promise<AuthClientConfig> => {
    const res = await fetch("/api/auth/config", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Failed to load auth config (${res.status})`);
    }
    return authClientConfigSchema.parse(payload);
  },

  twoFactor: {
    // Enrollment. `password` is re-checked by BetterAuth before the secret is
    // issued. Returns the otpauth:// URI plus one-time backup codes.
    enable: async (input: { password: string }): Promise<TwoFactorEnableResult> => {
      const payload = await authPost("/two-factor/enable", input);
      const body = (payload ?? {}) as { totpURI?: unknown; backupCodes?: unknown };
      return {
        totpURI: typeof body.totpURI === "string" ? body.totpURI : "",
        backupCodes: Array.isArray(body.backupCodes)
          ? body.backupCodes.filter((c): c is string => typeof c === "string")
          : [],
      };
    },

    disable: async (input: { password: string }) => {
      await authPost("/two-factor/disable", input);
    },

    // Confirms the authenticator app is generating correct codes. Also the
    // second step of sign-in, where `trustDevice` may be offered.
    verifyTotp: async (input: { code: string; trustDevice?: boolean }) => {
      await authPost("/two-factor/verify-totp", input);
    },

    verifyBackupCode: async (input: { code: string }) => {
      await authPost("/two-factor/verify-backup-code", input);
    },

    // Invalidates the previous set. BetterAuth exposes no way to re-read
    // existing codes, so these are shown once and cannot be recovered.
    generateBackupCodes: async (input: { password: string }): Promise<string[]> => {
      const payload = await authPost("/two-factor/generate-backup-codes", input);
      const body = (payload ?? {}) as { backupCodes?: unknown };
      return Array.isArray(body.backupCodes)
        ? body.backupCodes.filter((c): c is string => typeof c === "string")
        : [];
    },

    // Server-rendered so the published @paperclipai/ui package needs no QR dep.
    renderQr: async (totpURI: string): Promise<string> => {
      const payload = await authPost("/totp-qr", { totpURI });
      const body = (payload ?? {}) as { svg?: unknown };
      return typeof body.svg === "string" ? body.svg : "";
    },
  },

  // Starts the OIDC round-trip. BetterAuth replies with the IdP authorization
  // URL, which the browser then navigates to.
  signInSso: async (providerId: string): Promise<string> => {
    const payload = await authPost("/sign-in/oauth2", {
      providerId,
      callbackURL: window.location.origin,
    });
    const body = (payload ?? {}) as { url?: unknown; redirect?: unknown };
    if (typeof body.url === "string" && body.url.length > 0) return body.url;
    throw new AuthApiError("The identity provider did not return a sign-in URL", 502, payload);
  },
};
