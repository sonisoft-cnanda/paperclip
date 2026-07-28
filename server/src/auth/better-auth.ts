import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth, type Auth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, twoFactor } from "better-auth/plugins";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authTwoFactors,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/** Shown as the account label in authenticator apps. */
const TWO_FACTOR_ISSUER = "Paperclip";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthGetSessionApi = {
  getSession?: (input: { headers: Headers }) => Promise<unknown>;
};

type BetterAuthHandlerTarget = Extract<Parameters<typeof toNodeHandler>[0], { handler: Auth["handler"] }>;

type BetterAuthSessionResolver = {
  api?: BetterAuthGetSessionApi;
};

type BetterAuthInstance = BetterAuthHandlerTarget & BetterAuthSessionResolver;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldEnableAuthRateLimit(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}): boolean {
  const override = input.override?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  return input.deploymentMode === "authenticated";
}

export function buildBetterAuthRateLimitOptions(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}) {
  return {
    enabled: shouldEnableAuthRateLimit(input),
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  authBaseUrlMode: Config["authBaseUrlMode"];
  authPublicBaseUrl: string | undefined;
  publicUrl?: string | undefined;
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

export type ResolvedSsoProvider = {
  providerId: string;
  displayName: string;
};

/**
 * Build the `genericOAuth` provider list from config, resolving each client
 * secret from `process.env[clientSecretEnv]` (the same convention as
 * BETTER_AUTH_SECRET — secrets never live in config.json).
 *
 * A provider whose secret env var is unset is skipped rather than throwing, so
 * a misconfigured IdP cannot stop the instance from booting. Skipped providers
 * are also absent from `listConfiguredSsoProviders`, so the UI never offers a
 * sign-in button that is guaranteed to fail.
 */
export function buildSsoProviderConfigs(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): { configs: Record<string, unknown>[]; skipped: string[] } {
  if (!config.authSsoEnabled) return { configs: [], skipped: [] };

  const configs: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  for (const provider of config.authSsoProviders) {
    const clientSecret = env[provider.clientSecretEnv]?.trim();
    if (!clientSecret) {
      skipped.push(provider.providerId);
      continue;
    }
    configs.push({
      providerId: provider.providerId,
      clientId: provider.clientId,
      clientSecret,
      scopes: provider.scopes,
      ...(provider.discoveryUrl ? { discoveryUrl: provider.discoveryUrl } : {}),
      ...(provider.issuer ? { issuer: provider.issuer } : {}),
      ...(provider.authorizationUrl ? { authorizationUrl: provider.authorizationUrl } : {}),
      ...(provider.tokenUrl ? { tokenUrl: provider.tokenUrl } : {}),
      ...(provider.userInfoUrl ? { userInfoUrl: provider.userInfoUrl } : {}),
    });
  }
  return { configs, skipped };
}

/** Providers that are actually usable — safe to expose to unauthenticated clients. */
export function listConfiguredSsoProviders(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSsoProvider[] {
  const { configs } = buildSsoProviderConfigs(config, env);
  const usable = new Set(configs.map((entry) => entry.providerId as string));
  return config.authSsoProviders
    .filter((provider) => usable.has(provider.providerId))
    .map((provider) => ({
      providerId: provider.providerId,
      displayName: provider.displayName ?? provider.providerId,
    }));
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  const { configs: ssoProviderConfigs, skipped: skippedSsoProviders } = buildSsoProviderConfigs(config);
  if (skippedSsoProviders.length > 0) {
    logger.error(
      { providers: skippedSsoProviders },
      "SSO providers skipped: their clientSecretEnv variable is unset. They will not be offered at sign-in.",
    );
  }

  const plugins = [
    ...(config.authTwoFactorEnabled ? [twoFactor({ issuer: TWO_FACTOR_ISSUER })] : []),
    ...(ssoProviderConfigs.length > 0
      ? [genericOAuth({ config: ssoProviderConfigs as never })]
      : []),
  ];

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        // Required: the adapter schema map is closed, so the two-factor plugin's
        // model must be registered here or its queries fail at runtime.
        twoFactor: authTwoFactors,
      },
    }),
    plugins,
    // An OIDC sign-in whose verified email matches an existing user links to
    // that user instead of creating a duplicate. This also keeps board API keys
    // working across an SSO rollout: they resolve through the owning user row,
    // which must survive rather than be replaced by a JIT-created account.
    account: {
      accountLinking: {
        enabled: ssoProviderConfigs.length > 0,
        trustedProviders: ssoProviderConfigs.map((entry) => entry.providerId as string),
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    rateLimit: buildBetterAuthRateLimitOptions({
      deploymentMode: config.deploymentMode,
      deploymentExposure: config.deploymentExposure,
      override: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    }),
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthHandlerTarget): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthSessionResolver,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = auth.api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthSessionResolver,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
