// Themes: chrome tokens + series colours, each with a light and a dark variant.
//
// Series colours resolve in this order (see resolveSeriesColor):
//   1. series.color            explicit hex, or { light, dark }
//   2. theme[mode].roles[role] semantic role (renewable, grid, market, ...)
//   3. theme[mode].palette[n]  fixed-order fallback slot (by declaration order,
//                              never by rank, so hiding a series never repaints others)
//
// Every built-in role set was run through the data-viz palette validator in
// stack order renewable → localBattery → govBattery → grid → market → surplus
// (adjacent-pair CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, lightness band, chroma floor).

const chromeLight = {
  surface: '#fcfcfb',
  page: '#f6f6f3',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e7e6e0',
  axis: '#c3c2b7',
  border: 'rgba(11,11,11,0.10)',
  tooltip: '#ffffff',
  band: 'rgba(11,11,11,0.035)',
  accent: '#b8912f',
};

const chromeDark = {
  surface: '#1a1a19',
  page: '#0f0f0e',
  ink: '#ffffff',
  ink2: '#c3c2b7',
  muted: '#8f8d86',
  grid: '#2c2c2a',
  axis: '#383835',
  border: 'rgba(255,255,255,0.10)',
  tooltip: '#242422',
  band: 'rgba(255,255,255,0.045)',
  accent: '#d6b35a',
};

const roleKeys = ['renewable', 'localBattery', 'govBattery', 'grid', 'market', 'surplus'];
const roles = (hexes) => Object.fromEntries(roleKeys.map((k, i) => [k, hexes[i]]));

export const themes = {
  /** Default. Warm amber grid + lilac market, echoing typical Indian C&I dashboards. */
  energy: {
    name: 'energy',
    label: 'Energy',
    light: {
      ...chromeLight,
      roles: { ...roles(['#1baf7a', '#2a78d6', '#4a3aa7', '#eda100', '#8e6ff0', '#e87ba4']), demand: 'ink' },
      palette: ['#1baf7a', '#2a78d6', '#4a3aa7', '#eda100', '#8e6ff0', '#e87ba4', '#eb6834', '#008300'],
    },
    dark: {
      ...chromeDark,
      roles: { ...roles(['#228f61', '#346aac', '#8477f3', '#a36e09', '#7457a3', '#c26c96']), demand: 'ink' },
      palette: ['#228f61', '#346aac', '#8477f3', '#a36e09', '#7457a3', '#c26c96', '#d95926', '#199e70'],
    },
  },
  /** Warmer, higher-saturation set. */
  sunset: {
    name: 'sunset',
    label: 'Sunset',
    light: {
      ...chromeLight,
      accent: '#c0582a',
      roles: { ...roles(['#3a732c', '#ff74b0', '#765ad4', '#994920', '#d6a20a', '#0f68a2']), demand: 'ink' },
      palette: ['#3a732c', '#ff74b0', '#765ad4', '#994920', '#d6a20a', '#0f68a2', '#1baf7a', '#e34948'],
    },
    dark: {
      ...chromeDark,
      accent: '#e07a45',
      roles: { ...roles(['#3f7932', '#c46b90', '#695ba9', '#ab4400', '#ad8522', '#196ea9']), demand: 'ink' },
      palette: ['#3f7932', '#c46b90', '#695ba9', '#ab4400', '#ad8522', '#196ea9', '#199e70', '#e66767'],
    },
  },
  /** Okabe–Ito derived; maximum separation for colour-vision deficiency and print. */
  contrast: {
    name: 'contrast',
    label: 'High contrast',
    light: {
      ...chromeLight,
      accent: '#0072b2',
      roles: { ...roles(['#009e73', '#0072b2', '#cc79a7', '#e69f00', '#56b4e9', '#d55e00']), demand: 'ink' },
      palette: ['#009e73', '#0072b2', '#cc79a7', '#e69f00', '#56b4e9', '#d55e00', '#f0e442', '#000000'],
    },
    dark: {
      ...chromeDark,
      accent: '#2193e0',
      roles: { ...roles(['#0a9068', '#2193e0', '#954a7e', '#ba7e2d', '#089ac3', '#a14d2f']), demand: 'ink' },
      palette: ['#0a9068', '#2193e0', '#954a7e', '#ba7e2d', '#089ac3', '#a14d2f', '#c9bd3a', '#ffffff'],
    },
  },
};

/** Register (or override) a theme. Missing chrome tokens fall back to the defaults. */
export function registerTheme(theme) {
  if (!theme || !theme.name) throw new Error('registerTheme: theme.name is required');
  const fill = (variant, base) => ({ ...base, roles: {}, palette: [], ...(variant || {}) });
  themes[theme.name] = {
    label: theme.name,
    ...theme,
    light: fill(theme.light, chromeLight),
    dark: fill(theme.dark || theme.light, chromeDark),
  };
  return themes[theme.name];
}

export function getTheme(nameOrTheme) {
  if (nameOrTheme && typeof nameOrTheme === 'object') {
    return nameOrTheme.light ? nameOrTheme : registerTheme({ name: 'custom', ...nameOrTheme });
  }
  return themes[nameOrTheme] || themes.energy;
}

/** 'auto' follows <html data-theme> first, then the OS preference. */
export function resolveMode(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  const attr = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Colour for every series, keyed by series.key. Fallback slots follow declaration order. */
export function resolveSeriesColors(series, theme, mode) {
  const t = theme[mode];
  const out = {};
  let slot = 0;
  for (const s of series) {
    let c = s.color;
    if (c && typeof c === 'object') c = c[mode] || c.light;
    if (!c) c = t.roles[s.role || s.key];
    if (!c) c = t.palette[slot++ % Math.max(1, t.palette.length)] || t.ink;
    out[s.key] = c === 'ink' ? t.ink : c;
  }
  return out;
}

/** Write chrome tokens onto an element as CSS custom properties (--efc-*). */
export function applyThemeVars(el, theme, mode) {
  const t = theme[mode];
  for (const k of ['surface', 'page', 'ink', 'ink2', 'muted', 'grid', 'axis', 'border', 'tooltip', 'band', 'accent']) {
    el.style.setProperty(`--efc-${k}`, t[k]);
  }
  el.style.colorScheme = mode;
  el.dataset.efcMode = mode;
}
