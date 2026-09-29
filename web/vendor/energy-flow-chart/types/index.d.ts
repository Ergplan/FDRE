// Type definitions for energy-flow-chart

/** Normalised dataset. `t` = wall-clock time encoded as UTC epoch-ms. Values in `unit` (kW by default). */
export interface Dataset {
  t: number[];
  stepMinutes: number;
  values: Record<string, number[]>;
  /** currency per kWh per sample, per series (see withPrices) */
  prices?: Record<string, number[]>;
  block?: number[];
  inferredDays?: boolean;
}

export type ThemeColor = string | { light: string; dark: string };

export interface Series {
  key: string;
  label?: string;
  /** 'area' (default) stacks; 'line' overlays (e.g. demand). */
  type?: 'area' | 'line';
  /** Stack group name (default 'supply'); `false` draws an unstacked translucent area. */
  stack?: string | false;
  /** Semantic role used to pick a theme colour: renewable | localBattery | govBattery | grid | market | surplus | demand | any custom role. */
  role?: string;
  color?: ThemeColor;
  /** Hatched fill (used for surplus / curtailment). */
  pattern?: 'hatch';
  /** SVG dash array for lines, e.g. '6 4'. */
  dash?: string;
  width?: number;
  opacity?: number;
  legend?: boolean;
  tooltip?: boolean;
  /** Exclude from the tooltip's "Total supply" sum (e.g. surplus exported). */
  countInTotal?: boolean;
}

export interface Band { start: string; end: string; label?: string; color?: string }

export interface TodZone { name: string; start: string; end: string; kind?: 'peak' | 'normal' | 'offpeak' | string }
export interface TodColumn extends TodZone {
  zi: number; a: number; b: number; hours: number; range: string; indices: number[]; count: number; days: number;
  sum: Record<string, number>; energy: Record<string, number>; mean: Record<string, number>;
  /** currency and volume-weighted currency/kWh per series (NaN when unpriced) */
  cost: Record<string, number>; price: Record<string, number>;
}

export interface ThemeVariant {
  surface: string; page: string; ink: string; ink2: string; muted: string; grid: string; axis: string;
  border: string; tooltip: string; band: string; accent: string;
  roles: Record<string, string>;
  palette: string[];
}
export interface Theme { name: string; label?: string; light: ThemeVariant; dark: ThemeVariant }
export type ThemeInput = { name: string; label?: string; light?: Partial<ThemeVariant>; dark?: Partial<ThemeVariant> };

export interface StoreState {
  range: [number, number] | null;
  hover: number | null;
  hidden: Set<string>;
  highlight: Set<string> | null;
  /** ToD column under the pointer (ToD view). */
  hoverZone?: { index: number; label: string; range: string; indices: number[] } | null;
  themeRev?: number;
  dataRev?: number;
}
export interface Store {
  get(): StoreState;
  set(patch: Partial<StoreState>): void;
  subscribe(fn: (state: StoreState, changed: (keyof StoreState)[]) => void): () => void;
  toggle(key: string): void;
  setHighlight(keys: string[] | null): void;
}

export interface TooltipContext { index: number; time: number; chart: EnergyFlowChart }

