// Historical tender results: comparable awards with the reason for each match, units and
// sources preserved, non-tariff results kept apart, dataset freshness and gaps shown.
import React, { useEffect, useState } from "react";
import { platformApi } from "./api";

export default function HistoryTab({ org }) {
  const [filters, setFilters] = useState({ tender_family: "fdre", procurer: "", capacity_mw: "", storage: "", contract_years: "", since: "", tariff_only: true });
  const [data, setData] = useState(null);
  const [message, setMessage] = useState("");
  async function search() {
    const q = Object.entries(filters).filter(([, v]) => v !== "" && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    try { setData(await platformApi(`/orgs/${org.id}/history/awards?${q}&limit=60`)); } catch (e) { setMessage(e.message); }
  }
  useEffect(() => { if (org) search(); }, [org?.id]);
  const f = data?.freshness;
  return (
    <section className="history">
      <div className="req-head">
        <h2>Historical tenders and comparable results</h2>
        {f && <span className="chip">{f.records} records · dataset as of {f.dataset_as_of} · sources checked {f.sources_last_checked} · latest award {f.latest_award_date}</span>}
        {f && <span className="chip warn">{f.records_without_price} without price · {f.records_without_date} without date</span>}
      </div>
      {f && <p className="note">{f.note}</p>}
      <div className="filters">
        <select value={filters.tender_family} onChange={(e) => setFilters({ ...filters, tender_family: e.target.value })}>
          {[["", "any family"], ["fdre", "FDRE / RTC / peak"], ["hybrid", "wind-solar hybrid"], ["solar", "solar"], ["wind", "wind"], ["bess", "storage"], ["solar_storage", "solar + storage"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input placeholder="procurer" value={filters.procurer} onChange={(e) => setFilters({ ...filters, procurer: e.target.value })} />
        <input placeholder="capacity MW" value={filters.capacity_mw} onChange={(e) => setFilters({ ...filters, capacity_mw: e.target.value })} />
        <select value={filters.storage} onChange={(e) => setFilters({ ...filters, storage: e.target.value })}><option value="">storage: any</option><option value="true">with storage / firmness</option><option value="false">without</option></select>
        <input placeholder="contract years" value={filters.contract_years} onChange={(e) => setFilters({ ...filters, contract_years: e.target.value })} />
        <input type="date" value={filters.since} onChange={(e) => setFilters({ ...filters, since: e.target.value })} />
        <label><input type="checkbox" checked={filters.tariff_only} onChange={(e) => setFilters({ ...filters, tariff_only: e.target.checked })} /> tariffs only (INR/kWh)</label>
        <button className="primary" onClick={search}>Search</button>
      </div>
      {message && <div className="alert">{message}</div>}
      <table className="table"><thead><tr><th>Procurer / tender</th><th>Bidder</th><th>Capacity</th><th>Price</th><th>Result</th><th>Date</th><th>Term</th><th>Conditions</th><th>Why similar</th><th>Source</th></tr></thead>
        <tbody>{(data?.results || []).map((r) => (
          <tr key={r.id} className={r.comparable_tariff ? "" : "muted"}>
            <td><strong>{r.procurer}</strong><br /><small>{r.tender_title}</small>{r.tender_reference && <br />}<small className="mono">{r.tender_reference}</small></td>
            <td>{r.bidder}<br /><small>{r.allocation}</small></td>
            <td>{r.capacity ?? "—"} {r.capacity_unit}{r.adopted_capacity != null && <small><br />adopted {r.adopted_capacity}</small>}</td>
            <td>{r.price ?? "—"} <small>{r.price_unit}</small>{r.adopted_price != null && <small><br />adopted {r.adopted_price}</small>}{!r.comparable_tariff && <small className="chip warn"><br />{r.why_not_comparable}</small>}</td>
            <td><span className="chip">{r.result_kind}</span><br /><small>{r.status_as_stated}</small>{r.flagged && <small className="chip warn">flagged</small>}</td>
            <td>{r.award_date || r.date_as_stated || "—"}<br /><small>{r.date_type}</small></td>
            <td>{r.contract_duration_years ?? "—"}</td>
            <td><small>{r.storage_or_delivery_conditions || "—"}</small></td>
            <td><small>{r.why_similar.join("; ")}</small>{r.missing.length > 0 && <small className="chip warn"><br />missing: {r.missing.join(", ")}</small>}</td>
            <td><a href={r.source_url} target="_blank" rel="noreferrer">source</a> p.{r.source_page}<br /><small className="mono">{r.source_sha256?.slice(0, 10)}</small><br /><small>{r.verification}</small></td>
          </tr>
        ))}</tbody></table>
    </section>
  );
}
