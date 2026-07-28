# MFA (TOTP) and SSO (OIDC)

Status: Operator guide for native two-factor auth and OIDC single sign-on
Applies to: `deploymentMode: authenticated` only

Paperclip's human login is Better Auth. Two optional plugins extend it:

- **Two-factor (TOTP)** — an authenticator-app code required after the password.
- **SSO (OIDC)** — "Sign in with <IdP>" via Better Auth's `generic-oauth` plugin.

Both are **off by default**. Neither is loaded in `local_trusted` mode, where
Better Auth itself is never imported.

Enabling these lets an instance drop a front-door proxy such as Cloudflare
Access and authenticate directly against Paperclip.

## Configuration

Both live under the `auth` block of `config.json`:

```jsonc
"auth": {
  "twoFactor": {
    "enabled": true,
    // "optional": users opt in from profile settings.
    // "required": un-enrolled users are redirected to enrollment and cannot turn it off.
    "enforcement": "optional"
  },
  "sso": {
    "enabled": true,
    "providers": [
      {
        "providerId": "okta",
        "displayName": "Okta",
        "discoveryUrl": "https://<org>.okta.com/.well-known/openid-configuration",
        "clientId": "<client-id>",
        "clientSecretEnv": "PAPERCLIP_SSO_OKTA_CLIENT_SECRET",
        "scopes": ["openid", "email", "profile"],
        // Recommended for production. See "Who can sign in via SSO" below.
        "disableSignUp": true
      }
    ]
  }
}
```

A provider needs `discoveryUrl`, or `issuer`, or both `authorizationUrl` and
`tokenUrl`.

**Per-provider setup recipes** — Microsoft Entra ID, Okta, Google Workspace,
Auth0, Keycloak, and plain OAuth 2.0 — live in
[AUTH-SSO-PROVIDERS.md](./AUTH-SSO-PROVIDERS.md), along with a troubleshooting
table.

### Who can sign in via SSO

By default (`disableSignUp: false`) **any account in the IdP's directory can
authenticate**, and a matching Paperclip user is created on first login. Such a
user has no instance role and no company membership, so they land on the
no-access page — but the user row exists.

Set `disableSignUp: true` per provider to require that the user already exists.
Combined with company invites, this gives the intended posture: **pre-provision
access, then let SSO attach to it by verified email.**

Note this is *separate* from the top-level `auth.disableSignUp`, which only
governs email/password registration and has no effect on SSO.

Authentication and authorisation are distinct here: SSO only proves identity.
Access comes from an instance role or a company membership, and memberships are
granted through invites (`POST /api/companies/:companyId/invites`, accepted at
`/invite/:token`). A user who signs in via SSO with no membership sees the
no-access page until someone invites them.

### Environment overrides

| Variable | Effect |
| --- | --- |
| `PAPERCLIP_AUTH_TWO_FACTOR_ENABLED` | `true`/`false`, overrides `auth.twoFactor.enabled` |
| `PAPERCLIP_AUTH_TWO_FACTOR_ENFORCEMENT` | `optional`/`required` |
| `PAPERCLIP_AUTH_SSO_ENABLED` | `true`/`false`, overrides `auth.sso.enabled` |
| `PAPERCLIP_SSO_<PROVIDER>_CLIENT_SECRET` | The OIDC client secret, named by `clientSecretEnv` |

**Client secrets never live in `config.json`.** Each provider names an env var
via `clientSecretEnv`, following the existing `BETTER_AUTH_SECRET` convention.
On a managed host these land in `/etc/sonisoft/paperclip.env` via IAC/Infisical.

A provider whose secret env var is unset is **skipped**: an error is logged at
startup, the provider is absent from `GET /api/auth/config`, and no sign-in
button is offered. A misconfigured IdP cannot stop the instance from booting.

## IdP registration

Register the redirect URI as:

```
https://<publicBaseUrl>/api/auth/oauth2/callback/<providerId>
```

No new Express routes are needed — the existing `/api/auth/*` catch-all already
forwards every plugin endpoint.

### Account linking

`accountLinking` is enabled for configured SSO providers, so an OIDC login whose
email matches an existing user **links to that user** rather than creating a
duplicate. This matters beyond tidiness: board API keys, company memberships and
instance roles all resolve through the owning user row, so a JIT-created
duplicate would orphan an operator's existing access.

**`requireLocalEmailVerified: false` is required, not optional.** BetterAuth
defaults it to `true`, which demands the *local* user already be email-verified.
Paperclip sets `requireEmailVerification: false` and has no verification flow, so
`user.emailVerified` is always `false` — leaving the default in place makes
linking impossible and every SSO login for an existing address fails with
`account_not_linked`.

> **Security precondition.** Because unverified local accounts are linkable, an
> instance that allows open self-registration lets someone pre-register a
> colleague's address and capture their first SSO sign-in. On any instance where
> users do not already control their own email addresses, set **both**:
>
> - `auth.disableSignUp: true` — no open password registration
> - `auth.sso.providers[].disableSignUp: true` — no JIT-created SSO users
>
> and provision access through company invites instead.

## Database

Two-factor adds one table (`two_factor`) and one column
(`user.two_factor_enabled`) in migration `0195_two_factor.sql`. The table is
registered with the Better Auth drizzle adapter in
`server/src/auth/better-auth.ts` — the adapter's schema map is closed, so a new
plugin model must be added there as well as to the schema.

**SSO needs no migration.** The `account` table already carries every Better Auth
OAuth column and has been unchanged since migration `0014`.

## How enforcement works

When a user with 2FA enabled signs in with a password, Better Auth **deletes the
credential session it briefly created** and returns
`{ twoFactorRedirect: true }` with a short-lived challenge cookie instead. Only
`/api/auth/two-factor/verify-totp` (or `verify-backup-code`) creates a real
session.

Paperclip derives its actor from `auth.api.getSession`, so a half-authenticated
user resolves to no actor at all: `/api/auth/get-session` returns 401 and the
existing `CloudAccessGate` redirect applies. **No extra server-side gating is
required, and there is deliberately no `twoFactorPending` session flag** — such
a state can never be observed, because the session does not exist while the
challenge is in flight.

`enforcement: "required"` adds one thing on top: a signed-in but *un-enrolled*
user is redirected to profile settings, and cannot turn 2FA back off.

## Agents are unaffected

Agent and board API keys (`Authorization: Bearer pcp_board_…`, agent keys, local
agent JWTs) authenticate on a separate branch of `actorMiddleware` that never
touches the Better Auth session. Enabling 2FA cannot gate them, so agents keep
running. This is covered by an end-to-end regression check.

## Recovery

Enrollment issues 10 single-use backup codes. Better Auth exposes no way to
re-read them, so they are shown **once** — at enrollment, and again when
regenerated from profile settings (which invalidates the previous set).

If a user loses both their authenticator and their backup codes, an instance
admin can clear their `two_factor` row and reset `user.two_factor_enabled`, or
use `paperclipai auth-bootstrap-ceo`.

## Not covered

- **SAML-only IdPs.** `generic-oauth` covers Okta, Entra ID, Google Workspace,
  Auth0 and Keycloak over OIDC. SAML would need the separate `@better-auth/sso`
  package, which is not installed.
- **Email/SMS OTP as a second factor.** Only TOTP and backup codes are wired up;
  Better Auth's `sendOTP` path is not configured.