export interface ChartOptions {
  data: Dataset;
  series: Series[];
  store?: Store;
  theme?: string | Theme | ThemeInput;
  mode?: 'auto' | 'light' | 'dark';
  height?: number;
  navigator?: boolean;
  navigatorHeight?: number;
  legend?: boolean;
  unit?: string;
  yMin?: number;
  yMax?: number | null;
  curve?: 'linear' | 'step';
  /** Override the range mode's default window. */
  initialRange?: [number, number];
  minSpanMinutes?: number;
  live?: false | { series?: string; color?: string };
  bands?: Band[];
  dayMarkers?: boolean;
  /** 'timeline' = 15-min stacked area; 'tod' = one column per zone, width = zone hours, area = kWh. */
  view?: 'timeline' | 'tod';
  todZones?: TodZone[];
  /** 'absolute': height = mean kW so area = kWh. 'share': 100% columns. */
  todScale?: 'absolute' | 'share';
  /** Fix the y axis to the highest value in the whole loaded range (trend view). Toggle: setYLock(). */
  yLock?: boolean;
  /** Show the built-in "Lock Y axis" switch (default true). */
  yLockButton?: boolean;
  onYLockChange?: (locked: boolean) => void;
  /** 'day' (default): one whole calendar day, zoom/pan locked, overview snaps to days.
   *  'week': last `weekDays` days, free zoom/pan. Toggle: setRangeMode(). */
  rangeMode?: 'day' | 'week';
  weekDays?: number;
  /** Built-in toolbar (range, stepper, view, ToD scale, Lock Y axis, Export PNG). true/false or per control. */
  toolbar?: boolean | { range?: boolean; stepper?: boolean; view?: boolean; todScale?: boolean; lock?: boolean; export?: boolean };
  /** Crosshair / zone stays where the pointer left the chart ("pinned"); Esc or × clears. Default true. */
  stickyHover?: boolean;
  /** PNG export includes the readout band. Default true. */
  exportBand?: boolean;
  onRangeModeChange?: (mode: 'day' | 'week') => void;
  onViewChange?: (view: 'timeline' | 'tod') => void;
  /** false hides the period label in the toolbar. */
  rangeLabel?: boolean;
  tooltip?: { render?: (el: HTMLElement, ctx: TooltipContext) => void; summary?: false; hideZero?: boolean; stack?: string; demand?: string };
  locale?: string;
  priceFormat?: { currency?: string; unit?: string; digits?: number };
  margin?: Partial<{ top: number; right: number; bottom: number; left: number }>;
  onRangeChange?: (range: [number, number]) => void;
  onHover?: (index: number | null) => void;
  onThemeChange?: (theme: Theme, mode: 'light' | 'dark') => void;
}

export declare class EnergyFlowChart {
  constructor(el: HTMLElement, options: ChartOptions);
  readonly store: Store;
  readonly data: Dataset;
  readonly colorMap: Record<string, string>;
  setData(data: Dataset, opts?: { keepRange?: boolean }): void;
  setSeries(series: Series[]): void;
  setTheme(theme: string | Theme | ThemeInput, mode?: 'auto' | 'light' | 'dark'): void;
  setOptions(patch: Partial<ChartOptions>): void;
  setView(view: 'timeline' | 'tod'): void;
  setYLock(on: boolean): void;
  setRangeMode(mode: 'day' | 'week'): void;
  readonly rangeMode: 'day' | 'week';
  /** Step by whole days (day mode) or by the window length (week mode). */
  step(n: number): void;
  /** Clear a pinned crosshair / zone. */
  clearPin(): void;
  /** Composed SVG (readout band + plot) that exportPNG rasterises. */
  exportSVG(): SVGSVGElement;
  /** Apply any pending (frame-coalesced) redraw immediately. */
  flush(): void;
  readonly view: 'timeline' | 'tod';
  /** Columns from the last ToD render. */
  readonly todCols?: TodColumn[];
  setRange(t0: number, t1: number): void;
  showDay(day: string | number): void;
  showLast(hours: number): void;
  showAll(): void;
  days(): number[];
  colors(): Record<string, string>;
  getVisibleSpan(): [number, number];
  aggregate(): Aggregator;
  setTableVisible(on: boolean): void;
  exportCSV(filename?: string): void;
  /** PNG of band + plot at the pinned time/zone; default name includes the timestamp. */
  exportPNG(filename?: string, scale?: number): Promise<Blob>;
  destroy(): void;
}

