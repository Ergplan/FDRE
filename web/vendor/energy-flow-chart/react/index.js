'use client';
// React bindings (no JSX, so no build step is needed). Works with Next.js App Router.
//
//   <EnergyDashboard data={data} series={series} metrics={metrics} theme="energy" />
//
// or compose manually with a shared store:
//   const store = useEnergyStore();
//   <EnergyCardsView store={...} />  — see README.

import { createElement, useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import { EnergyFlowChart } from '../src/chart.js';
import { EnergyCards } from '../src/cards.js';
import { mount } from '../src/mount.js';

/** Chart only. `ref` exposes the EnergyFlowChart instance (setRange, showDay, exportPNG...). */
export const EnergyFlowChartView = forwardRef(function EnergyFlowChartView(props, ref) {
  const { data, series, theme = 'energy', mode = 'auto', className, style, onReady, ...options } = props;
  const el = useRef(null);
  const inst = useRef(null);
  useImperativeHandle(ref, () => inst.current, []);

  useEffect(() => {
    inst.current = new EnergyFlowChart(el.current, { data, series, theme, mode, ...options });
    onReady?.(inst.current);
    return () => { inst.current?.destroy(); inst.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (inst.current && inst.current.data !== data) inst.current.setData(data); }, [data]);
  useEffect(() => { inst.current?.setSeries(series); }, [series]);
  useEffect(() => { inst.current?.setTheme(theme, mode); }, [theme, mode]);
  useEffect(() => {
    if (!inst.current) return;
    const { curve, bands, yMax, height, live, unit, todZones, todScale } = options;
    inst.current.setOptions(Object.fromEntries(Object.entries({ curve, bands, yMax, height, live, unit, todZones, todScale }).filter(([, v]) => v !== undefined)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.curve, options.bands, options.yMax, options.height, options.live, options.unit, options.todZones, options.todScale]);
  useEffect(() => { if (options.view) inst.current?.setView(options.view); }, [options.view]);

  return createElement('div', { ref: el, className, style });
});

/** Cards linked to a chart instance. */
export function EnergyCardsView({ chart, metrics, minWidth, className, style }) {
  const el = useRef(null);
  const inst = useRef(null);
  useEffect(() => {
    if (!chart) return undefined;
    inst.current = new EnergyCards(el.current, { chart, metrics, minWidth });
    return () => { inst.current?.destroy(); inst.current = null; };
  }, [chart]);
  useEffect(() => { inst.current?.setMetrics(metrics); }, [metrics]);
  return createElement('div', { ref: el, className, style });
}

/** Cards above a chart, linked. `ref` exposes the chart instance. */
export const EnergyDashboard = forwardRef(function EnergyDashboard({ metrics, cardsMinWidth, gap = 18, className, style, ...chartProps }, ref) {
  const [chart, setChart] = useState(null);
  useImperativeHandle(ref, () => chart, [chart]);
  return createElement('div', { className, style: { display: 'grid', gap, ...style } },
    metrics && createElement(EnergyCardsView, { chart, metrics, minWidth: cardsMinWidth }),
    createElement(EnergyFlowChartView, { ...chartProps, onReady: setChart }),
  );
});

/**
 * The easiest React entry: preset-driven, same options as EnergyFlow.mount().
 *
 *   <EnergyFlowBoard data={rowsOrUrl} prices={SAMPLE_PRICES} view="tod" />
 *
 * `data` may be a URL, CSV text, { header, rows }, records[] or a Dataset. Changing
 * `data` reloads in place; `view`, `theme` and `mode` update without re-mounting.
 * `ref` exposes the handle: { chart, cards, store, load(), destroy() }.
 */
export const EnergyFlowBoard = forwardRef(function EnergyFlowBoard(props, ref) {
  const { data, view = 'timeline', rangeMode = 'day', theme = 'energy', mode = 'auto', showCards = true, cardsClassName, chartClassName, className, style, gap = 14, onReady, ...options } = props;
  const chartEl = useRef(null);
  const cardsEl = useRef(null);
  const [handle, setHandle] = useState(null);
  useImperativeHandle(ref, () => handle, [handle]);

  useEffect(() => {
    let alive = true;
    let h = null;
    mount(chartEl.current, { ...options, data, view, rangeMode, theme, mode, cards: showCards ? cardsEl.current : null })
      .then((x) => { if (!alive) { x.destroy(); return; } h = x; setHandle(x); onReady?.(x); })
      .catch((e) => console.error('EnergyFlowBoard:', e));
    return () => { alive = false; h?.destroy(); };
    // mount once; the effects below apply prop changes in place
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } handle?.load(data); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { handle?.chart.setView(view); }, [handle, view]);
  useEffect(() => { if (handle && handle.chart.rangeMode !== rangeMode) handle.chart.setRangeMode(rangeMode); }, [handle, rangeMode]);
  useEffect(() => { handle?.chart.setTheme(theme, mode); }, [handle, theme, mode]);
  useEffect(() => { if (options.yLock !== undefined && handle && handle.chart.opts.yLock !== options.yLock) handle.chart.setYLock(options.yLock); }, [handle, options.yLock]); // eslint-disable-line react-hooks/exhaustive-deps

  return createElement('div', { className, style: { display: 'grid', gap, ...style } },
    showCards && createElement('div', { ref: cardsEl, className: cardsClassName }),
    createElement('div', { ref: chartEl, className: chartClassName }),
  );
});
