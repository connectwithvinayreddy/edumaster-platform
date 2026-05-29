import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.varoonenglish.app',
  appName: 'VaronEnglish',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: [
      'app.varonenglishapp.in',
      'live.varonenglishapp.in',
      '*.varonenglishapp.in',
      'app.varoonenglish.com',
      '*.varoonenglish.com',
      'app.178.105.48.179.nip.io',
      'live.178.105.48.179.nip.io',
      '*.stripe.com',
      '*.phonepe.com',
      '*.youtube.com',
      '*.googlevideo.com',
      '*.ytimg.com',
    ],
  },
};

export default config;
