// Which graphics card draws the aquarium. A page cannot pick the GPU itself: it can only ask the
// browser for its "high-performance" or "low-power" adapter (or leave it to the browser). The
// settings always offer the choice; where WebGPU tells which card stands behind each wish, the
// card is named. If the browser does not follow the choice, the user is told how to switch it
// in the system.

export const GPU_PREF_KEY = 'aq.gpu';

export const GPU_PREFS = ['default', 'high-performance', 'low-power'];

/** 'high-performance' (unless chosen otherwise), 'low-power' or 'default' (the browser decides). */
export function gpuPref() {
  try {
    const v = localStorage.getItem(GPU_PREF_KEY);
    return GPU_PREFS.includes(v) ? v : 'high-performance';
  } catch (e) { return 'high-performance'; }
}
export function setGpuPref(v) {
  try { localStorage.setItem(GPU_PREF_KEY, v); } catch (e) { /* ignore */ }
}

function vendorOf(s) {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(s)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b/i.test(s)) return 'amd';
  if (/intel/i.test(s)) return 'intel';
  if (/apple/i.test(s)) return 'apple';
  if (/adreno|qualcomm/i.test(s)) return 'qualcomm';
  if (/mali|arm/i.test(s)) return 'arm';
  return '';
}

/** "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)" → "Intel UHD Graphics 620" */
function shortName(s) {
  let n = s;
  const m = /^ANGLE \((.*)\)$/.exec(n);
  if (m) n = m[1].split(', ').slice(1, -1).join(', ') || m[1];
  return n.replace(/^ANGLE Metal Renderer: /, '').replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s+(Direct3D|vs_|OpenGL|Vulkan \d|Metal).*$/i, '')
    .replace(/\((R|TM)\)/gi, '').replace(/^Mesa /, '').replace(/\s+/g, ' ').trim().slice(0, 60) || s;
}

const VENDOR_TITLE = { nvidia: 'NVIDIA', amd: 'AMD Radeon', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm' };

/** What the WebGL renderer string says: a readable name, the maker, and whether it is a software renderer. */
export function describeGpu(renderer) {
  const s = renderer || '';
  return { renderer: s, name: shortName(s), vendor: vendorOf(s), software: /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(s) };
}

/**
 * The graphics cards the browser can draw on: WebGPU tells which adapter it gives for each
 * preference ("high-performance", "low-power"). One entry per card, with the preferences that
 * lead to it; null when WebGPU is unavailable or does not say.
 */
export async function listAdapters() {
  if (!navigator.gpu) return null;
  const info = async (powerPreference) => {
    const a = await navigator.gpu.requestAdapter({ powerPreference });
    if (!a) return null;
    const i = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null);
    if (!i) return null;
    const vendor = vendorOf(`${i.vendor || ''} ${i.description || ''}`) || (i.vendor || '').toLowerCase();
    const name = i.description ? shortName(i.description) : [VENDOR_TITLE[vendor] || i.vendor, i.architecture].filter(Boolean).join(' ');
    return { pref: powerPreference, name: name || 'видеокарта', vendor };
  };
  try {
    const timeout = new Promise((r) => setTimeout(() => r(null), 3000));
    const found = await Promise.race([Promise.all([info('high-performance'), info('low-power')]), timeout]);
    if (!found) return null;
    const cards = [];
    for (const a of found) {
      if (!a) continue;
      const same = cards.find((c) => c.name === a.name && c.vendor === a.vendor);
      if (same) same.prefs.push(a.pref);
      else cards.push({ name: a.name, vendor: a.vendor, prefs: [a.pref] });
    }
    return cards.length ? cards : null;
  } catch (e) {
    return null;
  }
}

/**
 * Something to tell the user about the card, or null: drawing without a card at all, or on
 * another card than the one chosen in the settings (browsers may not follow the wish).
 */
