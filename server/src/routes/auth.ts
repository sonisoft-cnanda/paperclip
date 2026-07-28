import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import QRCode from "qrcode";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  authClientConfigSchema,
  authSessionSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
  type AuthClientConfig,
} from "@paperclipai/shared";
import { badRequest, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";

export const totpQrRequestSchema = z.object({
  totpURI: z.string().min(1).max(2048).startsWith("otpauth://"),
});

async function loadCurrentUserProfile(db: Db, userId: string) {
  const user = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
      twoFactorEnabled: authUsers.twoFactorEnabled,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    throw unauthorized("Signed-in user not found");
  }

  return currentUserProfileSchema.parse({
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
    twoFactorEnabled: user.twoFactorEnabled ?? false,
  });
}

export function authRoutes(db: Db, authClientConfig: AuthClientConfig) {
  const router = Router();

  router.get("/get-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await loadCurrentUserProfile(db, req.actor.userId);
    res.json(authSessionSchema.parse({
      session: {
        id: `paperclip:${req.actor.source ?? "none"}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user,
    }));
  });

  router.get("/profile", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    res.json(await loadCurrentUserProfile(db, req.actor.userId));
  });

  router.patch("/profile", validate(updateCurrentUserProfileSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const patch = updateCurrentUserProfileSchema.parse(req.body);
    const now = new Date();

    const updated = await db
      .update(authUsers)
      .set({
        name: patch.name,
        ...(patch.image !== undefined ? { image: patch.image } : {}),
        updatedAt: now,
      })
      .where(eq(authUsers.id, req.actor.userId))
      .returning({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
        twoFactorEnabled: authUsers.twoFactorEnabled,
      })
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      throw unauthorized("Signed-in user not found");
    }

    res.json(currentUserProfileSchema.parse({
      id: updated.id,
      email: updated.email ?? null,
      name: updated.name ?? null,
      image: updated.image ?? null,
      twoFactorEnabled: updated.twoFactorEnabled ?? false,
    }));
  });

  // Public: the sign-in page needs to know which auth flows exist before anyone
  // is authenticated. Contains no secrets — only enablement flags and the
  // provider ids that successfully resolved a client secret at boot.
  router.get("/config", (_req, res) => {
    res.json(authClientConfigSchema.parse(authClientConfig));
  });

  // Renders an `otpauth://` URI (obtained by the client from BetterAuth's
  // /two-factor/get-totp-uri) as an SVG QR code. Kept server-side so the
  // published @paperclipai/ui package gains no QR dependency.
  router.post("/totp-qr", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const parsed = totpQrRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("A totpURI beginning with otpauth:// is required");
    }

    const svg = await QRCode.toString(parsed.data.totpURI, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
    });
    res.json({ svg });
  });

  return router;
}
