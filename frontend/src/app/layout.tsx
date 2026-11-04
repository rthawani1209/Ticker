import type { Metadata } from "next";
import { Chakra_Petch, Inter_Tight, JetBrains_Mono } from "next/font/google";

import { THEME_SCRIPT } from "@/lib/theme";

import "./globals.css";

const chakra = Chakra_Petch({
  variable: "--font-chakra",
  subsets: ["latin"],
  weight: ["500", "600"],
});
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Ticker",
  description:
    "A real stock exchange for your class: students and bots trading in a live simulated market.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${chakra.variable} ${interTight.variable} ${jetbrains.variable}`}
      // the theme script below may set data-theme before React hydrates
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