export interface Aggregator {
  i0: number; i1: number; count: number; dataset: Dataset;
  values(key: string): number[];
  sum(key: string): number;
  /** kWh (sum × step hours) */
  energy(key: string): number;
  avg(key: string): number;
  max(key: string): number;
  min(key: string): number;
  last(key: string): number;
  first(key: string): number;
  argmax(key: string): number;
  /** Σ kW × h × price (NaN when the series has no prices) */
  cost(key: string): number;
  avgPrice(key: string): number;
  hasPrice(key: string): boolean;
}

export interface Metric {
  id?: string;
  label: string;
  /** Series the card represents (summed when several). Hover highlights, click toggles them. */
  series?: string | string[];
  agg?: 'energy' | 'sum' | 'avg' | 'max' | 'min' | 'last' | 'avgPrice' | 'cost' | ((a: Aggregator, data: Dataset) => number);
  format?: 'energy' | 'power' | 'percent' | 'number' | 'price' | 'money' | ((v: number) => string);
  unit?: string;
  description?: string | ((a: Aggregator, value: number, data: Dataset) => string);
  /** Instant reading while the chart is hovered. Return [time, value] or a string; false disables. */
  instant?: false | ((index: number, data: Dataset) => string | [string, string] | null);
  icon?: 'bolt' | 'sun' | 'battery' | 'grid' | 'market' | 'leaf' | 'peak' | 'rupee' | 'surplus' | 'plug' | false;
  color?: string;
  sparkline?: boolean;
  /** Click toggles the series in the chart (default true when `series` is set). */
  toggle?: boolean;
  onClick?: (e: MouseEvent, metric: Metric) => void;
}

export declare class EnergyCards {
  constructor(el: HTMLElement, opts: { chart?: EnergyFlowChart; store?: Store; data?: Dataset; series?: Series[]; theme?: string; mode?: string; metrics: Metric[]; minWidth?: number; clickable?: boolean; icons?: boolean; showPeriod?: boolean });
  setMetrics(metrics: Metric[]): void;
  update(): void;
  destroy(): void;
}

export declare function createChart(el: HTMLElement, options: ChartOptions): EnergyFlowChart;
export declare function createCards(el: HTMLElement, opts: ConstructorParameters<typeof EnergyCards>[1]): EnergyCards;
export declare function createEnergyDashboard(opts: ChartOptions & { chartEl: HTMLElement; cardsEl?: HTMLElement; metrics?: Metric[] }): { chart: EnergyFlowChart; cards: EnergyCards | null; store: Store; destroy(): void };
export declare const DEFAULT_TOD_ZONES: TodZone[];
export declare function normaliseZones(zones: TodZone[]): (TodZone & { zi: number; a: number; b: number })[];
export declare function computeTod(data: Dataset, zones: TodZone[], i0: number, i1: number, keys: string[]): TodColumn[];
export type PriceSpec = number | number[] | { tod: { start: string; end: string; price: number }[]; base?: number } | ((t: number, i: number, data: Dataset) => number);
export declare function withPrices(data: Dataset, spec: Record<string, PriceSpec>): Dataset;
export declare const SAMPLE_PRICES: Record<string, PriceSpec>;

