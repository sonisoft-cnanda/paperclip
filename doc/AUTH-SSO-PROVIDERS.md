# SSO / OAuth provider configuration

Status: Copy-paste setup recipes for identity providers
Applies to: `deploymentMode: authenticated` only

Paperclip signs users in against any OpenID Connect or OAuth 2.0 provider through
BetterAuth's `generic-oauth` plugin. This page is the per-provider cookbook. For
how MFA and SSO behave, the security model, and account linking, see
[AUTH-MFA-SSO.md](./AUTH-MFA-SSO.md).

Providers are listed under `auth.sso.providers` in `config.json` and are **off by
default**.

## Two configuration styles

Every provider is configured one of two ways. Which one you use depends on
whether the provider publishes an OIDC discovery document.

### 1. OIDC — discovery (preferred)

The provider publishes `/.well-known/openid-configuration`, and Paperclip fetches
the authorization, token and userinfo endpoints from it. One URL instead of three,
and it keeps working if the provider moves an endpoint.

```jsonc
{
  "providerId": "entra",
  "displayName": "Microsoft",
  "discoveryUrl": "https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration",
  "clientId": "<application-id>",
  "clientSecretEnv": "PAPERCLIP_SSO_ENTRA_CLIENT_SECRET",
  "scopes": ["openid", "email", "profile"],
  "disableSignUp": true
}
```

Use this for Microsoft Entra ID, Okta, Google Workspace, Auth0, Keycloak — any
modern OIDC provider.

### 2. OAuth 2.0 — explicit endpoints

For a provider with no discovery document, name the endpoints yourself. There is
no ID token in this flow, so `userInfoUrl` is **required** — it is the only place
the user's email can come from, and a login with no email is rejected.

```jsonc
{
  "providerId": "custom",
  "displayName": "Acme SSO",
  "authorizationUrl": "https://sso.acme.example/oauth2/authorize",
  "tokenUrl": "https://sso.acme.example/oauth2/token",
  "userInfoUrl": "https://sso.acme.example/oauth2/userinfo",
  "clientId": "<client-id>",
  "clientSecretEnv": "PAPERCLIP_SSO_ACME_CLIENT_SECRET",
  "scopes": ["email", "profile"],
  "disableSignUp": true
}
```

Config validation requires **`discoveryUrl`, or `issuer`, or both
`authorizationUrl` and `tokenUrl`**. Anything else is rejected at startup.

## Field reference

| Field | Required | Notes |
| --- | --- | --- |
| `providerId` | yes | Stable id. Appears in the callback URL and in the `account.provider_id` column — **changing it orphans existing linked accounts**. |
| `clientId` | yes | From the provider's app registration. |
| `clientSecretEnv` | yes | *Name* of the env var holding the secret. The secret itself never goes in `config.json`. |
| `discoveryUrl` | one of | OIDC discovery document. |
| `issuer` | one of | Issuer identifier; also validates the `iss` callback parameter. |
| `authorizationUrl` + `tokenUrl` | one of | Explicit OAuth 2.0 endpoints. |
| `userInfoUrl` | see notes | Optional with discovery; **required** for plain OAuth 2.0. |
| `scopes` | no | Defaults to `["openid","email","profile"]`. Use `["email","profile"]` for non-OIDC. |
| `displayName` | no | Button label. Defaults to `providerId`. |
| `disableSignUp` | no | Defaults `false`. Set `true` to allow only pre-provisioned users. |

### The redirect URI

Register this with every provider, substituting your `providerId`:

```
https://<publicBaseUrl>/api/auth/oauth2/callback/<providerId>
```

It must match exactly, including case. No new Express routes are needed — the
existing `/api/auth/*` catch-all forwards it.

### Secrets

Each provider names an env var via `clientSecretEnv`, conventionally
`PAPERCLIP_SSO_<PROVIDER>_CLIENT_SECRET`. These live alongside
`BETTER_AUTH_SECRET` in the process environment (on a managed host, delivered to
`/etc/sonisoft/paperclip.env` via IAC/Infisical).

A provider whose secret env var is unset is **skipped**: an error is logged at
startup, it is absent from `GET /api/auth/config`, and no sign-in button appears.
A misconfigured provider can never stop the instance from booting.

---

## Microsoft Entra ID

> Verified end to end against a live tenant.

1. **Entra admin center → Identity → Applications → App registrations → New registration**
   - Supported account types: *Accounts in this organizational directory only*
   - Redirect URI: platform **Web** →
     `https://<publicBaseUrl>/api/auth/oauth2/callback/entra`
2. **Certificates & secrets → New client secret.** Copy the *Value* (not the Secret ID) — shown once.
3. **Token configuration → Add optional claim → ID → `email`.** ⚠️ **Do not skip.**
   Entra omits `email` from the ID token by default, and a login with no email is
   rejected with `email_is_missing`. The account must also have a real mail
   attribute populated.
4. Copy the **Directory (tenant) ID** and **Application (client) ID** from Overview.

```jsonc
{
  "providerId": "entra",
  "displayName": "Microsoft",
  "discoveryUrl": "https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration",
  "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
  "clientId": "<application-id>",
  "clientSecretEnv": "PAPERCLIP_SSO_ENTRA_CLIENT_SECRET",
  "scopes": ["openid", "email", "profile"],
  "disableSignUp": true
}
```

