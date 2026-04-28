import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "fldx — encrypted, decentralized LLM execution",
  description:
    "End-to-end encrypted requests. Pluggable trust tiers. On-chain settlement on Base. fldx is a decentralized LLM execution network where the operator never sees your data.",
  metadataBase: new URL("https://fldx.ai"),
  openGraph: {
    title: "fldx — encrypted, decentralized LLM execution",
    description:
      "End-to-end encrypted requests. Pluggable trust tiers. On-chain settlement on Base.",
    url: "https://fldx.ai",
    siteName: "fldx",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "fldx — encrypted, decentralized LLM execution",
    description:
      "End-to-end encrypted requests. Pluggable trust tiers. On-chain settlement on Base.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