export type DataInput = string | Dataset | { header: string[]; rows: unknown[][] } | Record<string, unknown>[];
export interface MountOptions extends Omit<Partial<ChartOptions>, 'data'> {
  /** URL (JSON/CSV), CSV text, { header, rows }, records[] or a Dataset. */
  data?: DataInput;
  url?: string;
  /** Element or selector for the KPI cards. */
  cards?: string | HTMLElement | null;
  /** Preset name (default 'energy-supply') or false for none. */
  preset?: string | false;
  columns?: Record<string, string>;
  dateKey?: string; blockKey?: string; timeKey?: string; blockMinutes?: number;
  /** For timestamped records instead of Date/Block rows. */
  time?: string | ((row: any) => number | string | Date);
  /** Card ids from the preset ('demand','renewable','grid','market','localBattery','govBattery','surplus','peak','avgPrice','cost'),
   *  full Metric objects, or a mix. Omitted → 5 defaults (+ 'avgPrice' when priced). */
  metrics?: (Metric | string)[] | string;
  priceMetrics?: Metric[];
  prices?: Record<string, PriceSpec> | ((data: Dataset) => Record<string, PriceSpec>);
  transform?: (data: Dataset) => Dataset;
  refreshSeconds?: number;
  fetchOptions?: RequestInit;
  cardMinWidth?: number;
  /** Cards toggle their series on click (default false: cards are read-only). */
  cardsClickable?: boolean;
  /** Show metric icons on cards (default false; the period chip takes that spot). */
  cardIcons?: boolean;
  /** Show the period each card covers (default true). */
  cardPeriod?: boolean;
}
export interface MountHandle { chart: EnergyFlowChart; cards: EnergyCards | null; store: Store; load(input: DataInput): Promise<void>; destroy(): void }
export declare function mount(target: string | HTMLElement, options?: MountOptions): Promise<MountHandle>;
export declare function autoMount(root?: ParentNode): Promise<unknown>;
export declare function toDataset(input: DataInput, cfg: MountOptions): Dataset;
export declare const presets: Record<string, Partial<MountOptions> & { series: Series[] }>;
export declare const energySupplyPreset: Partial<MountOptions> & { series: Series[] };

export declare function createStore(initial?: Partial<StoreState>): Store;

export declare const themes: Record<string, Theme>;
export declare function registerTheme(theme: ThemeInput): Theme;
export declare function getTheme(theme: string | Theme | ThemeInput): Theme;
export declare function resolveMode(mode: 'auto' | 'light' | 'dark'): 'light' | 'dark';
export declare function resolveSeriesColors(series: Series[], theme: Theme, mode: 'light' | 'dark'): Record<string, string>;
export declare function applyThemeVars(el: HTMLElement, theme: Theme, mode: 'light' | 'dark'): void;

export interface BlockRowOptions {
  columns: Record<string, string>;
  dateKey?: string;
  blockKey?: string;
  timeKey?: string;
  blockMinutes?: number;
  stamp?: 'end' | 'start';
}
export declare function fromBlockRows(rows: Record<string, unknown>[], opts: BlockRowOptions): Dataset;
export declare function fromRecords(rows: Record<string, unknown>[], opts: { time: string | ((row: any) => number | string | Date); columns: Record<string, string | ((row: any) => number)>; stepMinutes?: number }): Dataset;
export declare function fromTable(header: string[], rows: unknown[][]): Record<string, unknown>[];
export declare function parseCSV(text: string): Record<string, string>[];
export declare function aggregator(data: Dataset, i0: number, i1: number): Aggregator;
export declare function indexSpan(t: number[], t0: number, t1: number): [number, number];
export declare function nearestIndex(t: number[], x: number): number;
export declare function toCSV(data: Dataset, series: Series[], i0?: number, i1?: number, unit?: string): string;
export declare function svgToPNG(svg: SVGSVGElement, background?: string, scale?: number): Promise<Blob>;
export declare function download(blob: Blob, filename: string): void;
export declare function injectStyles(doc?: Document): void;
export declare const icons: Record<string, string>;
export declare const format: {
  fmtNumber(v: number, digits?: number, locale?: string): string;
  fmtPower(kw: number, opts?: { unit?: string; auto?: boolean; digits?: number }): string;
  fmtEnergy(kwh: number, opts?: { digits?: number }): string;
  fmtPercent(v: number, digits?: number): string;
  fmtPrice(v: number, opts?: { currency?: string; unit?: string; digits?: number; compact?: boolean }): string;
  fmtMoney(v: number, opts?: { currency?: string }): string;
  fmtTime(t: number): string;
  fmtDay(t: number): string;
  fmtDayLong(t: number): string;
  fmtRange(t0: number, t1: number): string;
  fmtPeriod(t0: number, t1: number, opts?: { long?: boolean }): string;
  fmtBlockTime(t: number): string;
  isoDay(t: number): string;
};
