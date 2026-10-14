// A worked example of SECI CfD-I for one bid size: what the bidder signs up for, what it builds
// and when, the money it puts up, real IEX evenings settled against a strike price, a week with a
// missed evening, and a year of evenings. Every rule comes from ./terms.js; the round-trip
// efficiency and solar CUF used to size own solar are the bidder's inputs, or labelled examples.

import { TENDER } from "./terms.js";
import { lcCr, rfsAmounts } from "./model.js";

const DAY_MS = 86400000;
export const EXAMPLE_DEFAULTS = { mw: 100, sp: 9, rte: 0.87, solarCuf: 0.25 };

const lakh = (rsPerKwh, mwh) => (rsPerKwh * mwh * 1000) / 1e5;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** The bid size the example shows: the one chosen there, else your contracted MW if it is a valid bid, else 100 MW. */
export function exampleMw(state) {
  const chosen = state.example?.mw;
  if (isNum(chosen)) return chosen;
  const mw = state.inputs?.contractedMw;
  return isNum(mw) && Number.isInteger(mw) && mw >= TENDER.bidMinMw && mw <= TENDER.bidMaxMw ? mw : EXAMPLE_DEFAULTS.mw;
}

/** The real date of day d (0-364) of the price year: each calendar day from the latest year with data. */
export function priceDate(prices, market, d) {
  const to = Date.parse(`${prices.markets[market].to}T00:00:00Z`);
  const year = new Date(to).getUTCFullYear();
  const t = Date.UTC(year, 0, 1) + d * DAY_MS;
  return t > to ? Date.UTC(year - 1, 0, 1) + d * DAY_MS : t;
}

/** Each day's two best evening hours (18:00-24:00) in the selling market, in clock order, with prices in ₹/kWh. */
export function evenings(prices, market) {
  const s = prices.markets[market].hourlyRsPerMwh;
  const out = [];
  for (let d = 0; d < 365; d += 1) {
    const hours = [];
    for (let h = TENDER.peakStart; h < TENDER.peakEnd; h += 1) hours.push(h);
    hours.sort((a, b) => s[d * 24 + b] - s[d * 24 + a] || a - b);
    const best = hours.slice(0, TENDER.peakHours).sort((a, b) => a - b);
    const p = best.map((h) => s[d * 24 + h] / 1000);
    out.push({ d, hours: best, prices: p, avg: p.reduce((a, v) => a + v, 0) / p.length });
  }
  return out;
}

/** One evening settled: the exchange pays MCP, the Pool settles the gap to SP, you end with SP. */
function settle(day, mw, sp, date) {
  const exchange = day.prices.reduce((a, p) => a + lakh(p, mw), 0);
  const you = lakh(sp, mw * day.prices.length);
  return { ...day, date, mwhPerHour: mw, exchangeLakh: exchange, poolLakh: you - exchange, youLakh: you };
}

/**
 * The worked example for a bid of `mw` MW at strike price `sp` (₹/kWh), on the IEX prices of
 * `market`. Own solar is sized on energy alone (at least the share own RE must supply), from the
 * round-trip efficiency and the solar CUF.
 */
