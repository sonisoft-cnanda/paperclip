import { z } from "zod";
import {
  AUTH_BASE_URL_MODES,
  AUTH_TWO_FACTOR_ENFORCEMENTS,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
} from "./constants.js";
import { validateConfiguredBindMode } from "./network-bind.js";

export const configMetaSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  source: z.enum(["onboard", "configure", "doctor"]),
});

export const llmConfigSchema = z.object({
  provider: z.enum(["claude", "openai"]),
  apiKey: z.string().optional(),
});

export const databaseBackupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
  retentionDays: z.number().int().min(1).max(3650).default(7),
  dir: z.string().default("~/.paperclip/instances/default/data/backups"),
});

export const databaseConfigSchema = z.object({
  mode: z.enum(["embedded-postgres", "postgres"]).default("embedded-postgres"),
  connectionString: z.string().optional(),
  embeddedPostgresDataDir: z.string().default("~/.paperclip/instances/default/db"),
  embeddedPostgresPort: z.number().int().min(1).max(65535).default(54329),
  backup: databaseBackupConfigSchema.default({
    enabled: true,
    intervalMinutes: 60,
    retentionDays: 7,
    dir: "~/.paperclip/instances/default/data/backups",
  }),
});

export const loggingConfigSchema = z.object({
  mode: z.enum(["file", "cloud"]),
  logDir: z.string().default("~/.paperclip/instances/default/logs"),
});

export const serverConfigSchema = z.object({
  deploymentMode: z.enum(DEPLOYMENT_MODES).default("local_trusted"),
  exposure: z.enum(DEPLOYMENT_EXPOSURES).default("private"),
  bind: z.enum(BIND_MODES).optional(),
  customBindHost: z.string().optional(),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3100),
  allowedHostnames: z.array(z.string().min(1)).default([]),
  serveUi: z.boolean().default(true),
});

export const authTwoFactorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // "optional": users opt in from profile settings.
  // "required": enrolled users are challenged and un-enrolled users are pushed to enrollment.
  enforcement: z.enum(AUTH_TWO_FACTOR_ENFORCEMENTS).default("optional"),
});

export const authSsoProviderConfigSchema = z.object({
  providerId: z.string().min(1),
  discoveryUrl: z.string().url().optional(),
  issuer: z.string().url().optional(),
  authorizationUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  userInfoUrl: z.string().url().optional(),
  clientId: z.string().min(1),
  // Name of the process.env var holding the client secret. The secret itself is
  // never stored in config.json — see server/src/auth/better-auth.ts.
  clientSecretEnv: z.string().min(1),
  scopes: z.array(z.string().min(1)).default(["openid", "email", "profile"]),
  displayName: z.string().min(1).optional(),
  // When true, an SSO login only succeeds for a user that already exists —
  // typically one pre-provisioned via a company invite. Without this, anyone in
  // the IdP's directory can authenticate and be created as a Paperclip user
  // (they land with no company access, but the row exists). Note this is
  // separate from `auth.disableSignUp`, which only governs email/password.
  disableSignUp: z.boolean().default(false),
}).refine(
  (value) => Boolean(value.discoveryUrl ?? value.issuer ?? (value.authorizationUrl && value.tokenUrl)),
  { message: "Provide discoveryUrl, issuer, or both authorizationUrl and tokenUrl" },
);

export const authSsoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(authSsoProviderConfigSchema).default([]),
});

export const authConfigSchema = z.object({
  baseUrlMode: z.enum(AUTH_BASE_URL_MODES).default("auto"),
  publicBaseUrl: z.string().url().optional(),
  disableSignUp: z.boolean().default(false),
  twoFactor: authTwoFactorConfigSchema.default({ enabled: false, enforcement: "optional" }),
  sso: authSsoConfigSchema.default({ enabled: false, providers: [] }),
});

export const storageLocalDiskConfigSchema = z.object({
  baseDir: z.string().default("~/.paperclip/instances/default/data/storage"),
});

