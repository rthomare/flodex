import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { Nav } from "@/components/Nav";
import { OnChain } from "@/components/OnChain";
import { Problem } from "@/components/Problem";
import { Status } from "@/components/Status";
import { Tiers, TiersMobile } from "@/components/Tiers";

export default function Page() {
  return (
    <main className="relative">
      <Nav />
      <Hero />
      <Problem />
      <HowItWorks />
      <Tiers />
      <TiersMobile />
      <OnChain />
      <Status />
      <Footer />
    </main>
  );
}
