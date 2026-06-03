# VaronEnglish SEO Landing Page Prompt

Create a public-facing, SEO-friendly landing experience for `varonenglishapp.in` while preserving the existing product application on `app.varonenglishapp.in`.

## Goals

- Make `VaronEnglish` easier to discover in Google search.
- Give search engines a content-rich homepage with clear brand, product, and category signals.
- Keep the logged-in product app separate from the public marketing homepage.
- Strengthen metadata, canonical URLs, and structured data for both experiences.

## Required Behavior

- `varonenglishapp.in` and `www.varonenglishapp.in` should render a public landing page.
- `app.varonenglishapp.in` should continue to render the full product app.
- The landing page should feel premium, mobile-first, and branded around the supplied VaronEnglish logo.
- The landing page should include crawlable copy about:
  - English learning
  - competitive exam preparation
  - practice tests
  - live classes
  - progress tracking
  - web and mobile availability

## SEO Requirements

- Set host-specific:
  - `title`
  - `meta description`
  - `canonical`
  - Open Graph tags
  - Twitter tags
- Add JSON-LD structured data for:
  - `Organization`
  - `WebSite`
  - `SoftwareApplication`
- Keep indexing enabled.
- Ensure sitemap and robots remain valid.

## UX Requirements

- Use a strong hero with a clear headline and CTA.
- Add sections for features, benefits, learner workflow, and trust-building copy.
- Make the root-domain page understandable even for first-time visitors.
- Include a clear CTA to open the app on `app.varonenglishapp.in`.
- Design should feel intentional and modern, not generic.

## Technical Constraints

- Do not break the existing app on `app.varonenglishapp.in`.
- Prefer a host-based experience switch in the frontend entry point.
- Keep the implementation maintainable and easy to extend later.

## Definition of Done

- Root domain serves an SEO landing page.
- App subdomain serves the application.
- Metadata changes based on hostname.
- Build succeeds.
- The landing page is ready for indexing once DNS/redirect rules allow the root domain to load directly.
