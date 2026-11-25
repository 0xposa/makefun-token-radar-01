// Launch Radar dashboard — reads window.RADAR_BOARD / window.RADAR_DOSSIER
// from ../data.js (written beside dashboard/ by main.ts). No network.
const B = window.RADAR_BOARD || [], D = window.RADAR_DOSSIER || {};
const fmt$ = n => n==null ? "—" : n>=1e9 ? "$"+(n/1e9).toFixed(2)+"B" : n>=1e6 ? "$"+(n/1e6).toFixed(1)+"M" : "$"+(n/1e3).toFixed(0)+"K";
const pct = n => n==null ? "—" : '<span class="'+(n>=0?"pos":"neg")+'">'+(n>=0?"+":"")+n.toFixed(1)+"%</span>";
const cats = [...new Set(B.map(r=>r.category))].sort();
const chains = [...new Set(B.flatMap(r=>r.chains))].sort();
const state = { q:"", cat:"", chain:"", verdict:"", minScore:0, watchOnly:false, sort:"implied_value", dir:-1 };

function boardView(){
  const rows = B.filter(r =>
    (!state.q || r.name.toLowerCase().includes(state.q)) &&
    (!state.cat || r.category===state.cat) &&
    (!state.chain || r.chains.includes(state.chain)) &&
    (!state.verdict || r.verdict===state.verdict) &&
    (!state.watchOnly || r.watchlist) &&
    r.launch_score >= state.minScore);
  rows.sort((a,b)=>{ const k=state.sort, d=state.dir; const x=a[k], y=b[k];
    return (typeof x==="string" ? x.localeCompare(y) : x-y)*d; });
  const th = (k,label,cls)=>'<th class="'+(cls||"")+'" data-sort="'+k+'">'+label+(state.sort===k?(state.dir<0?" ↓":" ↑"):"")+'</th>';
  return `
  <header><div class="logo">LAUNCH<b>RADAR</b></div>
    <div class="tag">Every pre-token protocol worth watching — priced by what its launch would be worth, with the steps to farm it.</div></header>
  <div class="stats">
    <div class="stat"><div class="k">Candidates</div><div class="v">${B.length}</div><div class="s">${D.watchlist_rows||""} on the $50M+ watchlist</div></div>
    <div class="stat"><div class="k">Combined TVL</div><div class="v">${fmt$(D.combined_tvl)}</div><div class="s">across the board</div></div>
    <div class="stat"><div class="k">Combined implied</div><div class="v">${fmt$(D.combined_implied_value)}</div><div class="s">if all launched at model value</div></div>
    <div class="stat"><div class="k">Model</div><div class="v">curve-blend-1</div><div class="s">log-log fit on ${D.peers_with_market_cap||""} tokenised peers · R² ${D.model?D.model.curve.r2:""}</div></div>
    <div class="stat"><div class="k">Showing</div><div class="v">${rows.length}</div><div class="s">after filters</div></div>
  </div>
  <div class="bar">
    <input type="search" id="q" placeholder="Search protocol…" value="${state.q.replace(/"/g,"&quot;")}">
    <label>Category <select id="cat"><option value="">All</option>${cats.map(c=>`<option ${c===state.cat?"selected":""}>${c}</option>`).join("")}</select></label>
    <label>Chain <select id="chain"><option value="">All</option>${chains.map(c=>`<option ${c===state.chain?"selected":""}>${c}</option>`).join("")}</select></label>
    <label>Verdict <select id="verdict"><option value="">All</option>${["FARM","WATCH","SKIP"].map(v=>`<option ${v===state.verdict?"selected":""}>${v}</option>`).join("")}</select></label>
    <label>Min score <input type="range" id="minScore" min="0" max="90" step="5" value="${state.minScore}"> <span id="msv">${state.minScore}</span></label>
    <label><input type="checkbox" id="watchOnly" ${state.watchOnly?"checked":""}> Watchlist only</label>
  </div>
  <div class="wrap"><table><thead><tr>
    ${th("rank","#","l")}${th("name","Protocol","l")}${th("category","Category","l")}${th("tvl","TVL")}${th("change_7d","7d")}
    ${th("implied_value","Implied value")}${th("implied_multiple","Mult")}${th("launch_score","Score")}${th("verdict","Verdict","l")}
  </tr></thead><tbody>
  ${rows.map(r=>`<tr class="row" data-slug="${r.slug}">
    <td class="l">${r.rank}</td>
    <td class="l"><span class="nm">${r.name}</span>${r.watchlist?'<span class="wl">WATCHLIST</span>':""}<div style="color:var(--faint);font-size:11px">${r.chains.slice(0,3).join(" · ")||"—"}</div></td>
    <td class="l">${r.category}</td><td>${fmt$(r.tvl)}</td><td>${pct(r.change_7d)}</td>
    <td style="font-weight:700">${fmt$(r.implied_value)}</td><td>${r.implied_multiple.toFixed(2)}×</td>
    <td><span class="sc">${r.launch_score}</span><div class="meter"><i style="width:${r.launch_score}%"></i></div></td>
    <td class="l"><span class="vd ${r.verdict}">${r.verdict}</span></td></tr>`).join("")}
  </tbody></table></div>
  <div class="foot">Method: implied value blends a log-log FDV/TVL curve fitted on tokenised peers with the category's median multiple, then adjusts for 7-day TVL growth and chain breadth. Farm plans are heuristics, not financial advice. Data: sealed protocol snapshot — see dossier.json.</div>`;
}

