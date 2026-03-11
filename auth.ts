// ─────────────────────────────────────────────────────────────────
//  auth.ts — Better Auth configuration for Parallax
//
//  Supports email/password and Google OAuth.
//  Uses Neon Postgres (DATABASE_URL) for storage.
// ─────────────────────────────────────────────────────────────────

import { betterAuth } from "better-auth";
import { Pool } from "@neondatabase/serverless";
import { dash } from "@better-auth/infra";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.warn("⚠️  No DATABASE_URL set — auth will not work without a database.");
}

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
    ].filter(Boolean),
    plugins: [
        // dash() uses samlify which has a broken ESM dep (camelcase@9) — skip on Vercel
        ...(process.env.VERCEL ? [] : [dash()]),
    ]
});
