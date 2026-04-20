import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "flodex dashboard",
  description: "client-side debug view for the flodex network",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
