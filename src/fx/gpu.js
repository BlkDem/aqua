// Which graphics card draws the aquarium. A page cannot pick the GPU itself: it can only ask
// for a "high-performance" or "low-power" one, and browsers (Chrome on Windows especially)
// often ignore that and stay on the built-in graphics of a laptop. So we recognise the card,
// look for a stronger one through WebGPU, and tell the user how to switch the browser over.

export const GPU_PREF_KEY = 'aq.gpu';

/** 'high-performance' (default) or 'low-power', as chosen in the settings. */
export function gpuPref() {
  try { return localStorage.getItem(GPU_PREF_KEY) === 'low-power' ? 'low-power' : 'high-performance'; } catch (e) { return 'high-performance'; }
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

/** Recognise a WebGL renderer string: software, integrated, discrete, apple, mobile or unknown. */
export function classifyGpu(renderer) {
  const s = renderer || '';
  const vendor = vendorOf(s);
  let kind = 'unknown';
  if (/swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(s)) kind = 'software';
  else if (vendor === 'nvidia') kind = 'discrete';
  else if (vendor === 'intel') kind = /arc(\(tm\))? [ab]\d/i.test(s) ? 'discrete' : 'integrated';
  else if (vendor === 'amd') {
    // "AMD Radeon(TM) Graphics", "Radeon Vega 8 Graphics", "Radeon 780M" are built into the processor
    kind = /radeon(\(tm\))? graphics|vega \d+ graphics|radeon \d{3}m\b|radeon r\d graphics/i.test(s) ? 'integrated' : 'discrete';
  } else if (vendor === 'apple') kind = 'apple';
  else if (vendor === 'qualcomm' || vendor === 'arm' || /powervr/i.test(s)) kind = 'mobile';
  return { renderer: s, name: shortName(s), vendor, kind };
}

export const KIND_TITLE = {
  software: 'программная отрисовка — видеокарта не используется',
  integrated: 'встроенная видеокарта',
  discrete: 'дискретная видеокарта',
  apple: 'графика Apple',
  mobile: 'графика мобильного устройства',
  unknown: '',
};

const VENDOR_TITLE = { nvidia: 'NVIDIA', amd: 'AMD Radeon', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm' };

/**
 * Ask WebGPU for both the fast and the economical adapter. On a laptop with two cards they
 * are different, which tells us a stronger card exists even if WebGL is not using it.
 * Best effort: null when WebGPU is unavailable or does not say.
 */
export async function probeAdapters() {
  if (!navigator.gpu) return null;
  const info = async (powerPreference) => {
    const a = await navigator.gpu.requestAdapter({ powerPreference });
    if (!a) return null;
    const i = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null);
    return i ? { vendor: (i.vendor || '').toLowerCase(), architecture: i.architecture || '', description: i.description || '' } : null;
  };
  try {
    const timeout = new Promise((r) => setTimeout(() => r(null), 3000));
    return await Promise.race([Promise.all([info('high-performance'), info('low-power')]).then(([high, low]) => ({ high, low })), timeout]);
  } catch (e) {
    return null;
  }
}

/**
 * What to tell the user. Returns null when all is well, otherwise
 * { title, text } where text explains what is going on.
 */
export function gpuVerdict(gpu, probe) {
  const high = probe?.high, low = probe?.low;
  const twoCards = high?.vendor && low?.vendor && high.vendor !== low.vendor;
  const onWeak = twoCards && gpu.vendor === low.vendor;
  const strong = !twoCards ? '' : high.description ? shortName(high.description) : VENDOR_TITLE[high.vendor] || high.vendor;
  if (gpu.kind === 'software') {
    return {
      title: 'Аквариум рисуется без видеокарты',
      text: 'Браузер отключил аппаратное ускорение, поэтому всё считает процессор и картинка тормозит. Включите ускорение в настройках браузера и перезапустите его.',
      software: true,
    };
  }
  if (onWeak) {
    return {
      title: 'Аквариум запущен на встроенной видеокарте',
      text: `Браузер рисует на ${gpu.name}, хотя в компьютере есть ${strong}. Переключите браузер на мощную видеокарту — аквариум станет плавным.`,
    };
  }
  if (gpu.kind === 'integrated') {
    return {
      title: 'Аквариум запущен на встроенной видеокарте',
      text: `Сейчас картинку рисует ${gpu.name}. Если в ноутбуке есть дискретная видеокарта (NVIDIA или AMD Radeon), переключите на неё браузер — аквариум станет плавным. Если её нет, аквариум сам подберёт качество, чтобы не тормозить.`,
    };
  }
  return null;
}

/** Step-by-step instructions for this computer's system and browser. */
export function switchHelp(software) {
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
      'Нажмите на браузер → «Параметры» и выберите «Высокая производительность» (там будет указана мощная видеокарта). Сохраните.',
      restart,
    ];
    const extra = [];
    if (browser.flags) extra.push(`Если не помогло: откройте ${code(`${browser.flags}/#force-high-performance-gpu`)}, поставьте Enabled и перезапустите браузер.`);
    extra.push(`Для видеокарт NVIDIA: Панель управления NVIDIA → Управление параметрами 3D → Программные настройки → ${browser.exe} → «Высокопроизводительный процессор NVIDIA».`);
    return { steps, extra };
  }
  if (os === 'mac') {
    return {
      steps: [
        'Обычно macOS сама включает мощную видеокарту для таких страниц.',
        'Если этого не происходит: Системные настройки → Аккумулятор → Параметры — выключите «Автоматическое переключение графики».',
        restart,
      ],
      extra: [],
    };
  }
  if (os === 'linux') {
    return {
      steps: [
        `Для AMD и Intel: запустите браузер командой ${code(`DRI_PRIME=1 ${browser.cmd}`)}.`,
        `Для NVIDIA: ${code(`prime-run ${browser.cmd}`)} или ${code(`__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia ${browser.cmd}`)}.`,
        'В GNOME и KDE можно проще: правый клик по значку браузера → «Запустить с дискретной видеокартой».',
      ],
      extra: [],
    };
  }
  return { steps: ['Переключите браузер на мощную видеокарту в настройках системы и перезапустите его.'], extra: [] };
}
