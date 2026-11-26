import React from "react";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "@/components/ConvexClientProvider";
import { clerkAppearance, clerkLocalization } from "@/components/clerk-theme";
import "@/extension/brand.css";
import "@/extension/scout.css";
import "./globals.css";

const nunito = localFont({
  src: "../extension/fonts/nunito-latin-wght-normal.woff2",
  weight: "400 900",
  variable: "--font-nunito",
  display: "swap",
});

const jetbrainsMono = localFont({
  src: "../extension/fonts/jetbrains-mono-latin-wght-normal.woff2",
  weight: "400 800",
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const FAVICON_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='33' fill='%231f1b16'/%3E%3Cg transform='translate(15 31) scale(1.08)'%3E%3Cpath d='M32 24V4.5' stroke='%23fff' stroke-width='2.6' stroke-linecap='round'/%3E%3Cpath d='M32 4.6 46 9.4 32 14.2Z' fill='%23ff6fa5'/%3E%3Cpath d='M27 24h54q5 0 3.42 4.74l-5.89 17.67Q76 54 68 54H38q-8 0-10.06-7.73l-4.65-17.44Q22 24 27 24Z' fill='%23ffd23f'/%3E%3Cpath d='M5 10.5h6.5L18 24h71' fill='none' stroke='%23fff' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cellipse cx='50' cy='37' rx='6.6' ry='7.2' fill='%23fff'/%3E%3Cellipse cx='66' cy='37' rx='6.6' ry='7.2' fill='%23fff'/%3E%3Ccircle cx='51.8' cy='37.6' r='3.6' fill='%231f1b16'/%3E%3Ccircle cx='67.8' cy='37.6' r='3.6' fill='%231f1b16'/%3E%3Ccircle cx='38' cy='62' r='8.5' fill='%23fff'/%3E%3Ccircle cx='70' cy='62' r='8.5' fill='%23fff'/%3E%3Ccircle cx='38' cy='62' r='3.1' fill='%231f1b16'/%3E%3Ccircle cx='70' cy='62' r='3.1' fill='%231f1b16'/%3E%3C/g%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "CartScout account",
  description: "Sign in to CartScout, see live member savings, compare prices and manage billing.",
  icons: { icon: FAVICON_DATA_URI },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#171510" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${nunito.variable} ${jetbrainsMono.variable}`}>
      <body>
        <ClerkProvider
          appearance={clerkAppearance as any}
          localization={clerkLocalization}
          signInUrl="/?intent=signin"
          signUpUrl="/?intent=signup"
          afterSignOutUrl="/"
        >
          <ConvexClientProvider>
            <div id="root">{children}</div>
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
