import type { Metadata } from "next";
import * as React from "react";
import "./globals.css";
export const metadata: Metadata = {
  title: "Aegis | Presence, not just appearance",
  description: "A transparent, browser-only identity-verification prototype. Layered evidence, local camera processing, and clearly labeled simulations.",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a href="#main-content" className="skip-link">Skip to content</a>{children}</body></html>;
}
