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

> Verified end to end against a live tenant: registration, consent, callback,
> token exchange, session creation and account linking.

### Use App registrations, not Enterprise applications

This is the single most common wrong turn. In Entra:

- **App registrations** is where **OIDC / OAuth 2.0** apps are configured. This is
  what Paperclip needs.
- **Enterprise applications → Single sign-on** offers only **SAML**,
  password-based and linked sign-on. There is no OIDC option there, and Paperclip
  does not support SAML.

Registering the app automatically creates a matching Enterprise application
(the service principal). You go back to it later only to restrict *who* may sign
in — see [Restricting who can sign in](#restricting-who-can-sign-in-recommended).

### 1. Register the application

Requires at least the **Application Developer** role.

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com).
2. If you belong to several tenants, use the **Settings** icon in the top bar to
   switch to the right one.
3. Browse to **Entra ID** → **App registrations** → **New registration**.
4. **Name**: anything meaningful, e.g. `Paperclip`. Users can see it, and it can
   be changed later.
5. **Supported account types** — pick **Single tenant only – &lt;your tenant&gt;**
   unless you have a specific reason not to:

   | Option | Use when |
   | --- | --- |
   | **Single tenant only – &lt;your tenant&gt;** | Normal case. Only users and guests in your directory. |
   | **Multiple Entra ID tenants** | A multi-org SaaS deployment. |
   | **Any Entra ID Tenant + Personal Microsoft accounts** | Also allows Xbox/Live/Hotmail accounts. |
   | **Personal accounts only** | Consumer accounts only. |

6. **Redirect URI**: choose platform **Web**, then enter, substituting your
   `providerId`:

   ```
   https://<publicBaseUrl>/api/auth/oauth2/callback/entra
   ```

7. Select **Register**.

### 2. Add a client secret

1. On the app, go to **Manage** → **Certificates & secrets** → **Client secrets**
   → **New client secret**.
2. Add a description and choose an expiry (or a custom lifetime).
3. Select **Add**, then immediately copy the **Value** column.

> Copy the **Value**, not the **Secret ID**. The Value is displayed only once —
> navigate away and it is unrecoverable and you must create a new secret.
>
> Secrets expire. Note the expiry date; Paperclip will start rejecting SSO logins
> when it lapses, and a rotated secret only needs the env var updated and the
> process restarted — no config change.

### 3. Add the `email` optional claim — required

Requires at least the **Cloud Application Administrator** role.

1. On the app, go to **Manage** → **Token configuration**.
2. Select **Add optional claim**.
3. Choose token type **ID**.
4. Tick **email**, then select **Add**.
5. If the portal offers to turn on the related Microsoft Graph permission, accept.

**Why this is mandatory.** Entra keeps tokens small and omits `email` by default.
BetterAuth reads the ID token and only accepts it when both `sub` and `email` are
present, otherwise falling back to the userinfo endpoint; with no email anywhere,
the callback aborts and Paperclip logs `email_is_missing`. Paperclip identifies
and links users by email address, so there is no way around this.

> Even with the claim added, Entra emits it only when the account actually has a
> mail attribute populated. Accounts with no mailbox — some service or admin
> accounts, and some guest accounts — can still arrive without an email. Test
> with a normal user who has a real mailbox.

### 4. Collect the identifiers

From the app's **Overview** page:

- **Directory (tenant) ID** → goes into the discovery URL
- **Application (client) ID** → `clientId`

### 5. Configure Paperclip

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

Set the secret in the environment, not in config:

```bash
PAPERCLIP_SSO_ENTRA_CLIENT_SECRET='<the Value you copied>'
```

Restart, then confirm the provider actually registered:

```bash
curl -s https://<publicBaseUrl>/api/auth/config
# {"twoFactor":{...},"sso":{"providers":[{"providerId":"entra","displayName":"Microsoft"}]}}
```

An empty `providers` array means the secret env var was unset, so the provider
was skipped — check the startup log for the warning naming it.

### Restricting who can sign in (recommended)

By default **anyone in your directory** can authenticate. Two independent
controls, best used together:

**Entra side** — restrict at the IdP, so unassigned users never even reach
Paperclip:

1. **Entra ID** → **Enterprise apps** → select your app.
2. **Manage** → **Properties** → set **Assignment required?** to **Yes**, Save.
3. **Manage** → **Users and groups** → **Add user/group** — assign a security
   group rather than individuals where you can.

> ⚠️ **Global Administrators are exempt from assignment restrictions by design.**
> If you are testing with a Global Admin account it will sign in regardless of
> the setting, which looks like the restriction is broken. Test with a standard
> user.

**Paperclip side** — `"disableSignUp": true` on the provider, so an SSO login only
succeeds for a user that already exists. Keep this on regardless: it is the
authoritative control, and it is what makes
[account linking](./AUTH-MFA-SSO.md#account-linking) safe.

### Local testing

Entra requires HTTPS for Web redirect URIs, with **`http://localhost` as the only
documented exception** — `http://127.0.0.1` is **not** accepted for the Web
platform.

Use `localhost` consistently for the whole flow. The OAuth state cookie is scoped
to the host that started it, and browsers treat `localhost` and `127.0.0.1` as
different hosts, so starting on one and finishing on the other fails the callback
with a state error. Set `auth.publicBaseUrl` to `http://localhost:<port>` and
include `localhost` in `server.allowedHostnames`.

Redirect URIs are **case-sensitive** and must match exactly. Avoid registering
several localhost URIs that differ only by port — Entra picks one arbitrarily;
differentiate by path instead.

### Entra troubleshooting

| Symptom | Cause |
| --- | --- |
| `email_is_missing` | The `email` optional claim is missing, or the account has no mail attribute. |
| `AADSTS50011` redirect mismatch | The registered redirect URI does not match exactly — check scheme, port, case and the `providerId` segment. |
| `AADSTS7000215` invalid client secret | Wrong value (Secret ID instead of Value), or the secret expired. |
| `AADSTS50105` user not assigned | **Assignment required?** is on and the user is not assigned. Expected — assign them. |
| Restriction seems ignored | You are testing as a Global Administrator, who bypasses assignment by design. |
| Only SAML options are offered | You are in **Enterprise applications → Single sign-on**. OIDC lives in **App registrations**. |
| App missing from users' My Apps | New registrations are hidden by default. **Enterprise apps** → app → **Properties** → **Visible to users?** → **Yes**. |

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