export const storageS3ConfigSchema = z.object({
  bucket: z.string().min(1).default("paperclip"),
  region: z.string().min(1).default("us-east-1"),
  endpoint: z.string().optional(),
  prefix: z.string().default(""),
  forcePathStyle: z.boolean().default(false),
});

export const storageConfigSchema = z.object({
  provider: z.enum(STORAGE_PROVIDERS).default("local_disk"),
  localDisk: storageLocalDiskConfigSchema.default({
    baseDir: "~/.paperclip/instances/default/data/storage",
  }),
  s3: storageS3ConfigSchema.default({
    bucket: "paperclip",
    region: "us-east-1",
    prefix: "",
    forcePathStyle: false,
  }),
});

export const secretsLocalEncryptedConfigSchema = z.object({
  keyFilePath: z.string().default("~/.paperclip/instances/default/secrets/master.key"),
});

export const secretsConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS).default("local_encrypted"),
  strictMode: z.boolean().default(false),
  localEncrypted: secretsLocalEncryptedConfigSchema.default({
    keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
  }),
});

export const telemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).default({});

export const paperclipConfigSchema = z
  .object({
    $meta: configMetaSchema,
    llm: llmConfigSchema.optional(),
    database: databaseConfigSchema,
    logging: loggingConfigSchema,
    server: serverConfigSchema,
    telemetry: telemetryConfigSchema,
    auth: authConfigSchema.default({
      baseUrlMode: "auto",
      disableSignUp: false,
    }),
    storage: storageConfigSchema.default({
      provider: "local_disk",
      localDisk: {
        baseDir: "~/.paperclip/instances/default/data/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    }),
    secrets: secretsConfigSchema.default({
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
      },
    }),
  })
  .superRefine((value, ctx) => {
    if (value.server.deploymentMode === "local_trusted" && value.server.exposure !== "private") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "server.exposure must be private when deploymentMode is local_trusted",
        path: ["server", "exposure"],
      });
    }

    for (const message of validateConfiguredBindMode({
      deploymentMode: value.server.deploymentMode,
      deploymentExposure: value.server.exposure,
      bind: value.server.bind,
      host: value.server.host,
      customBindHost: value.server.customBindHost,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: message.includes("customBindHost") ? ["server", "customBindHost"] : ["server", "bind"],
      });
    }

    if (value.auth.baseUrlMode === "explicit" && !value.auth.publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.publicBaseUrl is required when auth.baseUrlMode is explicit",
        path: ["auth", "publicBaseUrl"],
      });
    }

    if (value.server.exposure === "public" && value.auth.baseUrlMode !== "explicit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.baseUrlMode must be explicit when deploymentMode=authenticated and exposure=public",
        path: ["auth", "baseUrlMode"],
      });
    }

    if (value.server.exposure === "public" && !value.auth.publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.publicBaseUrl is required when deploymentMode=authenticated and exposure=public",
        path: ["auth", "publicBaseUrl"],
      });
    }
  });

export type PaperclipConfig = z.infer<typeof paperclipConfigSchema>;
export type LlmConfig = z.infer<typeof llmConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type StorageLocalDiskConfig = z.infer<typeof storageLocalDiskConfigSchema>;
export type StorageS3Config = z.infer<typeof storageS3ConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
export type SecretsLocalEncryptedConfig = z.infer<typeof secretsLocalEncryptedConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type AuthTwoFactorConfig = z.infer<typeof authTwoFactorConfigSchema>;
export type AuthSsoConfig = z.infer<typeof authSsoConfigSchema>;
export type AuthSsoProviderConfig = z.infer<typeof authSsoProviderConfigSchema>;
export type TelemetryConfig = z.infer<typeof telemetryConfigSchema>;
export type ConfigMeta = z.infer<typeof configMetaSchema>;
export type DatabaseBackupConfig = z.infer<typeof databaseBackupConfigSchema>;
