import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { authRoutes } from "../routes/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createUpdateChain(row: unknown) {
  return {
    set(values: unknown) {
      return {
        where() {
          return {
            returning() {
              return Promise.resolve([{ ...(row as Record<string, unknown>), ...(values as Record<string, unknown>) }]);
            },
          };
        },
      };
    },
  };
}

function createDb(row: Record<string, unknown>) {
  return {
    select: () => createSelectChain([row]),
    update: () => createUpdateChain(row),
  } as any;
}

const DEFAULT_AUTH_CLIENT_CONFIG = {
  twoFactor: { enabled: false, enforcement: "optional" as const },
  sso: { providers: [] },
};

function createApp(
  actor: Express.Request["actor"],
  row: Record<string, unknown>,
  authClientConfig = DEFAULT_AUTH_CLIENT_CONFIG,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api/auth", authRoutes(createDb(row), authClientConfig));
  app.use(errorHandler);
  return app;
}

describe.sequential("auth routes", () => {
  const baseUser = {
    id: "user-1",
    name: "Jane Example",
    email: "jane@example.com",
    image: "https://example.com/jane.png",
  };

  it("returns the persisted user profile in the session payload", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session: {
        id: "paperclip:session:user-1",
        userId: "user-1",
      },
      user: { ...baseUser, twoFactorEnabled: false },
    });
  });

  it("updates the signed-in profile", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Board Operator", image: "" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-1",
      name: "Board Operator",
      email: "jane@example.com",
      image: null,
    });
  });

  it("preserves the existing avatar when updating only the profile name", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Board Operator" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-1",
      name: "Board Operator",
      email: "jane@example.com",
      image: "https://example.com/jane.png",
    });
  });

  it("accepts Paperclip asset paths for avatars", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Jane Example", image: "/api/assets/asset-1/content" });

    expect(res.status).toBe(200);
    expect(res.body.image).toBe("/api/assets/asset-1/content");
  });

  it("rejects invalid avatar image references", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Jane Example", image: "not-a-url" });

    expect(res.status).toBe(400);
  });
});

describe.sequential("auth client config route", () => {
  const baseUser = { id: "user-1", name: "Jane", email: "jane@example.com", image: null };

  it("is reachable without authentication so the sign-in page can read it", async () => {
    const app = createApp({ type: "none", source: "none" }, baseUser, {
      twoFactor: { enabled: true, enforcement: "required" },
      sso: { providers: [{ providerId: "okta", displayName: "Okta" }] },
    });

    const res = await request(app).get("/api/auth/config");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      twoFactor: { enabled: true, enforcement: "required" },
      sso: { providers: [{ providerId: "okta", displayName: "Okta" }] },
    });
  });

  it("reports everything off by default", async () => {
    const app = createApp({ type: "none", source: "none" }, baseUser);

    const res = await request(app).get("/api/auth/config");

    expect(res.status).toBe(200);
    expect(res.body.twoFactor.enabled).toBe(false);
    expect(res.body.sso.providers).toEqual([]);
  });
});

describe.sequential("totp qr route", () => {
  const baseUser = { id: "user-1", name: "Jane", email: "jane@example.com", image: null };
  const boardActor = { type: "board", userId: "user-1", source: "session" } as Express.Request["actor"];

  it("renders an otpauth URI as an SVG", async () => {
    const app = createApp(boardActor, baseUser);

    const res = await request(app)
      .post("/api/auth/totp-qr")
      .send({ totpURI: "otpauth://totp/Paperclip:jane@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Paperclip" });

    expect(res.status).toBe(200);
    expect(res.body.svg).toContain("<svg");
  });

  it("rejects a non-otpauth URI", async () => {
    const app = createApp(boardActor, baseUser);

    const res = await request(app)
      .post("/api/auth/totp-qr")
      .send({ totpURI: "https://evil.example.test/phish" });

    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const app = createApp({ type: "none", source: "none" }, baseUser);

    const res = await request(app)
      .post("/api/auth/totp-qr")
      .send({ totpURI: "otpauth://totp/Paperclip:jane@example.com?secret=JBSWY3DPEHPK3PXP" });

    expect(res.status).toBe(401);
  });
});
