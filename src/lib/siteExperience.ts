const ROOT_DOMAIN = 'varonenglishapp.in';
const APP_SUBDOMAIN = 'app.varonenglishapp.in';
const WWW_DOMAIN = 'www.varonenglishapp.in';

type MetaConfig = {
  title: string;
  description: string;
  canonical: string;
  ogUrl: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  twitterTitle: string;
  twitterDescription: string;
  jsonLd: Array<Record<string, unknown>>;
};

const rootPageMeta: MetaConfig = {
  title: 'VaronEnglish App | English Learning App for Competitive Exams',
  description:
    'VaronEnglish App, also searched as VaronEnglishApp, is an English learning app and web platform for competitive exam preparation with lessons, mock tests, and progress tracking.',
  canonical: 'https://varonenglishapp.in/',
  ogUrl: 'https://varonenglishapp.in/',
  ogTitle: 'VaronEnglish App | English Learning App for Competitive Exams',
  ogDescription:
    'Study English for competitive exams with VaronEnglish App, including lessons, mock tests, revision support, and mobile-first learning.',
  ogImage: 'https://varonenglishapp.in/og-image.png',
  twitterTitle: 'VaronEnglish App | English Learning App for Competitive Exams',
  twitterDescription:
    'VaronEnglishApp offers English learning, mock tests, and progress tracking for competitive exam preparation.',
  jsonLd: [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'VaronEnglish',
      alternateName: ['VaronEnglish App', 'VaronEnglishApp'],
      url: 'https://varonenglishapp.in/',
      logo: 'https://varonenglishapp.in/varonenglish-logo.png',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'VaronEnglish',
      alternateName: 'VaronEnglish App',
      url: 'https://varonenglishapp.in/',
      potentialAction: {
        '@type': 'SearchAction',
        target: 'https://varonenglishapp.in/?q={search_term_string}',
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'VaronEnglish',
      alternateName: ['VaronEnglish App', 'VaronEnglishApp'],
      applicationCategory: 'EducationalApplication',
      operatingSystem: 'Android, Web',
      url: 'https://varonenglishapp.in/',
      downloadUrl: 'https://play.google.com/store/apps/details?id=com.varoonenglish.app',
      description:
        'VaronEnglish helps learners prepare for competitive exams with English lessons, mock tests, and analytics.',
    },
  ],
};

const appPageMeta: MetaConfig = {
  title: 'VaronEnglish App | Competitive Exams Prep Platform',
  description:
    'Open the VaronEnglish App for English preparation, mock tests, revision, and learner analytics.',
  canonical: 'https://app.varonenglishapp.in/',
  ogUrl: 'https://app.varonenglishapp.in/',
  ogTitle: 'VaronEnglish App | Competitive Exams Prep Platform',
  ogDescription:
    'Access the VaronEnglish App for lessons, tests, revision, and progress tracking.',
  ogImage: 'https://app.varonenglishapp.in/og-image.png',
  twitterTitle: 'VaronEnglish App | Competitive Exams Prep Platform',
  twitterDescription:
    'Open the VaronEnglish App for English learning, mock tests, and analytics.',
  jsonLd: [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'VaronEnglish',
      alternateName: ['VaronEnglish App', 'VaronEnglishApp'],
      applicationCategory: 'EducationalApplication',
      operatingSystem: 'Android, Web, iOS',
      url: 'https://app.varonenglishapp.in/',
      description:
        'VaronEnglish is the learning application for competitive exam preparation with English lessons, practice tests, and performance insights.',
    },
  ],
};

const ensureMeta = (selector: string, attribute: 'name' | 'property', value: string) => {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, value);
    document.head.appendChild(element);
  }
  return element;
};

const ensureCanonical = () => {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  return link;
};

const applyMetaConfig = (config: MetaConfig) => {
  document.title = config.title;
  ensureCanonical().setAttribute('href', config.canonical);
  ensureMeta('meta[name="description"]', 'name', 'description').setAttribute('content', config.description);
  ensureMeta('meta[property="og:title"]', 'property', 'og:title').setAttribute('content', config.ogTitle);
  ensureMeta('meta[property="og:description"]', 'property', 'og:description').setAttribute('content', config.ogDescription);
  ensureMeta('meta[property="og:url"]', 'property', 'og:url').setAttribute('content', config.ogUrl);
  ensureMeta('meta[property="og:image"]', 'property', 'og:image').setAttribute('content', config.ogImage);
  ensureMeta('meta[name="twitter:title"]', 'name', 'twitter:title').setAttribute('content', config.twitterTitle);
  ensureMeta('meta[name="twitter:description"]', 'name', 'twitter:description').setAttribute('content', config.twitterDescription);
  ensureMeta('meta[name="twitter:image"]', 'name', 'twitter:image').setAttribute('content', config.ogImage);
  ensureMeta('meta[name="robots"]', 'name', 'robots').setAttribute('content', 'index, follow, max-image-preview:large');

  const previousScripts = document.head.querySelectorAll('script[data-varon-jsonld="true"]');
  previousScripts.forEach((script) => script.remove());

  config.jsonLd.forEach((payload) => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.dataset.varonJsonld = 'true';
    script.text = JSON.stringify(payload);
    document.head.appendChild(script);
  });
};

export const isMarketingHostname = (hostname: string) => {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === ROOT_DOMAIN || normalized === WWW_DOMAIN;
};

export const applySeoForHostname = (hostname: string) => {
  if (isMarketingHostname(hostname)) {
    applyMetaConfig(rootPageMeta);
    return;
  }

  if (String(hostname || '').toLowerCase() === APP_SUBDOMAIN) {
    applyMetaConfig(appPageMeta);
  }
};
