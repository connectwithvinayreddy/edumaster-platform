import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(({mode}) => {
  return {
    plugins: [react(), tailwindcss()],
    build: {
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) {
              return undefined;
            }
            if (id.includes('firebase')) {
              return 'firebase-vendor';
            }
            if (id.includes('framer-motion')) {
              return 'motion-vendor';
            }
            if (id.includes('recharts') || id.includes('/d3-')) {
              return 'analytics-vendor';
            }
            if (id.includes('hls.js')) {
              return 'video-vendor';
            }
            if (id.includes('@capacitor')) {
              return 'native-vendor';
            }
            if (id.includes('lucide-react')) {
              return 'ui-vendor';
            }
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      allowedHosts: ['.trycloudflare.com', 'localhost', '127.0.0.1'],
    },
  };
});
