import { ArrowRight, BarChart3, BookOpenText, CheckCircle2, Globe, LaptopMinimal, PlayCircle, ShieldCheck, Smartphone, Sparkles, Target, Trophy, Users } from 'lucide-react';

const appUrl = 'https://app.varonenglishapp.in/';
const rootUrl = 'https://varonenglishapp.in/';
const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.varoonenglish.app';

const featureCards = [
  {
    icon: BookOpenText,
    title: 'Exam-focused English',
    body: 'Build grammar, vocabulary, comprehension, and test confidence with structured English prep for competitive exams.',
  },
  {
    icon: Trophy,
    title: 'Mock tests and revision',
    body: 'Practice with exam-style tests, review your weak areas, and keep revision close to the lessons that matter most.',
  },
  {
    icon: Users,
    title: 'Guided preparation flow',
    body: 'Stay consistent with structured lessons, revision support, and a disciplined preparation routine.',
  },
  {
    icon: BarChart3,
    title: 'Progress you can track',
    body: 'See accuracy, speed, streaks, and performance trends so your preparation becomes measurable, not guesswork.',
  },
];

const examSignals = [
  'English for competitive exams',
  'Mock tests and practice sets',
  'Revision and practice support',
  'Mobile and web learning',
];

const highlights = [
  'Designed for learners preparing seriously, not casually browsing.',
  'Built to combine lessons, tests, analytics, and revision support in one place.',
  'Optimized for mobile-first study sessions with a faster path back into learning.',
];

const steps = [
  {
    title: 'Start with the right course',
    body: 'Open the app, choose your preparation path, and move directly into focused English practice.',
  },
  {
    title: 'Study, test, and revise',
    body: 'Learn concepts, attempt mock tests, and revisit weak topics before they become repeated mistakes.',
  },
  {
    title: 'Track improvement',
    body: 'Use performance insights to sharpen accuracy, speed, and consistency across your preparation cycle.',
  },
];

const faqs = [
  {
    q: 'What is VaronEnglish?',
    a: 'VaronEnglish, also searched as VaronEnglish App or VaronEnglishApp, is an English learning and competitive exam preparation platform built for learners who want lessons, mock tests, and progress tracking in one place.',
  },
  {
    q: 'Can I use VaronEnglish on mobile?',
    a: 'Yes. VaronEnglish is designed for mobile-first usage and also works on the web, making it easier to continue preparation from anywhere.',
  },
  {
    q: 'Is this only for English learners?',
    a: 'The core focus is English preparation for competitive exams, especially for learners who need practice, revision, and performance feedback.',
  },
];

