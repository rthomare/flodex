import Dashboard from "@/components/Dashboard";

// Wagmi + RainbowKit need browser APIs (indexedDB) at hydration time;
// skip static generation so we don't try to run them server-side.
export const dynamic = "force-dynamic";

export default function Page() {
  return <Dashboard />;
}
