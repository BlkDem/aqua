// The aquarium as an installable app that works offline. The service worker (built by
// vite-plugin-pwa, see vite.config.js) keeps the app itself; models and fonts are kept the
// first time they are loaded, so after one visit the aquarium opens without a network.
import { registerSW } from 'virtual:pwa-register';

const HOUR = 3600000;

export const pwa = {
  /** true while the page runs as an installed app (its own window, no browser bar) */
  standalone: matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true,
  canInstall: false,
  offlineReady: false,
  onChange: null,
  onUpdate: null,
};

let installEvent = null;
const changed = () => pwa.onChange?.();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();           // offered from the settings instead of the browser's own bar
  installEvent = e;
  pwa.canInstall = true;
  changed();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  pwa.canInstall = false;
  keepStorage();
  changed();
});

/** Show the browser's install dialog; resolves to true when the user agreed. */
pwa.install = async () => {
  if (!installEvent) return false;
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  pwa.canInstall = false;
  changed();
  return outcome === 'accepted';
};

/** iPhone and iPad have no install dialog: the app is added from the Share menu. */
pwa.ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// the aquarium's life is in localStorage: ask the browser not to clear it when space runs low
function keepStorage() {
  navigator.storage?.persist?.().catch(() => {});
}
if (pwa.standalone) keepStorage();

/** Hand the worker everything this page has loaded so far, so it is there offline too. */
function cacheLoaded(sw) {
  const urls = performance.getEntriesByType('resource')
    .map((e) => e.name)
    .filter((u) => u.includes('/models/') || u.startsWith('https://fonts.'));
  if (urls.length) sw.postMessage({ type: 'CACHE_URLS', payload: { urlsToCache: urls } });
}

export function startPwa() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const updateSW = registerSW({
    onNeedRefresh() { pwa.onUpdate?.(() => updateSW(true)); },
    onOfflineReady() { pwa.offlineReady = true; changed(); },
    onRegisteredSW(url, reg) {
      if (!reg) return;
      navigator.serviceWorker.ready.then((r) => { pwa.offlineReady = true; changed(); cacheLoaded(r.active); });
      // an aquarium may stay open for days: look for a new version now and then
      setInterval(() => { if (navigator.onLine) reg.update().catch(() => {}); }, HOUR);
    },
  });
}
