import { brand, brandLine } from "@valtrexia/core";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

// Archivo, self-hosted (SIL Open Font License, see ./fonts/OFL.txt). One
// variable file covers every weight and the width axis.
const archivo = localFont({
  src: "./fonts/archivo-latin-variable.woff2",
  variable: "--font-archivo",
  weight: "100 900",
  display: "swap",
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
});

export const metadata: Metadata = {
  title: { default: brandLine(), template: `%s · ${brand.name}` },
  description: brand.description,
  applicationName: brand.name,
  icons: { icon: brand.logo.mark },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0e1630",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>{children}</body>
    </html>
  );
}
