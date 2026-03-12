// ─────────────────────────────────────────────────────────────────
//  auth.ts — Better Auth configuration for Parallax
//
//  Supports email/password and Google OAuth.
//  Uses Neon Postgres (DATABASE_URL) for storage.
// ─────────────────────────────────────────────────────────────────

import { betterAuth } from "better-auth";
import { Pool } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.warn("⚠️  No DATABASE_URL set — auth will not work without a database.");
}

// dash() pulls in samlify which tries to require() camelcase@9 (ESM-only),
// causing ERR_REQUIRE_ESM in serverless runtimes.  We use top-level await
// (safe in ESM — Node serialises module init) so the static import never
// runs in environments where it would break (VERCEL / Lambda).
const dashPlugins = process.env.VERCEL
    ? []
    : await import("@better-auth/infra")
          .then(({ dash }) => [dash()])
          .catch(() => []);

export const auth = betterAuth({
    database: DATABASE_URL
        ? new Pool({ connectionString: DATABASE_URL })
        : undefined as any,
    basePath: "/api/auth",
    secret: process.env.BETTER_AUTH_SECRET,
    emailAndPassword: {
        enabled: true,
    },
    socialProviders: {
        ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? {
            google: {
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
        } : {}),
    },
    trustedOrigins: [
        "http://localhost:7000",
        "http://localhost:3000",
        process.env.FRONTEND_URL || "",
        "https://useparallax.dev",
        "https://www.useparallax.dev",
        "https://app.useparallax.dev",
    ].filter(Boolean),
    plugins: dashPlugins,
});
