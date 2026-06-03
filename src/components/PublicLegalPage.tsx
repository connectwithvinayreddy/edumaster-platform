type PublicLegalPageProps = {
  title: string;
  intro: string;
  sections: Array<{ heading: string; body: string[] }>;
};

export const PublicLegalPage = ({ title, intro, sections }: PublicLegalPageProps) => (
  <main className="min-h-screen bg-[#070707] text-white">
    <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
      <a href="https://varonenglishapp.in/" className="inline-flex items-center rounded-full border border-white/12 bg-white/6 px-4 py-2 text-sm font-semibold text-white/86">
        Back to VaronEnglish
      </a>

      <div className="mt-8 rounded-[32px] border border-white/10 bg-white/6 p-7 sm:p-10">
        <h1 className="text-4xl font-semibold text-white sm:text-5xl">{title}</h1>
        <p className="mt-5 text-lg leading-8 text-white/72">{intro}</p>

        <div className="mt-10 space-y-8">
          {sections.map((section) => (
            <section key={section.heading}>
              <h2 className="text-2xl font-semibold text-white">{section.heading}</h2>
              <div className="mt-3 space-y-3 text-[15px] leading-7 text-white/68">
                {section.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  </main>
);
