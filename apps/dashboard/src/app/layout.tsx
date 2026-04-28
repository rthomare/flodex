import type { Metadata } from "next";
import "./globals.css";
import Providers from "@/components/Providers";

export const metadata: Metadata = {
  title: "fldx dashboard",
  description: "client-side debug view for the fldx network",
};

// Sync the theme attribute before React hydrates to avoid a flash on load.
const themeBootstrap = `
  try {
    var t = localStorage.getItem("fldx-theme");
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
