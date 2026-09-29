// energy-flow-chart — reusable stacked-area chart + linked KPI cards for
// time-series consumption & generation data. Zero dependencies.

export { EnergyFlowChart, createChart } from './chart.js';
export { EnergyCards, createCards, icons } from './cards.js';
export { createStore } from './store.js';
export { computeTod, normaliseZones, DEFAULT_TOD_ZONES } from './tod.js';
export { themes, registerTheme, getTheme, resolveMode, resolveSeriesColors, applyThemeVars } from './themes.js';
export { fromBlockRows, fromRecords, fromTable, parseCSV, withPrices, aggregator, indexSpan, nearestIndex } from './data.js';
export { mount, autoMount, toDataset } from './mount.js';
export { presets, energySupplyPreset, SAMPLE_PRICES } from './presets.js';
export * as format from './format.js';
export { toCSV, svgToPNG, download } from './export.js';
export { injectStyles } from './styles.js';

import { EnergyFlowChart } from './chart.js';
import { EnergyCards } from './cards.js';

/**
 * One-call setup: a chart and a card grid that share one store.
 * @returns {{ chart: EnergyFlowChart, cards: EnergyCards | null, store: object, destroy(): void }}
 */
export function createEnergyDashboard({ chartEl, cardsEl, metrics, ...chartOptions }) {
  const chart = new EnergyFlowChart(chartEl, chartOptions);
  const cards = cardsEl && metrics ? new EnergyCards(cardsEl, { chart, metrics }) : null;
  return { chart, cards, store: chart.store, destroy() { cards?.destroy(); chart.destroy(); } };
}