export function workedExample({ mw, sp, prices, market = "DAM", rte = EXAMPLE_DEFAULTS.rte, solarCuf = EXAMPLE_DEFAULTS.solarCuf }) {
  const X = mw;
  const daily = TENDER.mwhPerMwDay * X;
  const weekly = daily * 7;
  const yearly = daily * 365;
  // own RE after month 36: whatever the green market (25%) and group RE (50%) do not supply
  const ownShareWithGroup = 1 - TENDER.marketShare - TENDER.groupShare;
  const ownShareAlone = 1 - TENDER.marketShare;
  const solarFor = (share) => (share * yearly) / rte / (8760 * solarCuf);
  const solarWithGroup = solarFor(ownShareWithGroup);
  const solarAlone = solarFor(ownShareAlone);
  const plantSolar = Math.ceil(solarAlone / 5) * 5;
  const money = rfsAmounts({ contractedMw: X, solarMw: plantSolar, windMw: 0, essMwhPerMw: TENDER.essHoursMin });

  // real evenings: the cheapest, a middle one and the dearest of the year
  const ev = evenings(prices, market);
  const date = (d) => priceDate(prices, market, d);
  const byAvg = [...ev].sort((a, b) => a.avg - b.avg || a.d - b.d);
  const low = byAvg[0];
  const high = byAvg[byAvg.length - 1];
  // the middle evening, from a day whose whole Contract Week (Monday to Sunday) is in the same data year
  const weekStart = (d) => d - ((new Date(date(d)).getUTCDay() + 6) % 7);
  const sameYear = (d) => new Date(date(d)).getUTCFullYear() === new Date(date(weekStart(d))).getUTCFullYear()
    && weekStart(d) >= 0 && weekStart(d) + 6 < 365 && date(weekStart(d) + 6) - date(weekStart(d)) === 6 * DAY_MS;
  const middle = byAvg.slice(Math.floor(byAvg.length / 2)).find((e) => sameYear(e.d)) || byAvg[Math.floor(byAvg.length / 2)];

  // a Contract Week with one evening missed entirely
  const w0 = weekStart(middle.d);
  const markets = ["DAM", "GDAM", "RTM"].filter((m) => prices.markets[m]);
  let ref = 0;
  let refDay = w0;
  let refMarket = markets[0];
  for (let d = w0; d < w0 + 7; d += 1) {
    for (const m of markets) {
      for (let h = TENDER.peakStart; h < TENDER.peakEnd; h += 1) {
        const p = prices.markets[m].hourlyRsPerMwh[d * 24 + h] / 1000;
        if (p > ref) { ref = p; refDay = d; refMarket = m; }
      }
    }
  }
  const missed = daily;
  const free = TENDER.weeklyTolerance * weekly;
  const penalised = Math.max(0, missed - free);
  const week = {
    start: date(w0), end: date(w0 + 6), missedDate: date(middle.d),
    requiredMwh: weekly, suppliedMwh: weekly - missed, shortMwh: missed, shortPct: missed / weekly,
    freeMwh: free, penalisedMwh: penalised,
    refPrice: ref, refDate: date(refDay), refMarket,
    penaltyLakh: lakh(TENDER.penaltyMultiple * Math.max(0, ref - sp), penalised),
    lostLakh: lakh(sp, missed),
    oneHourPct: X / weekly,
  };

  // a year of evenings, every one supplied in full
  const series = ev.map((e) => ({ d: e.d, date: date(e.d), avg: e.avg, poolLakh: lakh(sp - e.avg, daily) })).sort((a, b) => a.date - b.date); // in date order
  const exchangeCr = ev.reduce((a, e) => a + e.prices.reduce((b, p) => b + lakh(p, X), 0), 0) / 100;
  const youCr = lakh(sp, yearly) / 100;
  const year = {
    series,
    energyMwh: yearly,
    exchangeCr,
    youCr,
    poolCr: youCr - exchangeCr, // positive: the Pool pays you, net over the year
    daysPoolPays: ev.filter((e) => e.avg < sp - 1e-9).length,
    daysYouPay: ev.filter((e) => e.avg > sp + 1e-9).length,
    avgPrice: ev.reduce((a, e) => a + e.avg, 0) / ev.length,
    maxPrice: Math.max(...ev.map((e) => e.avg)),
    from: prices.markets[market].from,
    to: prices.markets[market].to,
  };

  return {
    mw: X, sp, market, rte, solarCuf,
    commit: { dailyMwh: daily, weeklyMwh: weekly, weeklyMinMwh: weekly - free, yearlyMwh: yearly, batteryMw: X, batteryMwh: daily, share: X / TENDER.totalMw },
    charging: { perDayMwh: daily / rte, ownShareWithGroup, ownShareAlone, solarWithGroup, solarAlone, plantSolar },
    money: { ...money, lcCr: lcCr(X, sp) },
    evenings: { low: settle(low, X, sp, date(low.d)), middle: settle(middle, X, sp, date(middle.d)), high: settle(high, X, sp, date(high.d)) },
    week,
    year,
  };
}
