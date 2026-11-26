import type { AuthConfig } from "convex/server";

// Clerk JWT verification for Convex.
// Set CLERK_JWT_ISSUER_DOMAIN on the Convex deployment (without a trailing slash):
//   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-instance>.clerk.accounts.dev
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