**Local testing:** Entra requires HTTPS for Web redirect URIs, with
`http://localhost` as the only documented exception — `http://127.0.0.1` is
**not** accepted. Use `localhost` consistently: the OAuth state cookie is scoped
to the host that started the flow, and browsers treat `localhost` and `127.0.0.1`
as different hosts, so mixing them breaks the callback.

## Okta

> Written from Okta's documentation; not verified against a live tenant.

Applications → Create App Integration → **OIDC / Web Application**. Sign-in
redirect URI: `https://<publicBaseUrl>/api/auth/oauth2/callback/okta`.

```jsonc
{
  "providerId": "okta",
  "displayName": "Okta",
  "discoveryUrl": "https://<org>.okta.com/.well-known/openid-configuration",
  "clientId": "<client-id>",
  "clientSecretEnv": "PAPERCLIP_SSO_OKTA_CLIENT_SECRET",
  "scopes": ["openid", "email", "profile"],
  "disableSignUp": true
}
```

Custom authorization servers use
`https://<org>.okta.com/oauth2/<server-id>/.well-known/openid-configuration`.

## Google Workspace

> Written from Google's documentation; not verified against a live tenant.

Google Cloud console → APIs & Services → Credentials → **OAuth client ID** → *Web
application*. Authorised redirect URI:
`https://<publicBaseUrl>/api/auth/oauth2/callback/google`.

```jsonc
{
  "providerId": "google",
  "displayName": "Google",
  "discoveryUrl": "https://accounts.google.com/.well-known/openid-configuration",
  "clientId": "<client-id>.apps.googleusercontent.com",
  "clientSecretEnv": "PAPERCLIP_SSO_GOOGLE_CLIENT_SECRET",
  "scopes": ["openid", "email", "profile"],
  "disableSignUp": true
}
```

Google does not restrict sign-in to your domain by itself. Keep `disableSignUp:
true` and provision by invite, or anyone with a Google account can authenticate.

## Auth0

> Written from Auth0's documentation; not verified against a live tenant.

Applications → Create Application → **Regular Web Application**. Allowed Callback
URL: `https://<publicBaseUrl>/api/auth/oauth2/callback/auth0`.

```jsonc
{
  "providerId": "auth0",
  "displayName": "Auth0",
  "discoveryUrl": "https://<tenant>.<region>.auth0.com/.well-known/openid-configuration",
  "clientId": "<client-id>",
  "clientSecretEnv": "PAPERCLIP_SSO_AUTH0_CLIENT_SECRET",
  "scopes": ["openid", "email", "profile"],
  "disableSignUp": true
}
```

## Keycloak

> Written from Keycloak's documentation; not verified against a live server.

Create a client with **Client authentication** on (confidential). Valid redirect
URI: `https://<publicBaseUrl>/api/auth/oauth2/callback/keycloak`.

```jsonc
{
  "providerId": "keycloak",
  "displayName": "Keycloak",
  "discoveryUrl": "https://<host>/realms/<realm>/.well-known/openid-configuration",
  "clientId": "<client-id>",
  "clientSecretEnv": "PAPERCLIP_SSO_KEYCLOAK_CLIENT_SECRET",
  "scopes": ["openid", "email", "profile"],
  "disableSignUp": true
}
```

## Multiple providers

Configure as many as you like; each renders its own sign-in button.

```jsonc
"sso": {
  "enabled": true,
  "providers": [
    { "providerId": "entra",  "displayName": "Microsoft", "...": "..." },
    { "providerId": "google", "displayName": "Google",    "...": "..." }
  ]
}
```

Each needs its own redirect URI registered with its own provider, and its own
secret env var. A user who signs in with two different providers using the same
email address ends up as **one user with two `account` rows**.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `email_is_missing` | Provider returned no email. On Entra, add the `email` optional claim. On plain OAuth 2.0, set `userInfoUrl`. Check the account actually has an email. |
| `account_not_linked` | A user with that email exists but linking was refused. See account linking in [AUTH-MFA-SSO.md](./AUTH-MFA-SSO.md). |
| `Invalid origin` / `Invalid callbackURL` (403) | The browser's origin is not trusted. Add the hostname to `server.allowedHostnames`, and make sure you are browsing the same host as `auth.publicBaseUrl`. |
| Provider's button never appears | Its `clientSecretEnv` variable is unset, so it was skipped. Check the startup log and `GET /api/auth/config`. |
| `AADSTS`… / `redirect_uri_mismatch` | The provider rejected the request before reaching Paperclip — almost always a redirect URI that does not match exactly. |
| Signed in, but "no access" | Expected. SSO proves identity only; access comes from an instance role or a company membership granted by invite. |
| State/PKCE errors on callback | The flow started on a different host than it finished on (e.g. `127.0.0.1` → `localhost`). Use one hostname throughout. |

Server-side failures are logged with the provider id. `GET /api/auth/config` shows
which providers actually resolved a secret at boot.

## Not supported

- **Built-in social-provider shorthand.** BetterAuth's `socialProviders` block
  (one-line Google/GitHub/Apple config) is not wired up. Those providers still
  work — configure them as OIDC providers above.
- **SAML.** `generic-oauth` is OIDC/OAuth 2.0 only. A SAML-only IdP would need the
  separate `@better-auth/sso` package, which is not installed.
- **Per-provider claim mapping.** There is no `mapProfileToUser` hook exposed in
  config, so a provider that reports email under a non-standard claim is not
  supported without a code change.