function detailView(slug){
  const r = B.find(x=>x.slug===slug) || B[0];
  const planCost = r.farm_plan.reduce((s,x)=>s+x.cost_usd,0);
  return `
  <a class="back" href="#/">← back to the board</a>
  <div class="detail">
    <h1>${r.name} ${r.watchlist?'<span class="wl">WATCHLIST</span>':""}</h1>
    <div class="sub">${r.category} · ${r.chains.join(", ")||"—"} · main chain ${r.main_chain}${r.url?` · <a href="${r.url}" rel="noopener">${r.url.replace(/^https?:\/\//,"")}</a>`:""}</div>
    ${r.description?`<p class="desc">${r.description}</p>`:""}
    <div class="grid">
      <div class="card"><div class="k">Implied launch value</div><div class="v">${fmt$(r.implied_value)}</div><div class="s">${r.implied_multiple.toFixed(2)}× its TVL</div></div>
      <div class="card"><div class="k">TVL</div><div class="v">${fmt$(r.tvl)}</div><div class="s">1d ${r.change_1d==null?"—":r.change_1d.toFixed(1)+"%"} · 7d ${r.change_7d==null?"—":r.change_7d.toFixed(1)+"%"}</div></div>
      <div class="card"><div class="k">Launch score</div><div class="v">${r.launch_score} / 100</div><div class="s">verdict <span class="vd ${r.verdict}">${r.verdict}</span></div></div>
      <div class="card"><div class="k">Listed for</div><div class="v">${r.age_days==null?"—":r.age_days+" days"}</div><div class="s">rank #${r.rank} of ${B.length} candidates</div></div>
    </div>
    <h2>How the price is built</h2>
    <div class="grid">
      <div class="card"><div class="k">Curve value</div><div class="v">${fmt$(r.model.curve_value)}</div><div class="s">log-log FDV/TVL fit on tokenised peers</div></div>
      <div class="card"><div class="k">Category value</div><div class="v">${fmt$(r.model.category_value)}</div><div class="s">TVL × median multiple of ${r.category}</div></div>
      <div class="card"><div class="k">Growth factor</div><div class="v">×${r.model.growth_factor.toFixed(3)}</div><div class="s">from 7-day TVL change</div></div>
      <div class="card"><div class="k">Breadth factor</div><div class="v">×${r.model.breadth_factor.toFixed(3)}</div><div class="s">${r.chains.length} chain(s) live</div></div>
    </div>
    <h2>Risk flags</h2>
    ${r.risk_flags.length ? r.risk_flags.map(f=>`<div class="flag">⚠ ${f}</div>`).join("") : '<div class="ok">✓ No flags on the standard checks.</div>'}
    <h2>Farm plan — est. total cost $${planCost.toFixed(2)} + position capital</h2>
    <table class="steps"><tbody>
    ${r.farm_plan.map(s=>`<tr><td style="width:34px;color:var(--faint)">${s.step}</td><td>${s.action}</td><td style="width:110px">${s.cost_usd? "$"+s.cost_usd.toFixed(2) : "—"}</td><td style="width:110px;color:var(--dim)">${s.time}</td></tr>`).join("")}
    </tbody></table>
    <div class="foot">Heuristic plan generated from category, main chain, TVL band and age. Verify every step on the protocol's own site before acting.</div>
  </div>`;
}

function render(){
  const h = location.hash || "#/";
  const app = document.getElementById("app");
  if (h.startsWith("#/p/")) { app.innerHTML = detailView(decodeURIComponent(h.slice(4))); window.scrollTo(0,0); return; }
  if (h.startsWith("#/?")) {
    const q = new URLSearchParams(h.slice(3));
    if (q.get("cat")) state.cat = q.get("cat");
    if (q.get("verdict")) state.verdict = q.get("verdict");
    if (q.get("chain")) state.chain = q.get("chain");
    if (q.get("q")) state.q = q.get("q").toLowerCase();
    if (q.get("minScore")) state.minScore = +q.get("minScore") || 0;
  }
  app.innerHTML = boardView();
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on("q","input",e=>{ state.q = e.target.value.toLowerCase(); render(); const el=document.getElementById("q"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  on("cat","change",e=>{ state.cat = e.target.value; render(); });
  on("chain","change",e=>{ state.chain = e.target.value; render(); });
  on("verdict","change",e=>{ state.verdict = e.target.value; render(); });
  on("minScore","input",e=>{ state.minScore = +e.target.value; render(); });
  on("watchOnly","change",e=>{ state.watchOnly = e.target.checked; render(); });
  document.querySelectorAll("th[data-sort]").forEach(t=>t.addEventListener("click",()=>{
    const k=t.dataset.sort; if (state.sort===k) state.dir*=-1; else { state.sort=k; state.dir = k==="name"||k==="category" ? 1 : -1; } render(); }));
  document.querySelectorAll("tr.row").forEach(t=>t.addEventListener("click",()=>{ location.hash = "#/p/"+t.dataset.slug; }));
}
window.addEventListener("hashchange", render);
render();