export const PublicLandingPage = () => (
  <main className="min-h-screen overflow-hidden bg-[#070707] text-white">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(18,157,215,0.22),transparent_28%),radial-gradient(circle_at_80%_12%,rgba(255,200,28,0.16),transparent_24%),linear-gradient(180deg,#040404_0%,#0c1017_52%,#050505_100%)]" />

    <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-5 pb-20 pt-6 sm:px-8 lg:px-10">
      <header className="flex items-center justify-between gap-4 rounded-full border border-white/10 bg-white/6 px-4 py-3 backdrop-blur md:px-6">
        <a href={rootUrl} className="flex items-center gap-3">
          <img src="/varonenglish-logo.png" alt="VaronEnglish" className="h-11 w-11 rounded-full object-contain sm:h-12 sm:w-12" />
          <div className="hidden sm:block">
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[#f4c72f]">VaronEnglish</p>
            <p className="text-sm text-white/72">English for competitive exams</p>
          </div>
        </a>

        <div className="flex items-center gap-3">
          <a
            href={playStoreUrl}
            className="hidden rounded-full border border-[#f0c22b]/40 bg-[#f0c22b]/12 px-4 py-2 text-sm font-semibold text-[#ffe17f] transition hover:border-[#f0c22b]/70 hover:bg-[#f0c22b]/18 md:inline-flex"
          >
            Android app
          </a>
          <a
            href={appUrl}
            className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold text-[#07111f] transition hover:scale-[1.02]"
          >
            Open app
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </header>

      <section className="grid flex-1 items-center gap-14 py-14 lg:grid-cols-[1.08fr_0.92fr] lg:py-20">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[#129dd7]/35 bg-[#129dd7]/10 px-4 py-2 text-sm text-[#9ce2ff]">
            <Sparkles className="h-4 w-4" />
            Public homepage for VaronEnglish App and varonenglishapp.in
          </div>

          <h1 className="mt-6 max-w-4xl text-[clamp(2.7rem,6vw,5.6rem)] font-semibold leading-[0.95] tracking-[-0.04em] text-white">
            Learn English with a sharper edge for competitive exams.
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-8 text-white/74 sm:text-xl">
            VaronEnglish App, also known as VaronEnglishApp, is a mobile-first English learning app and web platform built for serious preparation. Study lessons, attempt mock tests, and track progress from one focused workspace.
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            {examSignals.map((item) => (
              <span key={item} className="rounded-full border border-white/12 bg-white/6 px-4 py-2 text-sm text-white/76">
                {item}
              </span>
            ))}
          </div>

          <div className="mt-9 flex flex-wrap gap-4">
            <a
              href={appUrl}
              className="inline-flex items-center gap-2 rounded-full bg-[#1498d3] px-6 py-3 text-base font-bold text-white shadow-[0_18px_60px_rgba(20,152,211,0.32)] transition hover:bg-[#0f84bb]"
            >
              Start learning on web
              <LaptopMinimal className="h-5 w-5" />
            </a>
            <a
              href={playStoreUrl}
              className="inline-flex items-center gap-2 rounded-full border border-white/18 bg-white/8 px-6 py-3 text-base font-semibold text-white/92 transition hover:bg-white/12"
            >
              Get Android app
              <Smartphone className="h-5 w-5" />
            </a>
          </div>

          <div className="mt-10 grid gap-3 text-sm text-white/72">
            {highlights.map((item) => (
              <div key={item} className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#f3c532]" />
                <p>{item}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="relative">
          <div className="absolute -inset-5 rounded-[36px] bg-[radial-gradient(circle_at_top,rgba(255,194,19,0.18),transparent_40%),radial-gradient(circle_at_bottom_right,rgba(18,157,215,0.14),transparent_38%)] blur-2xl" />
          <div className="relative rounded-[34px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_100%)] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.42)] backdrop-blur">
            <div className="rounded-[28px] border border-white/8 bg-[#09101a] p-5">
              <div className="flex items-center justify-between rounded-[22px] border border-white/8 bg-white/5 px-4 py-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.25em] text-[#f4c72f]">VaronEnglish app</p>
                  <p className="mt-1 text-lg font-semibold text-white">English practice, lessons, and tests</p>
                </div>
                <Globe className="h-9 w-9 rounded-full bg-[#129dd7]/16 p-2 text-[#90ddff]" />
              </div>

              <div className="mt-5 overflow-hidden rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,#111b2a_0%,#0b121d_100%)]">
                <div className="border-b border-white/6 p-4">
                  <img src="/varonenglish-logo.png" alt="VaronEnglish competitive exam English app" className="mx-auto h-auto w-[148px] max-w-full rounded-full object-contain sm:w-[172px]" />
                </div>

                <div className="grid gap-3 p-4">
                  {featureCards.slice(0, 3).map(({ icon: Icon, title, body }) => (
                    <div key={title} className="rounded-[20px] border border-white/7 bg-white/5 p-4">
                      <div className="flex items-center gap-3">
                        <span className="rounded-2xl bg-[#f0c22b]/12 p-2 text-[#ffd762]">
                          <Icon className="h-5 w-5" />
                        </span>
                        <p className="text-[15px] font-semibold text-white">{title}</p>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-white/64">{body}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-3">
                <div className="rounded-[20px] border border-white/7 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Focus</p>
                  <p className="mt-2 text-lg font-semibold text-white">English prep</p>
                </div>
                <div className="rounded-[20px] border border-white/7 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Mode</p>
                  <p className="mt-2 text-lg font-semibold text-white">Web + Mobile</p>
                </div>
                <div className="rounded-[20px] border border-white/7 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Experience</p>
                  <p className="mt-2 text-lg font-semibold text-white">Study + Tests</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-4">
        {featureCards.map(({ icon: Icon, title, body }) => (
          <article key={title} className="rounded-[28px] border border-white/10 bg-white/6 p-6 backdrop-blur">
            <span className="inline-flex rounded-2xl bg-[#129dd7]/14 p-3 text-[#9fe5ff]">
              <Icon className="h-5 w-5" />
            </span>
            <h2 className="mt-4 text-2xl font-semibold text-white">{title}</h2>
            <p className="mt-3 leading-7 text-white/68">{body}</p>
          </article>
        ))}
      </section>

      <section className="mt-16 grid gap-7 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[30px] border border-[#f0c22b]/18 bg-[linear-gradient(180deg,rgba(240,194,43,0.12)_0%,rgba(255,255,255,0.03)_100%)] p-7">
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#ffd34a]">Why VaronEnglish</p>
          <h2 className="mt-4 text-4xl font-semibold leading-tight text-white">A public homepage that explains the brand before asking Google to rank it.</h2>
          <p className="mt-5 text-lg leading-8 text-white/74">
            Search engines understand brands better when they can crawl a clean homepage with meaningful content. This page gives VaronEnglish App a stronger identity around English learning, exam prep, tests, and student progress.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {steps.map(({ title, body }, index) => (
            <article key={title} className="rounded-[28px] border border-white/10 bg-white/6 p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-lg font-bold text-[#08121f]">
                {index + 1}
              </div>
              <h3 className="mt-5 text-2xl font-semibold text-white">{title}</h3>
              <p className="mt-3 leading-7 text-white/66">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-16 rounded-[34px] border border-white/10 bg-[linear-gradient(180deg,rgba(10,19,31,0.96)_0%,rgba(8,12,19,0.96)_100%)] p-8 sm:p-10">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8bdfff]">Search intent match</p>
            <h2 className="mt-4 text-4xl font-semibold text-white">When users search for VaronEnglish, they should find a real homepage, not only social profiles.</h2>
          </div>
          <a
            href={appUrl}
            className="inline-flex items-center gap-2 self-start rounded-full border border-white/12 bg-white/7 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/12"
          >
            Visit VaronEnglish app
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-[24px] border border-white/8 bg-white/4 p-5">
            <Target className="h-6 w-6 text-[#ffd34a]" />
            <p className="mt-4 text-lg font-semibold text-white">Brand clarity</p>
            <p className="mt-2 leading-7 text-white/65">The homepage repeatedly explains what VaronEnglish is and who it is for.</p>
            <p className="mt-2 text-sm leading-6 text-white/45">Including the exact brand variants VaronEnglish App and VaronEnglishApp.</p>
          </div>
          <div className="rounded-[24px] border border-white/8 bg-white/4 p-5">
            <PlayCircle className="h-6 w-6 text-[#8bdfff]" />
            <p className="mt-4 text-lg font-semibold text-white">Clear action</p>
            <p className="mt-2 leading-7 text-white/65">Visitors can move into the web app or the Android app from one obvious starting point.</p>
          </div>
          <div className="rounded-[24px] border border-white/8 bg-white/4 p-5">
            <ShieldCheck className="h-6 w-6 text-[#8dffb2]" />
            <p className="mt-4 text-lg font-semibold text-white">Better indexing signals</p>
            <p className="mt-2 leading-7 text-white/65">Metadata, structured data, and focused copy help search engines understand the site faster.</p>
          </div>
        </div>
      </section>

      <section className="mt-16 grid gap-4 lg:grid-cols-3">
        {faqs.map(({ q, a }) => (
          <article key={q} className="rounded-[26px] border border-white/10 bg-white/6 p-6">
            <h3 className="text-2xl font-semibold text-white">{q}</h3>
            <p className="mt-4 leading-7 text-white/66">{a}</p>
          </article>
        ))}
      </section>

      <section className="mt-16 rounded-[34px] border border-[#129dd7]/20 bg-[linear-gradient(135deg,rgba(18,157,215,0.18)_0%,rgba(255,194,43,0.12)_100%)] p-8 text-center sm:p-10">
        <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#b5ecff]">VaronEnglish</p>
        <h2 className="mt-4 text-4xl font-semibold text-white sm:text-5xl">A stronger homepage for search, and a cleaner path into the app.</h2>
        <p className="mx-auto mt-5 max-w-3xl text-lg leading-8 text-white/76">
          Open the app for learning, testing, and revision. Use the root domain as the public face of the brand so users and search engines understand what VaronEnglish App offers.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <a
            href={appUrl}
            className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-base font-bold text-[#08121f] transition hover:scale-[1.02]"
          >
            Open VaronEnglish app
            <ArrowRight className="h-5 w-5" />
          </a>
          <a
            href={playStoreUrl}
            className="inline-flex items-center gap-2 rounded-full border border-white/18 bg-white/8 px-6 py-3 text-base font-semibold text-white transition hover:bg-white/12"
          >
            Download on Android
            <Smartphone className="h-5 w-5" />
          </a>
        </div>
      </section>
    </div>
  </main>
);
