import MatchFinder from "@/components/match-finder";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="relative flex flex-1 flex-col items-center overflow-hidden px-6 pb-24 pt-20 sm:pt-28">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[-14rem] h-[30rem] w-[46rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(233,161,59,0.16),transparent)]"
        />

        <div className="relative z-10 w-full max-w-2xl text-center">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.35em] text-slate">
            Reel Match &middot; Letterboxd taste finder
          </p>
          <h1 className="mt-6 font-display text-5xl font-extrabold leading-[0.95] tracking-tight text-bone sm:text-7xl">
            Who shares
            <br />
            your <span className="text-amber">Top&nbsp;4</span>?
          </h1>
          <p className="mx-auto mt-6 max-w-md text-base leading-7 text-slate">
            Enter your Letterboxd username. We scan the fans of your four
            favorite films and surface the profiles that overlap with your
            taste.
          </p>

          <MatchFinder />
        </div>
      </section>
    </main>
  );
}
