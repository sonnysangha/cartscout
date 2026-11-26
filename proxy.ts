import { clerkMiddleware } from "@clerk/nextjs/server";

// Next.js 16 + @clerk/nextjs v7 pattern: keep clerkMiddleware() bare and authorize inside each route handler.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|v1|trpc)(.*)",
  ],
};
