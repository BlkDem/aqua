import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const THEME = '#06344d';

export default defineConfig({
  // top-level await is used to preload fish models before the world is built
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  plugins: [
    VitePWA({
      // a new version waits until the user agrees to reload (see src/pwa.js)
      registerType: 'prompt',
      injectRegister: false,
      includeManifestIcons: false,   // already picked up by globPatterns
      manifest: {
        id: '/',
        name: 'Живой аквариум',
        short_name: 'Аквариум',
        description: 'Маленький подводный мир, который живёт своей жизнью: рыбки растут, заводят пары и потомство.',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        background_color: '#05070c',
        theme_color: THEME,
        categories: ['entertainment', 'lifestyle'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // the app itself; models (30+ MB) are kept as they load instead of all at install
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // served from the cache at once, refreshed in the background for the next visit
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/models/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'aq-models', cacheableResponse: { statuses: [200] } },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'aq-font-css' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'aq-fonts',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 20, maxAgeSeconds: 365 * 86400 },
            },
          },
        ],
      },
    }),
  ],
});