export function gpuProblem(gpu, cards, pref) {
  if (gpu.software) {
    return {
      title: 'Аквариум рисуется без видеокарты',
      text: 'Браузер отключил аппаратное ускорение, поэтому всё считает процессор и картинка тормозит. Включите ускорение в настройках браузера и перезапустите его.',
      software: true,
    };
  }
  const chosen = cards?.find((c) => c.prefs.includes(pref));
  if (chosen && cards.length > 1 && chosen.vendor && gpu.vendor && chosen.vendor !== gpu.vendor) {
    return {
      title: 'Браузер рисует не на той видеокарте',
      text: `В настройках выбрана ${chosen.name}, а браузер рисует на ${gpu.name}. Сайт может только попросить — переключить браузер можно в настройках системы.`,
      card: chosen.name,
    };
  }
  return null;
}

/** Step-by-step instructions for this computer's system and browser. */
export function switchHelp(software, card) {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'win' : /Mac OS X/.test(ua) && navigator.maxTouchPoints < 2 ? 'mac' : /Linux/.test(ua) && !/Android/.test(ua) ? 'linux' : 'other';
  const browser = /YaBrowser/.test(ua) ? { name: 'Яндекс Браузер', exe: 'browser.exe', flags: 'browser://flags', cmd: 'yandex-browser' }
    : /Edg\//.test(ua) ? { name: 'Microsoft Edge', exe: 'msedge.exe', flags: 'edge://flags', cmd: 'microsoft-edge' }
    : /OPR\//.test(ua) ? { name: 'Opera', exe: 'opera.exe', flags: 'opera://flags', cmd: 'opera' }
    : /Firefox\//.test(ua) ? { name: 'Firefox', exe: 'firefox.exe', flags: null, cmd: 'firefox' }
    : { name: 'Google Chrome', exe: 'chrome.exe', flags: 'chrome://flags', cmd: 'google-chrome' };
  const restart = `Полностью закройте ${browser.name} (все окна) и откройте аквариум снова.`;
  const code = (s) => `<code>${s}</code>`;

  if (software) {
    const where = browser.name === 'Firefox'
      ? `Настройки → Основные → Производительность: снимите «Использовать рекомендуемые настройки» и включите «По возможности использовать аппаратное ускорение».`
      : `Откройте ${code(browser.flags.replace('flags', 'settings/system'))} и включите «Использовать графическое ускорение».`;
    return { steps: [where, restart], extra: [] };
  }
  if (os === 'win') {
    const steps = [
      'Откройте Параметры Windows → Система → Дисплей → Графика (в Windows 10 — «Настройки графики»).',
      `Найдите в списке ${browser.name}. Если его нет — нажмите «Обзор» и выберите ${code(browser.exe)}.`,
      `Нажмите на браузер → «Параметры» и выберите вариант, под которым указана ${card ? code(card) : 'нужная видеокарта'}. Сохраните.`,
      restart,
    ];
    const extra = [];
    if (/nvidia|geforce|rtx|gtx/i.test(card || '')) extra.push(`Или: Панель управления NVIDIA → Управление параметрами 3D → Программные настройки → ${browser.exe} → «Высокопроизводительный процессор NVIDIA».`);
    return { steps, extra };
  }
  if (os === 'mac') {
    return {
      steps: [
        'Системные настройки → Аккумулятор → Параметры: выключите «Автоматическое переключение графики» — тогда работает производительная видеокарта.',
        restart,
      ],
      extra: [],
    };
  }
  if (os === 'linux') {
    return {
      steps: [
        `Запустите браузер командой ${code(`DRI_PRIME=1 ${browser.cmd}`)} (для NVIDIA — ${code(`prime-run ${browser.cmd}`)}).`,
        'В GNOME и KDE можно проще: правый клик по значку браузера → «Запустить с дискретной видеокартой».',
      ],
      extra: [],
    };
  }
  return { steps: [`Переключите браузер на ${card ? code(card) : 'нужную видеокарту'} в настройках системы и перезапустите его.`], extra: [] };
}
