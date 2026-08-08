import MatchFinder from "@/components/match-finder";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="relative flex flex-1 flex-col items-center overflow-hidden px-6 pb-24 pt-20 sm:pt-28">
        <div className="relative z-10 w-full max-w-2xl text-center">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.4em] text-slate">
            Reel Match &middot; a Letterboxd taste finder
          </p>
          <h1 className="mt-7 font-display text-5xl font-semibold leading-[1.02] tracking-tight text-bone sm:text-7xl">
            Who shares
            <br />
            your <em className="text-amber not-italic">Top&nbsp;4</em>?
          </h1>
          <p className="mx-auto mt-7 max-w-md text-base leading-7 text-slate">
            Type your Letterboxd username. We&rsquo;ll find the people whose
            favorite films overlap with yours — and tell you exactly how much
            you match.
          </p>

          <MatchFinder />
        </div>
      </section>
    </main>
  );
}
