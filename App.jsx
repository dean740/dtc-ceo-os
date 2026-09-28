import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";
import { supabase, supabaseConfigured } from "./supabaseClient";
import AuthGate, { SignOutButton } from "./AuthGate";

/* ============================================================================
   DTC PAID ADS — CEO OPERATING SYSTEM
   Internal command center. In-memory store (Supabase-ready shape). No seed data.
   ========================================================================== */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const nowISO = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtMoney = (n) =>
  n == null || n === "" || isNaN(n) ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(n));
const fmtNum = (n) => (n == null || n === "" || isNaN(n) ? "—" : new Intl.NumberFormat("en-US").format(Number(n)));
const fmtDate = (d) => (!d ? "—" : new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
const isOverdue = (d) => !!d && d < todayStr();
const daysUntil = (d) => (!d ? null : Math.round((new Date(d + "T00:00:00") - new Date(todayStr() + "T00:00:00")) / 86400000));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const num = (v, def = 0) => (v === "" || v == null || isNaN(v) ? def : Number(v));
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const exportCSV = (rows, cols, filename) => {
  if (!rows.length) return;
  const head = cols.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(c.get ? c.get(r) : r[c.key])).join(",")).join("\n");
  const blob = new Blob([head + "\n" + body], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
};

const DEFAULT_SETTINGS = {
  statuses: ["Not Started", "In Progress", "Waiting", "Blocked", "Done", "Killed"],
  priorities: ["Low", "Medium", "High", "Critical"],
  cadences: ["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"],
  tools: ["Asana", "Monday", "ClickUp", "Notion", "Slack", "HubSpot", "Google Ads", "Meta Ads", "Spreadsheet"],
  serviceLines: ["Meta Ads", "Google Ads", "Creative", "CRO", "CRM", "Consulting", "Other"],
  owners: ["CEO"],
  pillars: ["Acquisition", "Retention", "Profitability", "Systems", "Brand"],
  revenueTargetMonthly: "",
  pipelineTargetMonthly: "",
  touchCadenceDays: 7,
  kpiStaleDays: 4,
  health: { roas: 35, touch: 25, deliverables: 15, trend: 15, gut: 10 },
  meetingTypes: ["Discovery", "Onboarding", "Weekly Sync", "Strategy", "QBR", "Ad-hoc", "Renewal"],
  reportSection: ["Wins this week", "Spend & performance", "What we shipped", "Next steps", "Asks / blockers"],
  googleCalendarUrl: "",
};

const TASK_TYPES = ["Radar", "Action Item", "Major Task", "General Task"];
const PROJECT_STATUS = ["Planning", "Active", "At Risk", "On Hold", "Complete", "Killed"];
const CLIENT_STATUS = ["Green", "Yellow", "Red", "Paused", "Offboarding"];
const BILLING_TYPES = ["Retainer", "Project", "Hybrid"];
const PARTNER_WORK = ["Project work", "Client work", "Both"];
const PARTNER_STATUS = ["Active", "Available", "Busy", "Inactive"];
const PAY_BASIS = ["Hourly", "Per project", "Monthly retainer", "Rev-share", "Other"];
const LEAD_STATUS = ["New", "Contacted", "Qualified", "Proposal Sent", "Negotiation", "Closed Won", "Closed Lost", "Nurture"];
const REPORTING = ["Weekly", "Bi-weekly", "Monthly"];
const VISION_TYPES = ["Business", "Personal", "Financial", "Team", "Client", "Product", "Brand", "Lifestyle"];
const HORIZONS = ["1 Year", "3 Years", "5 Years", "10 Years"];
const JOURNAL_CATEGORIES = ["CEO Reflection", "Win", "Lesson", "Problem", "Idea", "Decision", "Vision", "Personal"];

const calc = {
  taskScore: (t) => num(t.impact_score) * num(t.urgency_score),
  weightedPipeline: (l) => num(l.deal_value) * (num(l.probability) / 100),
  agencyRevenue: (c) => num(c.monthly_retainer) + num(c.ad_spend) * (num(c.management_fee_percent) / 100),
  // Recurring monthly revenue — counts only billing types that actually recur.
  // Project-only clients contribute $0 to MRR (their value is one project total).
  recurringRevenue: (c) => {
    const bt = c.billing_type || "Retainer";
    if (bt === "Project") return 0;
    return num(c.monthly_retainer) + num(c.ad_spend) * (num(c.management_fee_percent) / 100);
  },
  // One-time revenue: setup fee + any one-time bonus pay. Kept OUT of MRR.
  oneTimeRevenue: (c) => num(c.setup_fee) + num(c.one_time_bonus),
  projectBalance: (c) => Math.max(0, num(c.project_value) - num(c.project_paid)),
  totalHours: (m) => num(m.client_hours) + num(m.sales_hours) + num(m.ops_admin_hours),
  utilization: (m) => { const t = num(m.target_hours_per_week); return t ? (calc.totalHours(m) / t) * 100 : 0; },
  capacityStatus: (m) => { const u = calc.utilization(m); return u > 90 ? "Overloaded" : u >= 75 ? "Tight" : "Healthy"; },
  taskOverdue: (t) => isOverdue(t.due_date) && !["Done", "Killed"].includes(t.status),
  followupOverdue: (l) => isOverdue(l.next_follow_up_date) && !["Closed Won", "Closed Lost"].includes(l.lead_status),
  touchOverdue: (c) => isOverdue(c.next_client_touch) && !["Offboarding", "Paused"].includes(c.client_status),
  projectAtRisk: (p) => {
    if (["Complete", "Killed"].includes(p.status)) return false;
    if (p.status === "At Risk") return true;
    const d = daysUntil(p.target_finish_date);
    return d != null && d <= 14 && num(p.progress_percent) < 60;
  },
  // ---- KPI / client analytics ----
  kpisFor: (db, clientId) => db.kpis.filter((k) => k.client_id === clientId).sort((a, b) => (a.date < b.date ? 1 : -1)),
  latestKpi: (db, clientId) => calc.kpisFor(db, clientId)[0] || null,
  kpiTrend: (db, clientId) => {
    const ks = calc.kpisFor(db, clientId);
    if (ks.length < 2) return null;
    return num(ks[0].roas) - num(ks[1].roas); // latest minus previous
  },
  daysSinceTouch: (c) => {
    const d = c.last_touch_date || c.last_update;
    if (!d) return null;
    return Math.round((new Date(todayStr()) - new Date(d)) / 86400000);
  },
  contractDaysLeft: (c) => daysUntil(c.renewal_date),
  // Computed health: analytical signals + gut, weighted per settings. Returns 0-100 or null.
  computedHealth: (db, settings, c) => {
    const w = settings.health || { roas: 35, touch: 25, deliverables: 15, trend: 15, gut: 10 };
    const parts = []; let used = 0;
    const k = calc.latestKpi(db, c.id);
    // ROAS vs target
    if (k && num(k.roas) && num(k.roas_target)) {
      const r = clamp((num(k.roas) / num(k.roas_target)) * 100, 0, 130);
      parts.push([Math.min(r, 100), w.roas]); used += w.roas;
    }
    // Touch recency vs cadence
    const dst = calc.daysSinceTouch(c), cad = num(settings.touchCadenceDays, 7);
    if (dst != null && cad) {
      const s = clamp(100 - Math.max(0, dst - cad) * (100 / (cad * 2)), 0, 100);
      parts.push([s, w.touch]); used += w.touch;
    }
    // Open deliverables / blocked load
    const open = num(c.open_deliverables_count), blocked = num(c.blocked_items_count);
    if (open || blocked || c.open_deliverables_count === 0) {
      const s = clamp(100 - blocked * 25 - Math.max(0, open - 3) * 8, 0, 100);
      parts.push([s, w.deliverables]); used += w.deliverables;
    }
    // ROAS trend
    const tr = calc.kpiTrend(db, c.id);
    if (tr != null) { parts.push([clamp(50 + tr * 25, 0, 100), w.trend]); used += w.trend; }
    // Gut feel (manual slider)
    if (c.health_score !== "" && c.health_score != null) { parts.push([num(c.health_score), w.gut]); used += w.gut; }
    if (!used) return null;
    return Math.round(parts.reduce((s, [v, wt]) => s + v * wt, 0) / used);
  },
  healthBand: (h) => h == null ? "Unknown" : h >= 75 ? "Green" : h >= 50 ? "Yellow" : "Red",
  kpiStale: (db, settings, c) => {
    const k = calc.latestKpi(db, c.id);
    if (!k) return true;
    return Math.round((new Date(todayStr()) - new Date(k.date)) / 86400000) > num(settings.kpiStaleDays, 4);
  },
  nextOccurrence: (t) => {
    const base = t.due_date || todayStr();
    const d = new Date(base + "T00:00:00");
    const n = num(t.recur_interval, 1);
    if (t.recurrence === "Daily") d.setDate(d.getDate() + n);
    else if (t.recurrence === "Weekly") d.setDate(d.getDate() + 7 * n);
    else if (t.recurrence === "Monthly") d.setMonth(d.getMonth() + n);
    else return null;
    return d.toISOString().slice(0, 10);
  },
};

const emptyDB = () => ({ tasks: [], projects: [], clients: [], leads: [], team: [], journal: [], vision: [], notes: [], meetings: [], kpis: [], updates: [], inbox: [], reports: [], playbooks: [] });

/* ----------------------------- persistence ------------------------------ */
/* Data is saved to the browser (localStorage) so it survives refreshes and
   app restarts. Schema is unchanged, so swapping in a back-end stays trivial. */
const LS_DB_KEY = "dtc_os_db_v1";
const LS_SETTINGS_KEY = "dtc_os_settings_v1";

const safeParse = (raw, fallback) => {
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : fallback; }
  catch { return fallback; }
};
const loadDB = () => {
  if (typeof window === "undefined" || !window.localStorage) return emptyDB();
  return { ...emptyDB(), ...safeParse(window.localStorage.getItem(LS_DB_KEY), {}) };
};
const loadSettings = () => {
  if (typeof window === "undefined" || !window.localStorage) return DEFAULT_SETTINGS;
  const s = safeParse(window.localStorage.getItem(LS_SETTINGS_KEY), {});
  return { ...DEFAULT_SETTINGS, ...s, health: { ...DEFAULT_SETTINGS.health, ...(s.health || {}) } };
};
const saveLS = (key, value) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota / private mode */ }
};

const StoreCtx = createContext(null);
const useStore = () => useContext(StoreCtx);

/* ------------------------- cloud sync (Supabase) ------------------------- */
/* The UI updates instantly against local state (snappy), and every change is
   written through to Supabase so your data is live everywhere. localStorage is
   kept as an offline cache. If Supabase isn't configured, it falls back to the
   pure local-only behavior so the app still runs. */
const cloudUpsert = (coll, row) => {
  if (!supabaseConfigured) return;
  supabase.from("records").upsert({ id: row.id, collection: coll, data: row, updated_at: nowISO() })
    .then(({ error }) => { if (error) console.warn("sync upsert", coll, error.message); });
};
const cloudDelete = (coll, id) => {
  if (!supabaseConfigured) return;
  supabase.from("records").delete().match({ collection: coll, id })
    .then(({ error }) => { if (error) console.warn("sync delete", coll, error.message); });
};

function StoreProvider({ children }) {
  const [db, setDb] = useState(loadDB);
  const [settings, setSettings] = useState(loadSettings);
  const [syncState, setSyncState] = useState(supabaseConfigured ? "loading" : "local");
  const settingsTimer = useRef(null);

  // Cache locally on every change (offline resilience / instant boot).
  useEffect(() => { saveLS(LS_DB_KEY, db); }, [db]);
  useEffect(() => { saveLS(LS_SETTINGS_KEY, settings); }, [settings]);

  // On login, pull the authoritative copy from the cloud.
  useEffect(() => {
    if (!supabaseConfigured) return;
    let cancelled = false;
    const pull = async () => {
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) { setSyncState("signedout"); return; }
      setSyncState("loading");
      const next = emptyDB();
      const { data: rows, error } = await supabase.from("records").select("collection,data").limit(100000);
      if (!cancelled && !error && rows) {
        rows.forEach((r) => { if (next[r.collection]) next[r.collection].push(r.data); });
        Object.keys(next).forEach((k) => next[k].sort((a, b) => ((b.updated_at || "") < (a.updated_at || "") ? -1 : 1)));
        setDb(next);
      }
      const { data: st } = await supabase.from("app_settings").select("data").maybeSingle();
      if (!cancelled && st && st.data) setSettings((s) => ({ ...s, ...st.data, health: { ...s.health, ...(st.data.health || {}) } }));
      if (!cancelled) setSyncState(error ? "error" : "synced");
    };
    pull();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, sess) => { if (sess) pull(); });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  // Debounced settings sync.
  useEffect(() => {
    if (!supabaseConfigured || syncState === "loading") return;
    clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => {
      supabase.from("app_settings").upsert({ data: settings, updated_at: nowISO() })
        .then(({ error }) => { if (error) console.warn("settings sync", error.message); });
    }, 600);
    return () => clearTimeout(settingsTimer.current);
  }, [settings]); // eslint-disable-line

  const api = useMemo(() => {
    const stamp = (o, isNew) => ({ ...o, updated_at: nowISO(), ...(isNew ? { created_at: nowISO() } : {}) });
    const add = (coll, rec) => {
      const row = stamp({ id: uid(), ...rec }, true);
      setDb((d) => ({ ...d, [coll]: [row, ...d[coll]] }));
      cloudUpsert(coll, row);
      return row;
    };
    const update = (coll, id, patch) =>
      setDb((d) => {
        let updatedRow = null, spawnedClone = null;
        const next = { ...d, [coll]: d[coll].map((r) => { if (r.id === id) { updatedRow = stamp({ ...r, ...patch }); return updatedRow; } return r; }) };
        // Project -> Retainer conversion: log the date once.
        if (coll === "clients" && patch.billing_type) {
          const prev = d.clients.find((r) => r.id === id);
          if (prev && prev.billing_type === "Project" && patch.billing_type !== "Project" && !prev.converted_to_retainer_date) {
            updatedRow = { ...updatedRow, converted_to_retainer_date: todayStr() };
            next.clients = next.clients.map((r) => (r.id === id ? updatedRow : r));
          }
        }
        // Recurrence: completing a repeating task spawns the next occurrence
        if (coll === "tasks" && patch.status === "Done") {
          const t = d.tasks.find((r) => r.id === id);
          if (t && t.recurrence && t.recurrence !== "None" && !t._spawned) {
            const nd = calc.nextOccurrence(t);
            if (nd) {
              spawnedClone = stamp({ ...t, id: uid(), status: "Not Started", due_date: nd, start_date: "", completed_date: "", _spawned: false }, true);
              next.tasks = [spawnedClone, ...next.tasks];
              next.tasks = next.tasks.map((r) => (r.id === id ? { ...r, _spawned: true } : r));
              updatedRow = next.tasks.find((r) => r.id === id);
            }
          }
        }
        if (updatedRow) cloudUpsert(coll, updatedRow);
        if (spawnedClone) cloudUpsert("tasks", spawnedClone);
        return next;
      });
    const remove = (coll, id) => { setDb((d) => ({ ...d, [coll]: d[coll].filter((r) => r.id !== id) })); cloudDelete(coll, id); };
    return { add, update, remove };
  }, []);

  return <StoreCtx.Provider value={{ db, setDb, ...api, settings, setSettings, syncState }}>{children}</StoreCtx.Provider>;
}
/* ----------------------------- design system ---------------------------- */
const C = {
  ink: "#0a0a0b", charcoal: "#1c1d20", slate: "#3a3c42", mute: "#6b6e76",
  line: "#e4e5e8", line2: "#eef0f2", panel: "#ffffff", bg: "#f5f6f8", chip: "#f0f1f4",
  green: "#1f9d57", greenBg: "#e8f6ee", yellow: "#b7791f", yellowBg: "#fbf3e2",
  red: "#c0362c", redBg: "#fbebe9", blue: "#2563c9", blueBg: "#e9f0fc",
  // elevation
  sh1: "0 1px 2px rgba(16,18,22,.04), 0 1px 3px rgba(16,18,22,.06)",
  sh2: "0 2px 4px rgba(16,18,22,.04), 0 4px 12px rgba(16,18,22,.07)",
  sh3: "0 8px 18px rgba(16,18,22,.08), 0 18px 44px rgba(16,18,22,.12)",
  ease: "cubic-bezier(.2,.7,.3,1)",
};

const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap');
    :root{
      --fs-display:30px; --fs-h1:21px; --fs-h2:16px; --fs-title:14px;
      --fs-body:13.5px; --fs-sm:12.5px; --fs-xs:11px; --fs-micro:10px;
      --lh-tight:1.12; --lh-snug:1.32; --lh-body:1.55;
      --ls-tight:-.022em; --ls-snug:-.012em; --ls-wide:.04em;
      --sp1:4px; --sp2:8px; --sp3:12px; --sp4:16px; --sp5:24px; --sp6:32px;
    }
    *{box-sizing:border-box}
    html,body,#root{height:100%}
    body{margin:0;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      background:${C.bg};color:${C.ink};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-size:var(--fs-body);line-height:var(--lh-snug)}
    button{font-family:inherit;cursor:pointer}
    input,select,textarea{font-family:inherit;font-size:var(--fs-body)}
    h1,h2,h3{font-weight:700;letter-spacing:var(--ls-tight);line-height:var(--lh-tight)}
    ::-webkit-scrollbar{width:10px;height:10px}
    ::-webkit-scrollbar-thumb{background:#d3d5da;border-radius:6px;border:2px solid ${C.bg}}
    ::-webkit-scrollbar-thumb:hover{background:#bcbfc6}
    .os-num{font-family:'Geist Mono','Geist',ui-monospace,monospace;font-variant-numeric:tabular-nums;font-feature-settings:'tnum';letter-spacing:-.01em}
    .os-eyebrow{font-size:var(--fs-micro);font-weight:700;text-transform:uppercase;letter-spacing:var(--ls-wide);color:${C.mute}}
    .os-card{transition:box-shadow .2s ${C.ease}, transform .2s ${C.ease}, border-color .2s ${C.ease}}
    .os-card-h:hover{box-shadow:${C.sh2};transform:translateY(-1px)}
    .os-row{transition:background .14s ${C.ease}}
    .os-row:hover{background:${C.line2}}
    .os-nav{transition:background .14s ${C.ease},color .14s ${C.ease}}
    .os-nav:hover{background:#17181b}
    .os-btn{transition:transform .12s ${C.ease},box-shadow .16s ${C.ease},background .16s ${C.ease},border-color .16s ${C.ease},opacity .16s}
    .os-btn:hover{box-shadow:${C.sh2}}
    .os-btn:active{transform:translateY(1px);box-shadow:${C.sh1}}
    .os-pop{animation:os-pop .16s ${C.ease}}
    .os-fadeup{animation:os-fade .26s ${C.ease} both}
    @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
    *:focus-visible{outline:2px solid ${C.blue};outline-offset:2px;border-radius:5px}
    @keyframes os-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @keyframes os-pop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
    @keyframes os-slide-in{from{transform:translateX(-100%)}to{transform:translateX(0)}}
    @keyframes os-drawer-in{from{transform:translateX(24px);opacity:.6}to{transform:none;opacity:1}}
    @keyframes os-toast-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}

    /* ---- Tablet / small desktop ---- */
    @media (max-width:1024px){
      .os-main{padding:18px 18px 56px!important}
    }

    /* ---- Mobile: off-canvas sidebar ---- */
    @media (max-width:840px){
      .os-sidebar{
        position:fixed!important;top:0;left:0;z-index:50;height:100dvh!important;
        transform:translateX(-100%);transition:transform .22s ease;
        width:min(280px,86vw)!important;box-shadow:8px 0 40px rgba(0,0,0,.18);
      }
      .os-sidebar[data-open="1"]{transform:translateX(0);animation:os-slide-in .22s ease}
      .os-menu-btn{display:grid!important;place-items:center}
      .os-main{padding:16px 14px 72px!important}
      .os-topbar{padding:9px 12px!important;gap:8px!important}
      /* hide secondary topbar controls on phones, keep search+menu+quickadd+bell */
      .os-date,.os-cadence,.os-profile{display:none!important}
      .os-pagehead{flex-direction:column!important;align-items:flex-start!important;gap:12px!important}
      .os-pagehead-actions{width:100%;flex-wrap:wrap}
      .os-toolbar{flex-wrap:wrap}
      /* 16px inputs stop iOS auto-zoom */
      input,select,textarea{font-size:16px!important}
      .os-search input{font-size:16px!important}
    }

    /* ---- Narrow phones ---- */
    @media (max-width:440px){
      .os-pagehead-actions .os-btn{flex:1 1 auto}
    }

    /* Larger tap targets on touch devices */
    @media (hover:none) and (pointer:coarse){
      button,.os-row,.os-nav,select{min-height:40px}
      .os-tap{min-height:44px;min-width:44px}
    }
  `}</style>
);

const statusTone = (s) => ({
  "Done": "green", "Complete": "green", "Green": "green", "Closed Won": "green", "Healthy": "green", "Active": "green",
  "In Progress": "blue", "Active ": "blue", "New": "blue", "Contacted": "blue", "Qualified": "blue", "Planning": "blue",
  "Waiting": "yellow", "On Hold": "yellow", "Yellow": "yellow", "Tight": "yellow", "Paused": "yellow", "Nurture": "yellow",
  "Proposal Sent": "yellow", "Negotiation": "yellow", "Not Started": "slate",
  "Blocked": "red", "Killed": "red", "Red": "red", "At Risk": "red", "Overloaded": "red", "Closed Lost": "red", "Offboarding": "red",
}[s] || "slate");
const prioTone = (p) => ({ Low: "slate", Medium: "blue", High: "yellow", Critical: "red" }[p] || "slate");

function Pill({ children, tone = "slate", dot }) {
  const map = {
    green: [C.greenBg, C.green], yellow: [C.yellowBg, C.yellow], red: [C.redBg, C.red],
    blue: [C.blueBg, C.blue], slate: [C.chip, C.slate],
  };
  const [bg, fg] = map[tone] || map.slate;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: bg, color: fg,
      padding: "3px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", letterSpacing: ".01em" }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: fg }} />}
      {children}
    </span>
  );
}
const StatusPill = ({ value }) => (value ? <Pill tone={statusTone(value)} dot>{value}</Pill> : <span style={{ color: C.mute }}>—</span>);
const PrioBadge = ({ value }) => (value ? <Pill tone={prioTone(value)}>{value}</Pill> : <span style={{ color: C.mute }}>—</span>);

function Progress({ value = 0, tone }) {
  const v = clamp(num(value), 0, 100);
  const col = tone || (v >= 75 ? C.green : v >= 40 ? C.blue : v >= 20 ? C.yellow : C.red);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, background: C.line, borderRadius: 99, overflow: "hidden" }}>
        <div style={{ width: v + "%", height: "100%", background: col, borderRadius: 99, transition: "width .3s" }} />
      </div>
      <span className="os-num" style={{ fontSize: 11.5, color: C.mute, width: 30, textAlign: "right" }}>{v}%</span>
    </div>
  );
}

function Btn({ children, onClick, variant = "ghost", size = "md", style, type = "button", title }) {
  const base = { border: "1px solid transparent", borderRadius: 9, fontWeight: 550, display: "inline-flex",
    alignItems: "center", gap: 7, whiteSpace: "nowrap", letterSpacing: "-.005em" };
  const sizes = { sm: { padding: "6px 11px", fontSize: "var(--fs-sm)" }, md: { padding: "9px 15px", fontSize: "var(--fs-body)" } };
  const variants = {
    solid: { background: C.ink, color: "#fff", boxShadow: C.sh1 },
    ghost: { background: "#fff", color: C.charcoal, border: `1px solid ${C.line}`, boxShadow: C.sh1 },
    subtle: { background: C.chip, color: C.charcoal },
    danger: { background: C.redBg, color: C.red },
    link: { background: "transparent", color: C.blue, padding: 0, border: "none" },
  };
  return (
    <button type={type} title={title} onClick={onClick} className="os-btn"
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}>{children}</button>
  );
}

function Card({ title, sub, right, children, pad = 16, style, hover }) {
  return (
    <section className={"os-card" + (hover ? " os-card-h" : "")} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, boxShadow: C.sh1, ...style }}>
      {(title || right) && (
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          padding: "14px 18px", borderBottom: `1px solid ${C.line2}` }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: "var(--fs-title)", fontWeight: 650, letterSpacing: "var(--ls-snug)" }}>{title}</h3>
            {sub && <p style={{ margin: "3px 0 0", fontSize: "var(--fs-sm)", color: C.mute, lineHeight: 1.4 }}>{sub}</p>}
          </div>
          {right}
        </header>
      )}
      <div style={{ padding: pad }}>{children}</div>
    </section>
  );
}

function Empty({ title, hint, action }) {
  return (
    <div style={{ textAlign: "center", padding: "30px 16px", color: C.mute }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: C.chip, margin: "0 auto 10px",
        display: "grid", placeItems: "center", color: C.slate, fontSize: 18, fontWeight: 700 }}>+</div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.slate }}>{title}</div>
      {hint && <div style={{ fontSize: 12.5, marginTop: 3 }}>{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

/* Animated number: parses the numeric core of a string (e.g. "$12,400", "3.2×",
   "87%") and counts up to it, preserving prefix/suffix. Respects reduced motion. */
function CountUp({ value, className, style }) {
  const str = String(value ?? "");
  const match = str.match(/-?[\d,]*\.?\d+/);
  const target = match ? parseFloat(match[0].replace(/,/g, "")) : null;
  const [disp, setDisp] = useState(target ?? 0);
  const prev = useRef(target ?? 0);
  useEffect(() => {
    if (target == null) return;
    const reduce = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    if (reduce) { setDisp(target); prev.current = target; return; }
    const from = prev.current, to = target, dur = 520, t0 = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setDisp(from + (to - from) * e);
      if (p < 1) raf = requestAnimationFrame(tick); else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  if (target == null) return <span className={className} style={style}>{str}</span>;
  const decimals = (match[0].split(".")[1] || "").length;
  const hadComma = match[0].includes(",");
  const shown = hadComma ? disp.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : disp.toFixed(decimals);
  const out = str.replace(match[0], shown);
  return <span className={className} style={style}>{out}</span>;
}

function KPI({ label, value, sub, tone }) {
  const fg = tone ? { green: C.green, yellow: C.yellow, red: C.red, blue: C.blue }[tone] : C.ink;
  const rail = tone ? { green: C.green, yellow: C.yellow, red: C.red, blue: C.blue }[tone] : "transparent";
  return (
    <div className="os-card os-card-h" style={{ position: "relative", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "15px 16px 16px", boxShadow: C.sh1, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: rail }} />
      <div className="os-eyebrow">{label}</div>
      <CountUp value={value} className="os-num" style={{ display: "block", fontSize: 26, fontWeight: 700, marginTop: 7, color: fg, letterSpacing: "-.02em", lineHeight: 1 }} />
      {sub && <div style={{ fontSize: "var(--fs-sm)", color: C.mute, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

/* ------------------------------- toasts ---------------------------------- */
const ToastCtx = createContext(null);
const useToast = () => useContext(ToastCtx) || (() => {});
function ToastHost({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useMemo(() => (msg, tone = "default") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 90, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", pointerEvents: "none" }}>
        {toasts.map((t) => {
          const accent = { default: C.ink, success: C.green, warn: C.yellow, danger: C.red }[t.tone] || C.ink;
          return (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, background: C.ink, color: "#fff", padding: "11px 16px", borderRadius: 11, boxShadow: C.sh3, fontSize: "var(--fs-body)", fontWeight: 500, animation: "os-toast-in .24s " + C.ease, maxWidth: 420 }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: accent, flexShrink: 0 }} />
              {t.msg}
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/* ------------------------------- form fields ----------------------------- */
const fldWrap = { display: "flex", flexDirection: "column", gap: 5 };
const lblS = { fontSize: 11.5, fontWeight: 600, color: C.slate, letterSpacing: ".01em" };
const inS = { padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 8, background: "#fff", width: "100%", color: C.ink };

function Field({ label, span, children }) {
  return <label style={{ ...fldWrap, gridColumn: span ? `span ${span}` : undefined }}><span style={lblS}>{label}</span>{children}</label>;
}
const Text = (p) => <input style={inS} {...p} />;
const Area = (p) => <textarea style={{ ...inS, minHeight: 74, resize: "vertical", lineHeight: 1.5 }} {...p} />;
function Select({ value, onChange, options, placeholder = "Select…", allowEmpty = true }) {
  return (
    <select style={inS} value={value ?? ""} onChange={onChange}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Modal({ open, onClose, title, children, wide }) {
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div onMouseDown={onClose} className="os-fadeup" style={{ position: "fixed", inset: 0, background: "rgba(10,10,11,.42)", backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)", zIndex: 60,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflow: "auto" }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, width: "100%",
        maxWidth: wide ? 920 : 640, boxShadow: C.sh3, animation: "os-pop .2s " + C.ease }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", borderBottom: `1px solid ${C.line2}`, position: "sticky", top: 0, background: "#fff", borderRadius: "16px 16px 0 0" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" style={{ border: "none", background: C.chip, width: 30, height: 30,
            borderRadius: 8, fontSize: 17, color: C.slate }}>×</button>
        </header>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

const grid2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 };
function FormGrid({ children }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 14 }}>{children}</div>;
}
// Full-width subheading inside a FormGrid to group related fields.
function FormSectionLabel({ children }) {
  return <div style={{ gridColumn: "1 / -1", fontSize: 11, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: ".05em", color: C.mute, marginTop: 6, paddingBottom: 4, borderBottom: `1px solid ${C.line2}` }}>{children}</div>;
}
function FormActions({ onCancel, submitLabel = "Save", onDelete }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.line2}` }}>
      <div>{onDelete && <Btn variant="danger" onClick={onDelete}>Delete</Btn>}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn variant="solid" type="submit">{submitLabel}</Btn>
      </div>
    </div>
  );
}

/* simple data table */
function Table({ cols, rows, onRow, empty }) {
  if (!rows.length) return empty;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            {cols.map((c) => (
              <th key={c.key} style={{ padding: "9px 12px", fontSize: 11, fontWeight: 600, letterSpacing: ".05em",
                textTransform: "uppercase", color: C.mute, borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap",
                textAlign: c.align || "left", width: c.w }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="os-row" onClick={() => onRow && onRow(r)}
              style={{ cursor: onRow ? "pointer" : "default", transition: "background .12s" }}>
              {cols.map((c) => (
                <td key={c.key} style={{ padding: "11px 12px", borderBottom: `1px solid ${C.line2}`,
                  fontSize: 13, textAlign: c.align || "left", verticalAlign: "middle", color: C.charcoal }}>
                  {c.render ? c.render(r) : (r[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* filter/search bar shell */
function Toolbar({ children }) {
  return <div className="os-toolbar" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>{children}</div>;
}
const SearchInput = ({ value, onChange, placeholder = "Search…", onFocus }) => (
  <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180 }}>
    <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: C.mute, fontSize: 13 }}>⌕</span>
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} onFocus={onFocus}
      style={{ ...inS, paddingLeft: 30 }} />
  </div>
);
const MiniSelect = ({ value, onChange, options, label }) => (
  <select value={value} onChange={(e) => onChange(e.target.value)}
    style={{ padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 8, background: "#fff", color: value ? C.ink : C.mute }}>
    <option value="">{label}</option>
    {options.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>
);
/* --------------------------- relation helpers ---------------------------- */
const useRel = () => {
  const { db } = useStore();
  return {
    clientName: (id) => db.clients.find((c) => c.id === id)?.client_name,
    leadName: (id) => db.leads.find((l) => l.id === id)?.lead_name,
    projectName: (id) => db.projects.find((p) => p.id === id)?.name,
    taskTitle: (id) => db.tasks.find((t) => t.id === id)?.title,
    clientOpts: db.clients.map((c) => ({ id: c.id, label: c.client_name })),
    leadOpts: db.leads.map((l) => ({ id: l.id, label: l.lead_name })),
    projectOpts: db.projects.map((p) => ({ id: p.id, label: p.name })),
    taskOpts: db.tasks.map((t) => ({ id: t.id, label: t.title })),
    visionOpts: db.vision.map((v) => ({ id: v.id, label: v.title })),
  };
};

/* select that maps to a related record id */
function RelSelect({ value, onChange, options, placeholder = "None" }) {
  return (
    <select style={inS} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

const useForm = (initial) => {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));
  const setV = (k, v) => setF((s) => ({ ...s, [k]: v }));
  return [f, set, setV, setF];
};

/* ------------------------------- TASK FORM ------------------------------- */
function TaskForm({ initial, onSubmit, onClose, onDelete }) {
  const { settings } = useStore();
  const rel = useRel();
  const [f, set, setV] = useForm({
    title: "", description: "", task_type: "General Task", priority: "Medium", status: "Not Started",
    owner: "CEO", related_client: "", related_lead: "", related_project: "", related_vision: "",
    cadence: "Daily", due_date: "", start_date: "", completed_date: "", impact_score: 3, urgency_score: 3,
    blocker: "", next_step: "", tool: "", notes: "", recurrence: "None", recur_interval: 1, ...initial,
  });
  const submit = (e) => { e.preventDefault(); if (!f.title.trim()) return; onSubmit(f); };
  return (
    <form onSubmit={submit}>
      <FormGrid>
        <Field label="Title" span={2}><Text value={f.title} onChange={set("title")} autoFocus placeholder="What needs to happen?" /></Field>
        <Field label="Type"><Select value={f.task_type} onChange={set("task_type")} options={TASK_TYPES} allowEmpty={false} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={set("priority")} options={settings.priorities} allowEmpty={false} /></Field>
        <Field label="Status"><Select value={f.status} onChange={set("status")} options={settings.statuses} allowEmpty={false} /></Field>
        <Field label="Cadence"><Select value={f.cadence} onChange={set("cadence")} options={settings.cadences} allowEmpty={false} /></Field>
        <Field label="Owner"><Select value={f.owner} onChange={set("owner")} options={settings.owners} /></Field>
        <Field label="Tool"><Select value={f.tool} onChange={set("tool")} options={settings.tools} /></Field>
        <Field label="Start date"><Text type="date" value={f.start_date} onChange={set("start_date")} /></Field>
        <Field label="Due date"><Text type="date" value={f.due_date} onChange={set("due_date")} /></Field>
        <Field label="Repeat"><Select value={f.recurrence} onChange={set("recurrence")} options={["None", "Daily", "Weekly", "Monthly"]} allowEmpty={false} /></Field>
        {f.recurrence !== "None" && <Field label={`Every ${f.recur_interval} ${f.recurrence === "Daily" ? "day(s)" : f.recurrence === "Weekly" ? "week(s)" : "month(s)"}`}><input type="range" min="1" max="6" value={f.recur_interval} onChange={set("recur_interval")} /></Field>}
        <Field label={`Impact (${f.impact_score})`}><input type="range" min="1" max="5" value={f.impact_score} onChange={set("impact_score")} /></Field>
        <Field label={`Urgency (${f.urgency_score})`}><input type="range" min="1" max="5" value={f.urgency_score} onChange={set("urgency_score")} /></Field>
        <Field label="Related client"><RelSelect value={f.related_client} onChange={(v) => setV("related_client", v)} options={rel.clientOpts} /></Field>
        <Field label="Related lead"><RelSelect value={f.related_lead} onChange={(v) => setV("related_lead", v)} options={rel.leadOpts} /></Field>
        <Field label="Related project"><RelSelect value={f.related_project} onChange={(v) => setV("related_project", v)} options={rel.projectOpts} /></Field>
        <Field label="Related vision"><RelSelect value={f.related_vision} onChange={(v) => setV("related_vision", v)} options={rel.visionOpts} /></Field>
        <Field label="Blocker" span={2}><Text value={f.blocker} onChange={set("blocker")} placeholder="What's in the way?" /></Field>
        <Field label="Next step" span={2}><Text value={f.next_step} onChange={set("next_step")} /></Field>
        <Field label="Notes" span={2}><Area value={f.notes} onChange={set("notes")} /></Field>
      </FormGrid>
      <div style={{ marginTop: 10, fontSize: 12, color: C.mute }}>
        Calculated score: <b className="os-num" style={{ color: C.ink }}>{num(f.impact_score) * num(f.urgency_score)}</b> (impact × urgency)
      </div>
      <FormActions onCancel={onClose} onDelete={onDelete} submitLabel={initial?.id ? "Save task" : "Create task"} />
    </form>
  );
}

/* ----------------------------- PROJECT FORM ------------------------------ */
function ProjectForm({ initial, onSubmit, onClose, onDelete }) {
  const { settings } = useStore();
  const rel = useRel();
  const [f, set, setV] = useForm({
    name: "", description: "", owner: "CEO", status: "Planning", strategic_pillar: "", cadence: "Quarterly",
    start_date: "", target_finish_date: "", completed_date: "", progress_percent: 0, budget: "", revenue_potential: "",
    current_phase: "", next_milestone: "", risks: "", decision_needed: "", related_client: "", related_vision: "",
    tool: "", notes: "", ...initial,
  });
  const submit = (e) => { e.preventDefault(); if (!f.name.trim()) return; onSubmit(f); };
  return (
    <form onSubmit={submit}>
      <FormGrid>
        <Field label="Project name" span={2}><Text value={f.name} onChange={set("name")} autoFocus /></Field>
        <Field label="Status"><Select value={f.status} onChange={set("status")} options={PROJECT_STATUS} allowEmpty={false} /></Field>
        <Field label="Strategic pillar"><Select value={f.strategic_pillar} onChange={set("strategic_pillar")} options={settings.pillars} /></Field>
        <Field label="Cadence"><Select value={f.cadence} onChange={set("cadence")} options={["Monthly", "Quarterly", "Yearly"]} allowEmpty={false} /></Field>
        <Field label="Owner"><Select value={f.owner} onChange={set("owner")} options={settings.owners} /></Field>
        <Field label="Start date"><Text type="date" value={f.start_date} onChange={set("start_date")} /></Field>
        <Field label="Target finish"><Text type="date" value={f.target_finish_date} onChange={set("target_finish_date")} /></Field>
        <Field label={`Progress (${f.progress_percent}%)`} span={2}><input type="range" min="0" max="100" value={f.progress_percent} onChange={set("progress_percent")} /></Field>
        <Field label="Budget"><Text type="number" value={f.budget} onChange={set("budget")} placeholder="0" /></Field>
        <Field label="Revenue potential"><Text type="number" value={f.revenue_potential} onChange={set("revenue_potential")} placeholder="0" /></Field>
        <Field label="Current phase"><Text value={f.current_phase} onChange={set("current_phase")} /></Field>
        <Field label="Next milestone"><Text value={f.next_milestone} onChange={set("next_milestone")} /></Field>
        <Field label="Related client"><RelSelect value={f.related_client} onChange={(v) => setV("related_client", v)} options={rel.clientOpts} /></Field>
        <Field label="Related vision"><RelSelect value={f.related_vision} onChange={(v) => setV("related_vision", v)} options={rel.visionOpts} /></Field>
        <Field label="Tool"><Select value={f.tool} onChange={set("tool")} options={settings.tools} /></Field>
        <Field label="Decision needed"><Text value={f.decision_needed} onChange={set("decision_needed")} /></Field>
        <Field label="Risks" span={2}><Area value={f.risks} onChange={set("risks")} /></Field>
        <Field label="Notes" span={2}><Area value={f.notes} onChange={set("notes")} /></Field>
      </FormGrid>
      <FormActions onCancel={onClose} onDelete={onDelete} submitLabel={initial?.id ? "Save project" : "Create project"} />
    </form>
  );
}

/* ------------------------------ CLIENT FORM ------------------------------ */
function ClientForm({ initial, onSubmit, onClose, onDelete }) {
  const { settings } = useStore();
  const [f, set] = useForm({
    client_name: "", primary_contact_name: "", primary_contact_email: "", primary_contact_phone: "",
    company_website: "", crm_tool: "", pm_tool: "", account_owner: "CEO", client_status: "Green", health_score: 80,
    billing_type: "Retainer",
    monthly_retainer: "", ad_spend: "", management_fee_percent: "", service_line: "", reporting_cadence: "Monthly",
    setup_fee: "", one_time_bonus: "", one_time_bonus_note: "",
    project_value: "", project_paid: "", project_start: "", project_end: "", expected_monthly_on_convert: "", converted_to_retainer_date: "",
    next_client_touch: "", last_update: todayStr(), last_touch_date: todayStr(), open_deliverables_count: 0, blocked_items_count: 0,
    current_objective: "", renewal_date: "", communication_channel: "", notes: "",
    roas_target: "", spend_target: "", contract_start: "", bonus_threshold_roas: "", bonus_threshold_spend: "",
    next_steps: "", last_completed_summary: "", ...initial,
  });
  const submit = (e) => { e.preventDefault(); if (!f.client_name.trim()) return; onSubmit(f); };
  const rev = calc.recurringRevenue(f);
  const oneTime = calc.oneTimeRevenue(f);
  const projBal = calc.projectBalance(f);
  return (
    <form onSubmit={submit}>
      <FormGrid>
        <Field label="Client name" span={2}><Text value={f.client_name} onChange={set("client_name")} autoFocus /></Field>
        <Field label="Primary contact"><Text value={f.primary_contact_name} onChange={set("primary_contact_name")} /></Field>
        <Field label="Contact email"><Text type="email" value={f.primary_contact_email} onChange={set("primary_contact_email")} /></Field>
        <Field label="Contact phone"><Text value={f.primary_contact_phone} onChange={set("primary_contact_phone")} /></Field>
        <Field label="Website"><Text value={f.company_website} onChange={set("company_website")} placeholder="https://" /></Field>
        <Field label="Status"><Select value={f.client_status} onChange={set("client_status")} options={CLIENT_STATUS} allowEmpty={false} /></Field>
        <Field label={`Gut feel (${f.health_score})`}><input type="range" min="0" max="100" value={f.health_score} onChange={set("health_score")} /></Field>
        <Field label="Billing type" span={2}><Select value={f.billing_type} onChange={set("billing_type")} options={BILLING_TYPES} allowEmpty={false} /></Field>
        <FormSectionLabel>{f.billing_type === "Project" ? "Project billing" : "Recurring billing"}</FormSectionLabel>
        {f.billing_type !== "Project" && <>
          <Field label="Monthly retainer"><Text type="number" value={f.monthly_retainer} onChange={set("monthly_retainer")} placeholder="0" /></Field>
          <Field label="Mgmt fee %"><Text type="number" value={f.management_fee_percent} onChange={set("management_fee_percent")} placeholder="0" /></Field>
        </>}
        {(f.billing_type === "Project" || f.billing_type === "Hybrid") && <>
          <Field label="Total project value"><Text type="number" value={f.project_value} onChange={set("project_value")} placeholder="0" /></Field>
          <Field label="Amount paid"><Text type="number" value={f.project_paid} onChange={set("project_paid")} placeholder="0" /></Field>
          <Field label="Project start"><Text type="date" value={f.project_start} onChange={set("project_start")} /></Field>
          <Field label="Project end"><Text type="date" value={f.project_end} onChange={set("project_end")} /></Field>
          <Field label="Expected monthly on convert" span={2}><Text type="number" value={f.expected_monthly_on_convert} onChange={set("expected_monthly_on_convert")} placeholder="Projected retainer once they convert" /></Field>
        </>}
        <Field label="Ad spend / mo"><Text type="number" value={f.ad_spend} onChange={set("ad_spend")} placeholder="0" /></Field>
        <Field label="Service line"><Select value={f.service_line} onChange={set("service_line")} options={settings.serviceLines} /></Field>

        <FormSectionLabel>One-time fees & bonus pay (tracked separately from MRR)</FormSectionLabel>
        <Field label="Setup / onboarding fee"><Text type="number" value={f.setup_fee} onChange={set("setup_fee")} placeholder="0" /></Field>
        <Field label="One-time bonus pay"><Text type="number" value={f.one_time_bonus} onChange={set("one_time_bonus")} placeholder="0" /></Field>
        <Field label="Bonus / setup note" span={2}><Text value={f.one_time_bonus_note} onChange={set("one_time_bonus_note")} placeholder="What was this for? (e.g. launch bonus, build fee)" /></Field>

        <FormSectionLabel>Targets, reporting & schedule</FormSectionLabel>
        <Field label="ROAS target"><Text type="number" value={f.roas_target} onChange={set("roas_target")} placeholder="e.g. 3.0" /></Field>
        <Field label="Spend target / mo"><Text type="number" value={f.spend_target} onChange={set("spend_target")} placeholder="0" /></Field>
        <Field label="Reporting cadence"><Select value={f.reporting_cadence} onChange={set("reporting_cadence")} options={REPORTING} /></Field>
        <Field label="Account owner"><Select value={f.account_owner} onChange={set("account_owner")} options={settings.owners} /></Field>
        <Field label="Comms channel"><Text value={f.communication_channel} onChange={set("communication_channel")} placeholder="Slack / Email" /></Field>
        <Field label="Contract start"><Text type="date" value={f.contract_start} onChange={set("contract_start")} /></Field>
        <Field label="Renewal date"><Text type="date" value={f.renewal_date} onChange={set("renewal_date")} /></Field>
        <Field label="Next client touch"><Text type="date" value={f.next_client_touch} onChange={set("next_client_touch")} /></Field>
        <Field label="Last touch date"><Text type="date" value={f.last_touch_date} onChange={set("last_touch_date")} /></Field>

        <FormSectionLabel>Performance bonus thresholds</FormSectionLabel>
        <Field label="Bonus: ROAS ≥"><Text type="number" value={f.bonus_threshold_roas} onChange={set("bonus_threshold_roas")} placeholder="e.g. 3.0" /></Field>
        <Field label="Bonus: spend ≥"><Text type="number" value={f.bonus_threshold_spend} onChange={set("bonus_threshold_spend")} placeholder="e.g. 30000" /></Field>
        <Field label="Open deliverables"><Text type="number" value={f.open_deliverables_count} onChange={set("open_deliverables_count")} /></Field>
        <Field label="Blocked items"><Text type="number" value={f.blocked_items_count} onChange={set("blocked_items_count")} /></Field>
        <Field label="Current objective" span={2}><Text value={f.current_objective} onChange={set("current_objective")} /></Field>
        <Field label="Last completed work summary" span={2}><Area value={f.last_completed_summary} onChange={set("last_completed_summary")} placeholder="What was just delivered?" /></Field>
        <Field label="Next steps (to guide the client)" span={2}><Area value={f.next_steps} onChange={set("next_steps")} placeholder="What happens next, and what you'll tell them" /></Field>
        <Field label="Notes" span={2}><Area value={f.notes} onChange={set("notes")} /></Field>
      </FormGrid>
      <div style={{ marginTop: 10, fontSize: 12, color: C.mute, display: "flex", gap: 18, flexWrap: "wrap" }}>
        <span>Recurring (MRR): <b className="os-num" style={{ color: C.ink }}>{fmtMoney(rev)}</b>/mo</span>
        {oneTime > 0 && <span>One-time fees: <b className="os-num" style={{ color: C.ink }}>{fmtMoney(oneTime)}</b></span>}
        {(f.billing_type === "Project" || f.billing_type === "Hybrid") && num(f.project_value) > 0 &&
          <span>Project balance: <b className="os-num" style={{ color: C.ink }}>{fmtMoney(projBal)}</b> of {fmtMoney(f.project_value)}</span>}
        {f.converted_to_retainer_date && <span style={{ color: C.green }}>Converted to retainer {fmtDate(f.converted_to_retainer_date)}</span>}
      </div>
      <FormActions onCancel={onClose} onDelete={onDelete} submitLabel={initial?.id ? "Save client" : "Create client"} />
    </form>
  );
}

/* ------------------------------- LEAD FORM ------------------------------- */
function LeadForm({ initial, onSubmit, onClose, onDelete }) {
  const { settings } = useStore();
  const [f, set] = useForm({
    lead_name: "", company_name: "", contact_name: "", email: "", phone: "", website: "", source: "",
    lead_status: "New", deal_value: "", probability: 20, expected_close_date: "", owner: "CEO", priority: "Medium",
    service_interest: "", pain_point: "", next_step: "", next_follow_up_date: "", last_touch_date: todayStr(), notes: "",
    win_loss_reason: "", objection: "", competitor: "", ...initial,
  });
  const submit = (e) => { e.preventDefault(); if (!f.lead_name.trim()) return; onSubmit(f); };
  return (
    <form onSubmit={submit}>
      <FormGrid>
        <Field label="Lead name" span={2}><Text value={f.lead_name} onChange={set("lead_name")} autoFocus /></Field>
        <Field label="Company"><Text value={f.company_name} onChange={set("company_name")} /></Field>
        <Field label="Contact"><Text value={f.contact_name} onChange={set("contact_name")} /></Field>
        <Field label="Email"><Text type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Phone"><Text value={f.phone} onChange={set("phone")} /></Field>
        <Field label="Website"><Text value={f.website} onChange={set("website")} /></Field>
        <Field label="Source"><Text value={f.source} onChange={set("source")} placeholder="Referral / Inbound…" /></Field>
        <Field label="Stage"><Select value={f.lead_status} onChange={set("lead_status")} options={LEAD_STATUS} allowEmpty={false} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={set("priority")} options={settings.priorities} /></Field>
        <Field label="Deal value"><Text type="number" value={f.deal_value} onChange={set("deal_value")} placeholder="0" /></Field>
        <Field label={`Probability (${f.probability}%)`}><input type="range" min="0" max="100" step="5" value={f.probability} onChange={set("probability")} /></Field>
        <Field label="Service interest"><Select value={f.service_interest} onChange={set("service_interest")} options={settings.serviceLines} /></Field>
        <Field label="Owner"><Select value={f.owner} onChange={set("owner")} options={settings.owners} /></Field>
        <Field label="Expected close"><Text type="date" value={f.expected_close_date} onChange={set("expected_close_date")} /></Field>
        <Field label="Next follow-up"><Text type="date" value={f.next_follow_up_date} onChange={set("next_follow_up_date")} /></Field>
        <Field label="Last touch"><Text type="date" value={f.last_touch_date} onChange={set("last_touch_date")} /></Field>
        <Field label="Pain point" span={2}><Text value={f.pain_point} onChange={set("pain_point")} /></Field>
        <Field label="Next step" span={2}><Text value={f.next_step} onChange={set("next_step")} /></Field>
        {["Closed Won", "Closed Lost"].includes(f.lead_status) && <>
          <Field label="Win/loss reason" span={2}><Text value={f.win_loss_reason} onChange={set("win_loss_reason")} placeholder="Why did this close the way it did?" /></Field>
          <Field label="Top objection"><Text value={f.objection} onChange={set("objection")} placeholder="Price / timing / fit…" /></Field>
          <Field label="Lost to (competitor)"><Text value={f.competitor} onChange={set("competitor")} /></Field>
        </>}
        <Field label="Notes" span={2}><Area value={f.notes} onChange={set("notes")} /></Field>
      </FormGrid>
      <div style={{ marginTop: 10, fontSize: 12, color: C.mute }}>
        Weighted pipeline: <b className="os-num" style={{ color: C.ink }}>{fmtMoney(calc.weightedPipeline(f))}</b>
      </div>
      <FormActions onCancel={onClose} onDelete={onDelete} submitLabel={initial?.id ? "Save lead" : "Create lead"} />
    </form>
  );
}

/* ------------------------------- TEAM FORM ------------------------------- */
function TeamForm({ initial, onSubmit, onClose, onDelete }) {
  const rel = useRel();
  const [f, set, setV] = useForm({
    name: "", specialty: "", work_type: "Both", status: "Active",
    email: "", phone: "",
    pay_basis: "Per project", rate: "", related_clients: [], related_projects: [],
    current_work: "", notes: "", ...initial,
  });
  const submit = (e) => { e.preventDefault(); if (!f.name.trim()) return; onSubmit(f); };
  const toggle = (key, id) => setV(key, (f[key] || []).includes(id) ? f[key].filter((x) => x !== id) : [ ...(f[key] || []), id ]);
  return (
    <form onSubmit={submit}>
      <FormGrid>
        <Field label="Name"><Text value={f.name} onChange={set("name")} autoFocus /></Field>
        <Field label="Specialty"><Text value={f.specialty} onChange={set("specialty")} placeholder="Creative, Meta, Dev…" /></Field>
        <Field label="Works on"><Select value={f.work_type} onChange={set("work_type")} options={PARTNER_WORK} allowEmpty={false} /></Field>
        <Field label="Availability"><Select value={f.status} onChange={set("status")} options={PARTNER_STATUS} allowEmpty={false} /></Field>
        <Field label="Email"><Text type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Phone"><Text value={f.phone} onChange={set("phone")} /></Field>
        <Field label="Pay basis"><Select value={f.pay_basis} onChange={set("pay_basis")} options={PAY_BASIS} allowEmpty={false} /></Field>
        <Field label="Rate / amount"><Text value={f.rate} onChange={set("rate")} placeholder="$75/hr, $2,000/project, 20%…" /></Field>
        <Field label="Clients they're on" span={2}>
          <ChipPicker options={rel.clientOpts} selected={f.related_clients || []} onToggle={(id) => toggle("related_clients", id)} empty="No clients yet" />
        </Field>
        <Field label="Projects they're on" span={2}>
          <ChipPicker options={rel.projectOpts} selected={f.related_projects || []} onToggle={(id) => toggle("related_projects", id)} empty="No projects yet" />
        </Field>
        <Field label="What they're working on now" span={2}><Text value={f.current_work} onChange={set("current_work")} /></Field>
        <Field label="Notes" span={2}><Area value={f.notes} onChange={set("notes")} /></Field>
      </FormGrid>
      <FormActions onCancel={onClose} onDelete={onDelete} submitLabel={initial?.id ? "Save partner" : "Add partner"} />
    </form>
  );
}

/* multi-select chips for linking related records */
function ChipPicker({ options, selected, onToggle, empty }) {
  if (!options.length) return <div style={{ fontSize: 12.5, color: C.mute }}>{empty}</div>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {options.map((o) => {
        const on = selected.includes(o.id);
        return (
          <button type="button" key={o.id} onClick={() => onToggle(o.id)}
            style={{ border: `1px solid ${on ? C.ink : C.line}`, background: on ? C.ink : "#fff", color: on ? "#fff" : C.charcoal,
              borderRadius: 999, padding: "5px 11px", fontSize: 12.5, cursor: "pointer", fontWeight: 550 }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- JOURNAL FORM ------------------------------ */
function JournalForm({ initial, onSubmit, onClose, onDelete }) {
  const { settings } = useStore();
  const rel = useRel();
  const [f, set, setV] = useForm({
    entry_date: todayStr(), cadence: "Daily", title: "", category: "CEO Reflection", content: "",
    mood_score: 7, energy_score: 7, focus_score: 7, related_client: "", related_project: "", related_task: "",
    tags: "", ...initial,
  });
  const submit = (e) => { e.preventDefault(); if (!f.content.trim() && !f.title.trim()) return; onSubmit(f); };
  return (
    <form onSubmit={submit}>
      <FormGrid>
        <Field label="Title" span={2}><Text value={f.title} onChange={set("title")} autoFocus placeholder="Entry title (optional)" /></Field>
        <Field label="Date"><Text type="date" value={f.entry_date} onChange={set("entry_date")} /></Field>
        <Field label="Cadence"><Select value={f.cadence} onChange={set("cadence")} options={settings.cadences} allowEmpty={false} /></Field>
        <Field label="Category"><Select value={f.category} onChange={set("category")} options={JOURNAL_CATEGORIES} allowEmpty={false} /></Field>
        <Field label="Tags"><Text value={f.tags} onChange={set("tags")} placeholder="comma,separated" /></Field>
        <Field label="Entry" span={2}><Area style={{ ...inS, minHeight: 150 }} value={f.content} onChange={set("content")} placeholder="Write freely…" /></Field>
        <Field label={`Mood (${f.mood_score})`}><input type="range" min="1" max="10" value={f.mood_score} onChange={set("mood_score")} /></Field>
        <Field label={`Energy (${f.energy_score})`}><input type="range" min="1" max="10" value={f.energy_score} onChange={set("energy_score")} /></Field>
        <Field label={`Focus (${f.focus_score})`}><input type="range" min="1" max="10" value={f.focus_score} onChange={set("focus_score")} /></Field>
        <Field label="Related client"><RelSelect value={f.related_client} onChange={(v) => setV("related_client", v)} options={rel.clientOpts} /></Field>
        <Field label="Related project"><RelSelect value={f.related_project} onChange={(v) => setV("related_project", v)} options={rel.projectOpts} /></Field>
        <Field label="Related task"><RelSelect value={f.related_task} onChange={(v) => setV("related_task", v)} options={rel.taskOpts} /></Field>
      </FormGrid>
      <FormActions onCancel={onClose} onDelete={onDelete} submitLabel={initial?.id ? "Save entry" : "Save entry"} />
    </form>
  );
}

/* ------------------------------ VISION FORM ------------------------------ */
function VisionForm({ initial, onSubmit, onClose, onDelete }) {
  const { settings } = useStore();
  const [f, set] = useForm({
    title: "", description: "", vision_type: "Business", time_horizon: "3 Years", target_date: "",
    status: "Active", priority: "High", why_it_matters: "", success_definition: "", notes: "", ...initial,
  });
  const submit = (e) => { e.preventDefault(); if (!f.title.trim()) return; onSubmit(f); };
  return (
    <form onSubmit={submit}>
      <FormGrid>
        <Field label="Title" span={2}><Text value={f.title} onChange={set("title")} autoFocus /></Field>
        <Field label="Type"><Select value={f.vision_type} onChange={set("vision_type")} options={VISION_TYPES} allowEmpty={false} /></Field>
        <Field label="Time horizon"><Select value={f.time_horizon} onChange={set("time_horizon")} options={HORIZONS} allowEmpty={false} /></Field>
        <Field label="Status"><Select value={f.status} onChange={set("status")} options={["Active", "Archived", "Complete"]} allowEmpty={false} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={set("priority")} options={settings.priorities} /></Field>
        <Field label="Target date"><Text type="date" value={f.target_date} onChange={set("target_date")} /></Field>
        <Field label="Description" span={2}><Area value={f.description} onChange={set("description")} /></Field>
        <Field label="Why it matters" span={2}><Area value={f.why_it_matters} onChange={set("why_it_matters")} /></Field>
        <Field label="Success definition" span={2}><Area value={f.success_definition} onChange={set("success_definition")} /></Field>
      </FormGrid>
      <FormActions onCancel={onClose} onDelete={onDelete} submitLabel={initial?.id ? "Save vision" : "Create vision item"} />
    </form>
  );
}
/* ----------------------- derived selectors (hooks) ----------------------- */
const useDerived = () => {
  const { db, settings } = useStore();
  return useMemo(() => {
    const activeTasks = db.tasks.filter((t) => !["Done", "Killed"].includes(t.status));
    const radar = db.tasks
      .filter((t) => t.task_type === "Radar" && !["Done", "Killed"].includes(t.status))
      .sort((a, b) => calc.taskScore(b) - calc.taskScore(a));
    const actionItems = db.tasks
      .filter((t) => t.task_type === "Action Item" && !["Done", "Killed"].includes(t.status))
      .sort((a, b) => {
        const pr = settings.priorities.indexOf(b.priority) - settings.priorities.indexOf(a.priority);
        if (pr) return pr;
        return (a.due_date || "9999") < (b.due_date || "9999") ? -1 : 1;
      });
    const majorTasks = db.tasks
      .filter((t) => t.task_type === "Major Task" && !["Done", "Killed"].includes(t.status))
      .sort((a, b) => {
        const pr = settings.priorities.indexOf(b.priority) - settings.priorities.indexOf(a.priority);
        if (pr) return pr;
        return (a.due_date || "9999") < (b.due_date || "9999") ? -1 : 1;
      });
    const activeProjects = db.projects.filter((p) => !["Complete", "Killed"].includes(p.status));
    const majorProjects = [...activeProjects].sort((a, b) => {
      const rank = { "At Risk": 3, Active: 2, Planning: 1, "On Hold": 0 };
      const r = (rank[b.status] || 0) - (rank[a.status] || 0);
      if (r) return r;
      return num(b.revenue_potential) - num(a.revenue_potential);
    });
    const activeClients = db.clients.filter((c) => !["Offboarding", "Paused"].includes(c.client_status));
    const agencyRevenue = activeClients.reduce((s, c) => s + calc.recurringRevenue(c), 0);
    const openPipeline = db.leads.filter((l) => !["Closed Won", "Closed Lost"].includes(l.lead_status))
      .reduce((s, l) => s + num(l.deal_value), 0);
    const weightedPipeline = db.leads.filter((l) => !["Closed Won", "Closed Lost"].includes(l.lead_status))
      .reduce((s, l) => s + calc.weightedPipeline(l), 0);
    const clientHealth = (c) => { const h = calc.computedHealth(db, settings, c); return h == null ? num(c.health_score) : h; };
    const healthAvg = activeClients.length
      ? Math.round(activeClients.reduce((s, c) => s + clientHealth(c), 0) / activeClients.length) : null;
    const overdueFollowups = db.leads.filter(calc.followupOverdue);
    const overdueTouches = db.clients.filter(calc.touchOverdue);
    const overdueTasks = db.tasks.filter(calc.taskOverdue);
    const criticalOpen = db.tasks.filter((t) => t.priority === "Critical" && !["Done", "Killed"].includes(t.status));
    const blockedTasks = db.tasks.filter((t) => t.status === "Blocked");
    const redClients = db.clients.filter((c) => c.client_status === "Red");
    const atRiskClients = activeClients.filter((c) => c.client_status === "Red" || clientHealth(c) < 50);
    const staleKpiClients = activeClients.filter((c) => calc.kpiStale(db, settings, c));
    const utilAvg = null; // legacy field retained for compatibility
    const overloaded = db.team.filter((m) => m.status === "Busy");
    return {
      activeTasks, radar, actionItems, majorTasks, activeProjects, majorProjects, activeClients,
      agencyRevenue, openPipeline, weightedPipeline, healthAvg, overdueFollowups, overdueTouches,
      overdueTasks, criticalOpen, blockedTasks, redClients, atRiskClients, staleKpiClients, clientHealth, utilAvg, overloaded,
    };
  }, [db, settings]);
};

/* small list row used across dashboards */
function MiniItem({ left, title, sub, right, onClick }) {
  return (
    <div onClick={onClick} className={onClick ? "os-row" : ""} style={{ display: "flex", alignItems: "center", gap: 11,
      padding: "9px 4px", borderBottom: `1px solid ${C.line2}`, cursor: onClick ? "pointer" : "default" }}>
      {left}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: C.mute, marginTop: 1 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}
const RankDot = ({ n }) => (
  <span className="os-num" style={{ width: 20, height: 20, borderRadius: 6, background: C.ink, color: "#fff",
    fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center", flexShrink: 0 }}>{n}</span>
);

/* journal prompt blocks per cadence */
const PROMPTS = {
  Daily: ["What must get done today?", "What is the one thing that makes today a win?", "What am I avoiding?", "What needs to be delegated?", "What did I learn today?"],
  Weekly: ["What moved the business forward this week?", "What stalled?", "Which client needs CEO attention?", "Which sales opportunity needs pressure?", "What should be killed, delegated, or systemized?"],
  Monthly: ["What actually created revenue this month?", "What felt busy but did not create leverage?", "Which clients should be expanded, saved, paused, or cut?", "What offer or system needs improvement next month?", "What is the single biggest constraint?"],
  Quarterly: ["What strategic bet worked?", "What strategic bet failed?", "What must be doubled down on?", "What must be killed?", "What needs to be built before next quarter?"],
  Yearly: ["What business am I actually building?", "What did I prove this year?", "What did I tolerate too long?", "What should the agency become next year?", "What does the CEO role need to look like?"],
};

function PromptList({ cadence, onStart }) {
  return (
    <div>
      <ul style={{ margin: "0 0 12px", paddingLeft: 18, color: C.slate, fontSize: 13, lineHeight: 1.9 }}>
        {PROMPTS[cadence].map((p) => <li key={p}>{p}</li>)}
      </ul>
      <Btn variant="solid" size="sm" onClick={onStart}>Write {cadence.toLowerCase()} entry</Btn>
    </div>
  );
}

/* quick inline journal capture (used on Daily) */
function QuickJournal({ cadence = "Daily" }) {
  const { add } = useStore();
  const [open, setOpen] = useState(false);
  return open ? (
    <JournalForm initial={{ cadence }} onClose={() => setOpen(false)}
      onSubmit={(v) => { add("journal", v); setOpen(false); }} />
  ) : (
    <PromptList cadence={cadence} onStart={() => setOpen(true)} />
  );
}

/* row renderers reused on dashboards */
function TaskMini({ t, onClick, rank }) {
  const overdue = calc.taskOverdue(t);
  return (
    <MiniItem onClick={onClick} left={rank ? <RankDot n={rank} /> : <PrioBadge value={t.priority} />}
      title={t.title}
      sub={<span>{t.due_date ? <span style={{ color: overdue ? C.red : C.mute }}>Due {fmtDate(t.due_date)}{overdue ? " · overdue" : ""}</span> : "No due date"} · Score {calc.taskScore(t)}</span>}
      right={<StatusPill value={t.status} />} />
  );
}
/* =============================== DASHBOARDS ============================== */
const sectionGrid = (cols) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${cols >= 3 ? 240 : 300}px), 1fr))`, gap: 14 });

function useOpenTask() {
  const { go } = useNav();
  return (t) => go("tasks", t.id);
}

/* ---- CEO DASHBOARD ---- */
function CEOGreeting({ d, db }) {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  // One-line state of the business.
  const bits = [];
  if (d.activeClients.length) bits.push(`${d.activeClients.length} active client${d.activeClients.length === 1 ? "" : "s"}`);
  if (d.agencyRevenue) bits.push(`${fmtMoney(d.agencyRevenue)}/mo recurring`);
  const needs = d.criticalOpen.length + d.overdueTasks.length + d.overdueFollowups.length + d.overdueTouches.length;
  const line = bits.length
    ? `${bits.join(" · ")}${needs ? ` · ${needs} item${needs === 1 ? "" : "s"} need you` : " · you're all caught up"}`
    : "Let's set up your command center.";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
      <div>
        <div className="os-eyebrow" style={{ marginBottom: 4 }}>{today}</div>
        <h1 style={{ margin: 0, fontSize: "var(--fs-display)", letterSpacing: "-.022em" }}>{part}.</h1>
        <p style={{ margin: "6px 0 0", color: C.mute, fontSize: 13.5 }}>{line}</p>
      </div>
    </div>
  );
}

const SETUP_STEPS = [
  ["clients", "Add your first client", "Track retainers, projects, health & bonuses.", "clients"],
  ["leads", "Add a lead to your pipeline", "Start forecasting weighted revenue.", "leads"],
  ["tasks", "Capture a task or radar item", "Get your must-dos out of your head.", "tasks"],
  ["projects", "Define a major project", "The big rocks that define the quarter.", "projects"],
  ["vision", "Write your vision", "Anchor the work to where you're headed.", "vision"],
];

function GettingStarted({ db }) {
  const { go } = useNav();
  const done = (k) => (db[k] || []).length > 0;
  const completed = SETUP_STEPS.filter(([, , , k]) => done(k)).length;
  if (completed === SETUP_STEPS.length) return null; // fully set up — hide entirely
  const pct = Math.round((completed / SETUP_STEPS.length) * 100);
  return (
    <Card title="Getting started" sub={`${completed} of ${SETUP_STEPS.length} done — this card disappears once you're set up`}
      right={<div style={{ width: 90 }}><Progress value={pct} /></div>}>
      <div style={{ display: "grid", gap: 8 }}>
        {SETUP_STEPS.map(([id, title, hint, k]) => {
          const isDone = done(k);
          return (
            <div key={id} onClick={() => go(k)} className="os-row"
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 10px", borderRadius: 10, cursor: "pointer", border: `1px solid ${C.line2}`, opacity: isDone ? 0.6 : 1 }}>
              <div style={{ width: 22, height: 22, borderRadius: 99, flexShrink: 0, display: "grid", placeItems: "center",
                background: isDone ? C.green : "#fff", border: `1.5px solid ${isDone ? C.green : C.line}`, color: "#fff", fontSize: 13, fontWeight: 700 }}>
                {isDone ? "✓" : ""}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, textDecoration: isDone ? "line-through" : "none" }}>{title}</div>
                <div style={{ fontSize: 12, color: C.mute }}>{hint}</div>
              </div>
              {!isDone && <span style={{ color: C.blue, fontSize: 18, lineHeight: 1 }}>+</span>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CEODashboard() {
  const d = useDerived();
  const { db } = useStore();
  const { go } = useNav();
  const openTask = (t) => go("tasks", t.id);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <CEOGreeting d={d} db={db} />
      <GettingStarted db={db} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(165px,1fr))", gap: 12 }}>
        <KPI label="Recurring Revenue" value={fmtMoney(d.agencyRevenue)} sub="active clients / mo (MRR)" />
        <KPI label="Weighted Pipeline" value={fmtMoney(d.weightedPipeline)} sub={`${fmtMoney(d.openPipeline)} open`} />
        <KPI label="Active Clients" value={fmtNum(d.activeClients.length)} />
        <KPI label="Client Health Avg" value={d.healthAvg == null ? "—" : d.healthAvg} tone={d.healthAvg == null ? null : d.healthAvg >= 75 ? "green" : d.healthAvg >= 50 ? "yellow" : "red"} />
        <KPI label="Open Critical Tasks" value={fmtNum(d.criticalOpen.length)} tone={d.criticalOpen.length ? "red" : null} />
        <KPI label="Overdue Follow-Ups" value={fmtNum(d.overdueFollowups.length)} tone={d.overdueFollowups.length ? "yellow" : null} />
        <KPI label="Active Major Projects" value={fmtNum(d.activeProjects.length)} />
        <KPI label="Active Partners" value={fmtNum(db.team.filter((m) => m.status === "Active").length)} />
      </div>

      <div style={sectionGrid(3)}>
        <Card title="Top 3 Radar" sub="Highest impact × urgency" right={<Btn variant="link" size="sm" onClick={() => go("tasks")}>Open</Btn>}>
          {d.radar.length ? d.radar.slice(0, 3).map((t, i) => <TaskMini key={t.id} t={t} rank={i + 1} onClick={() => openTask(t)} />)
            : <Empty title="No radar items yet" hint="Flag what you must keep an eye on." />}
        </Card>
        <Card title="Top 3 Must-Complete" sub="Action items, due soonest" right={<Btn variant="link" size="sm" onClick={() => go("tasks")}>Open</Btn>}>
          {d.actionItems.length ? d.actionItems.slice(0, 3).map((t, i) => <TaskMini key={t.id} t={t} rank={i + 1} onClick={() => openTask(t)} />)
            : <Empty title="No action items yet" hint="Add the must-dos that move the needle." />}
        </Card>
        <Card title="Partners" right={<Btn variant="link" size="sm" onClick={() => go("team")}>Open</Btn>}>
          {db.team.length ? db.team.slice(0, 4).map((m) => (
            <MiniItem key={m.id} title={m.name} sub={m.specialty || m.work_type || "—"}
              right={<StatusPill value={m.status} />} />
          )) : <Empty title="No partners yet" hint="Add contractors who help on client & project work." />}
        </Card>
      </div>

      <div style={sectionGrid(2)}>
        <Card title="5 Major Tasks" right={<Btn variant="link" size="sm" onClick={() => go("tasks")}>Open</Btn>}>
          {d.majorTasks.length ? d.majorTasks.slice(0, 5).map((t) => <TaskMini key={t.id} t={t} onClick={() => openTask(t)} />)
            : <Empty title="No major tasks yet" hint="Promote the big rocks to Major Task." />}
        </Card>
        <Card title="3 Major Projects" right={<Btn variant="link" size="sm" onClick={() => go("projects")}>Open</Btn>}>
          {d.majorProjects.length ? d.majorProjects.slice(0, 3).map((p) => (
            <div key={p.id} className="os-row" onClick={() => go("projects", p.id)} style={{ padding: "9px 4px", borderBottom: `1px solid ${C.line2}`, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <StatusPill value={calc.projectAtRisk(p) ? "At Risk" : p.status} />
              </div>
              <Progress value={p.progress_percent} />
            </div>
          )) : <Empty title="No major projects yet" hint="Define the projects that define the quarter." />}
        </Card>
      </div>

      <div style={sectionGrid(2)}>
        <Card title="Client Health Snapshot" right={<Btn variant="link" size="sm" onClick={() => go("clients")}>Open</Btn>}>
          {d.activeClients.length ? (
            <div style={sectionGrid(2)}>
              <Stat label="Green" value={db.clients.filter((c) => c.client_status === "Green").length} tone="green" />
              <Stat label="Yellow / Red" value={db.clients.filter((c) => ["Yellow", "Red"].includes(c.client_status)).length} tone="yellow" />
              <Stat label="Overdue touches" value={d.overdueTouches.length} tone={d.overdueTouches.length ? "red" : null} />
              <Stat label="Blocked deliverables" value={db.clients.reduce((s, c) => s + num(c.blocked_items_count), 0)} />
            </div>
          ) : <Empty title="No clients yet" hint="Add your first client to track health." />}
        </Card>
        <Card title="CRM Sales Snapshot" right={<Btn variant="link" size="sm" onClick={() => go("leads")}>Open</Btn>}>
          {db.leads.length ? (
            <div style={sectionGrid(2)}>
              <Stat label="Open pipeline" value={fmtMoney(d.openPipeline)} />
              <Stat label="Weighted" value={fmtMoney(d.weightedPipeline)} tone="blue" />
              <Stat label="Follow-ups due today" value={db.leads.filter((l) => l.next_follow_up_date === todayStr()).length} />
              <Stat label="Overdue follow-ups" value={d.overdueFollowups.length} tone={d.overdueFollowups.length ? "yellow" : null} />
            </div>
          ) : <Empty title="No leads yet" hint="Add a lead to build the pipeline." />}
        </Card>
      </div>

      <div style={sectionGrid(2)}>
        <Card title="CEO Action Queue" sub="What needs you, now">
          <ActionQueue />
        </Card>
        <Card title="Recent Journal Notes" right={<Btn variant="link" size="sm" onClick={() => go("journal")}>Open</Btn>}>
          {db.journal.length ? db.journal.slice(0, 5).map((j) => (
            <MiniItem key={j.id} onClick={() => go("journal", j.id)} title={j.title || j.content.slice(0, 60) || "Untitled"}
              sub={`${fmtDate(j.entry_date)} · ${j.category}`} right={<Pill>{j.cadence}</Pill>} />
          )) : <Empty title="No journal entries yet" hint="Capture the first reflection." />}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const fg = tone ? { green: C.green, yellow: C.yellow, red: C.red, blue: C.blue }[tone] : C.ink;
  return (
    <div style={{ background: C.bg, borderRadius: 10, padding: "11px 13px" }}>
      <div style={{ fontSize: 11, color: C.mute, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div>
      <div className="os-num" style={{ fontSize: 20, fontWeight: 720, color: fg, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function ActionQueue() {
  const d = useDerived();
  const { go } = useNav();
  const items = [];
  d.overdueTasks.slice(0, 4).forEach((t) => items.push({ k: "t" + t.id, tone: "red", tag: "Overdue task", title: t.title, go: () => go("tasks", t.id) }));
  d.redClients.forEach((c) => items.push({ k: "c" + c.id, tone: "red", tag: "Red client", title: c.client_name, go: () => go("clients", c.id) }));
  d.overdueTouches.slice(0, 3).forEach((c) => items.push({ k: "ct" + c.id, tone: "yellow", tag: "Client touch due", title: c.client_name, go: () => go("clients", c.id) }));
  d.overdueFollowups.slice(0, 3).forEach((l) => items.push({ k: "l" + l.id, tone: "yellow", tag: "Follow-up overdue", title: l.lead_name, go: () => go("leads", l.id) }));
  d.overloaded.forEach((m) => items.push({ k: "m" + m.id, tone: "yellow", tag: "Partner busy", title: m.name, go: () => go("team") }));
  if (!items.length) return <Empty title="Queue is clear" hint="No overdue, blocked, or at-risk items." />;
  return items.slice(0, 8).map((i) => (
    <MiniItem key={i.k} onClick={i.go} left={<Pill tone={i.tone} dot>{i.tag}</Pill>} title={i.title} />
  ));
}

/* ---- DAILY ---- */
function DailyDashboard() {
  const d = useDerived();
  const { db } = useStore();
  const { go } = useNav();
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const todays = db.tasks.filter((t) => t.due_date === todayStr() && !["Done", "Killed"].includes(t.status));
  const followToday = db.leads.filter((l) => l.next_follow_up_date && l.next_follow_up_date <= todayStr() && !["Closed Won", "Closed Lost"].includes(l.lead_status));
  const touchToday = db.clients.filter((c) => c.next_client_touch && c.next_client_touch <= todayStr() && !["Offboarding", "Paused"].includes(c.client_status));
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title={today} sub="Execute the day">
        <FocusNote cadence="Daily" label="CEO focus for the day" />
      </Card>
      <CadenceCalendar scope="Daily" />
      <div style={sectionGrid(2)}>
        <Card title="Top 3 Radar">{d.radar.length ? d.radar.slice(0, 3).map((t, i) => <TaskMini key={t.id} t={t} rank={i + 1} onClick={() => go("tasks", t.id)} />) : <Empty title="No radar items yet" />}</Card>
        <Card title="Top 3 Must-Complete">{d.actionItems.length ? d.actionItems.slice(0, 3).map((t, i) => <TaskMini key={t.id} t={t} rank={i + 1} onClick={() => go("tasks", t.id)} />) : <Empty title="No action items yet" />}</Card>
      </div>
      <div style={sectionGrid(2)}>
        <Card title="Today's Tasks">{todays.length ? todays.map((t) => <TaskMini key={t.id} t={t} onClick={() => go("tasks", t.id)} />) : <Empty title="Nothing due today" hint="Set due dates to populate this." />}</Card>
        <Card title="Blocked Items">{d.blockedTasks.length ? d.blockedTasks.map((t) => <TaskMini key={t.id} t={t} onClick={() => go("tasks", t.id)} />) : <Empty title="No blocked items" />}</Card>
      </div>
      <div style={sectionGrid(2)}>
        <Card title="Follow-ups Due Today">{followToday.length ? followToday.map((l) => <MiniItem key={l.id} onClick={() => go("leads", l.id)} title={l.lead_name} sub={l.company_name} right={isOverdue(l.next_follow_up_date) ? <Pill tone="red">Overdue</Pill> : <Pill tone="blue">Today</Pill>} />) : <Empty title="No follow-ups due" />}</Card>
        <Card title="Client Touches Due Today">{touchToday.length ? touchToday.map((c) => <MiniItem key={c.id} onClick={() => go("clients", c.id)} title={c.client_name} sub={c.current_objective} right={isOverdue(c.next_client_touch) ? <Pill tone="red">Overdue</Pill> : <Pill tone="blue">Today</Pill>} />) : <Empty title="No client touches due" />}</Card>
      </div>
      <div style={sectionGrid(2)}>
        <Card title="Quick Journal" sub="Daily CEO prompts"><QuickJournal cadence="Daily" /></Card>
        <Card title="End-of-Day Review"><FocusNote cadence="DailyReview" label="What did you ship? What did you learn?" textarea /></Card>
      </div>
    </div>
  );
}

/* simple ephemeral focus note that writes to journal on save */
function FocusNote({ cadence, label, textarea }) {
  const { add } = useStore();
  const [v, setV] = useState("");
  const save = () => { if (!v.trim()) return; add("journal", { entry_date: todayStr(), cadence: cadence.replace("Review", ""), title: label, category: "CEO Reflection", content: v, mood_score: 7, energy_score: 7, focus_score: 7 }); setV(""); };
  return (
    <div>
      {textarea
        ? <Area value={v} onChange={(e) => setV(e.target.value)} placeholder={label} />
        : <Text value={v} onChange={(e) => setV(e.target.value)} placeholder={label} />}
      <div style={{ marginTop: 8 }}><Btn size="sm" variant="solid" onClick={save}>Save to journal</Btn></div>
    </div>
  );
}

/* ---- WEEKLY ---- */
function weekRange() {
  const now = new Date();
  const day = (now.getDay() + 6) % 7;
  const mon = new Date(now); mon.setDate(now.getDate() - day);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const f = (x) => x.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(mon)} – ${f(sun)}`;
}
function WeeklyDashboard() {
  const d = useDerived();
  const { db } = useStore();
  const { go } = useNav();
  const metrics = [
    ["Open blockers", d.blockedTasks.length], ["Completed tasks", db.tasks.filter((t) => t.status === "Done").length],
    ["Proposals sent", db.leads.filter((l) => l.lead_status === "Proposal Sent").length],
    ["Deals closed (won)", db.leads.filter((l) => l.lead_status === "Closed Won").length],
    ["New pipeline", fmtMoney(d.openPipeline)], ["Client saves", db.clients.filter((c) => c.client_status === "Green").length],
  ];
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title={`Weekly Sprint · ${weekRange()}`} sub="Manage the week"><FocusNote cadence="Weekly" label="Weekly objective" /></Card>
      <CadenceCalendar scope="Weekly" />
      <div style={sectionGrid(3)}>
        <Card title="Top 3 Radar">{d.radar.length ? d.radar.slice(0, 3).map((t, i) => <TaskMini key={t.id} t={t} rank={i + 1} onClick={() => go("tasks", t.id)} />) : <Empty title="No radar items" />}</Card>
        <Card title="Top 3 Must-Complete">{d.actionItems.length ? d.actionItems.slice(0, 3).map((t, i) => <TaskMini key={t.id} t={t} rank={i + 1} onClick={() => go("tasks", t.id)} />) : <Empty title="No action items" />}</Card>
        <Card title="5 Major Tasks">{d.majorTasks.length ? d.majorTasks.slice(0, 5).map((t) => <TaskMini key={t.id} t={t} onClick={() => go("tasks", t.id)} />) : <Empty title="No major tasks" />}</Card>
      </div>
      <div style={sectionGrid(2)}>
        <Card title="Sales Follow-Ups Due">{d.overdueFollowups.length ? d.overdueFollowups.map((l) => <MiniItem key={l.id} onClick={() => go("leads", l.id)} title={l.lead_name} sub={`Due ${fmtDate(l.next_follow_up_date)}`} right={<Pill tone="yellow">Overdue</Pill>} />) : <Empty title="No follow-ups overdue" />}</Card>
        <Card title="Client Management Priorities">{db.clients.filter((c) => ["Yellow", "Red"].includes(c.client_status)).length ? db.clients.filter((c) => ["Yellow", "Red"].includes(c.client_status)).map((c) => <MiniItem key={c.id} onClick={() => go("clients", c.id)} title={c.client_name} sub={c.current_objective} right={<StatusPill value={c.client_status} />} />) : <Empty title="All clients green" />}</Card>
      </div>
      <div style={sectionGrid(2)}>
        <Card title="Project Milestones">{d.activeProjects.length ? d.activeProjects.map((p) => <MiniItem key={p.id} onClick={() => go("projects", p.id)} title={p.name} sub={p.next_milestone || "No milestone set"} right={<Pill tone={statusTone(p.status)}>{num(p.progress_percent)}%</Pill>} />) : <Empty title="No active projects" />}</Card>
        <Card title="Partners">{db.team.length ? db.team.map((m) => <MiniItem key={m.id} title={m.name} sub={m.specialty || m.work_type} right={<StatusPill value={m.status} />} />) : <Empty title="No partners" />}</Card>
      </div>
      <Card title="Weekly Scorecard">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
          {metrics.map(([l, v]) => <Stat key={l} label={l} value={v} />)}
        </div>
      </Card>
      <Card title="Weekly Review Journal" sub="Weekly prompts"><QuickJournal cadence="Weekly" /></Card>
    </div>
  );
}
/* ---- MONTHLY ---- */
function MonthlyDashboard() {
  const d = useDerived();
  const { db, settings } = useStore();
  const { go } = useNav();
  const monthName = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const retainerRev = d.activeClients.reduce((s, c) => s + num(c.monthly_retainer), 0);
  const spendRev = d.activeClients.reduce((s, c) => s + num(c.ad_spend) * (num(c.management_fee_percent) / 100), 0);
  const closedWon = db.leads.filter((l) => l.lead_status === "Closed Won").reduce((s, l) => s + num(l.deal_value), 0);
  const closedLost = db.leads.filter((l) => l.lead_status === "Closed Lost").reduce((s, l) => s + num(l.deal_value), 0);
  const target = num(settings.revenueTargetMonthly);
  const attainment = target ? Math.round((d.agencyRevenue / target) * 100) : null;
  const metrics = [
    ["Total agency revenue", fmtMoney(d.agencyRevenue)], ["Retainer revenue", fmtMoney(retainerRev)],
    ["% of spend revenue", fmtMoney(spendRev)], ["Weighted pipeline", fmtMoney(d.weightedPipeline)],
    ["Closed won", fmtMoney(closedWon)], ["Closed lost", fmtMoney(closedLost)],
    ["Active clients", d.activeClients.length], ["Yellow / red clients", db.clients.filter((c) => ["Yellow", "Red"].includes(c.client_status)).length],
    ["Avg client health", d.healthAvg ?? "—"], ["Overdue client touches", d.overdueTouches.length],
    ["Completed tasks", db.tasks.filter((t) => t.status === "Done").length], ["Overdue tasks", d.overdueTasks.length],
  ];
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <CadenceCalendar scope="Monthly" />
      <div style={sectionGrid(3)}>
        <Card title={`Revenue · ${monthName}`}>
          <div className="os-num" style={{ fontSize: 30, fontWeight: 760 }}>{fmtMoney(d.agencyRevenue)}</div>
          <div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>Target {target ? fmtMoney(target) : "— set in Settings"}</div>
          {attainment != null && <div style={{ marginTop: 10 }}><Progress value={attainment} /></div>}
        </Card>
        <Card title="Pipeline Generated"><div className="os-num" style={{ fontSize: 30, fontWeight: 760 }}>{fmtMoney(d.openPipeline)}</div><div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>{fmtMoney(d.weightedPipeline)} weighted</div></Card>
        <Card title="Churn Risk"><div className="os-num" style={{ fontSize: 30, fontWeight: 760, color: d.redClients.length ? C.red : C.ink }}>{d.redClients.length}</div><div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>red clients · {db.clients.filter((c) => c.client_status === "Yellow").length} watch</div></Card>
      </div>
      <Card title="Monthly Metrics">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          {metrics.map(([l, v]) => <Stat key={l} label={l} value={v} />)}
        </div>
      </Card>
      <div style={sectionGrid(2)}>
        <Card title="Project Progress">{d.activeProjects.length ? d.activeProjects.map((p) => <div key={p.id} style={{ padding: "8px 0", borderBottom: `1px solid ${C.line2}` }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontWeight: 600 }}>{p.name}</span><StatusPill value={p.status} /></div><Progress value={p.progress_percent} /></div>) : <Empty title="No active projects" />}</Card>
        <Card title="Client Health Trend">{d.activeClients.length ? d.activeClients.map((c) => <MiniItem key={c.id} onClick={() => go("clients", c.id)} title={c.client_name} sub={`Health ${num(c.health_score)}`} right={<StatusPill value={c.client_status} />} />) : <Empty title="No clients yet" />}</Card>
      </div>
      <div style={sectionGrid(2)}>
        <Card title="Monthly Review Journal" sub="Monthly prompts"><QuickJournal cadence="Monthly" /></Card>
        <Card title="Next Month Focus"><FocusNote cadence="Monthly" label="What's the single biggest constraint to attack?" textarea /></Card>
      </div>
    </div>
  );
}

/* ---- QUARTERLY ---- */
function QuarterlyDashboard() {
  const d = useDerived();
  const { db, settings } = useStore();
  const { go } = useNav();
  const q = Math.floor(new Date().getMonth() / 3) + 1;
  const newClients = db.clients.filter((c) => (c.created_at || "").slice(0, 4) === String(new Date().getFullYear())).length;
  const avgProgress = d.activeProjects.length ? Math.round(d.activeProjects.reduce((s, p) => s + num(p.progress_percent), 0) / d.activeProjects.length) : null;
  const metrics = [
    ["Agency revenue", fmtMoney(d.agencyRevenue)], ["Open pipeline", fmtMoney(d.openPipeline)],
    ["New clients", newClients], ["Client churn", db.clients.filter((c) => c.client_status === "Offboarding").length],
    ["Major projects complete", db.projects.filter((p) => p.status === "Complete").length],
    ["Avg project progress", avgProgress == null ? "—" : avgProgress + "%"],
    ["Active partners", db.team.filter((m) => m.status === "Active").length],
  ];
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title={`Q${q} ${new Date().getFullYear()} · Strategic Execution`} sub="Quarterly theme"><FocusNote cadence="Quarterly" label="Quarterly theme" /></Card>
      <CadenceCalendar scope="Quarterly" />
      <div style={sectionGrid(2)}>
        <Card title="3 Major Projects" right={<Btn variant="link" size="sm" onClick={() => go("projects")}>Open</Btn>}>
          {d.majorProjects.length ? d.majorProjects.slice(0, 3).map((p) => (
            <div key={p.id} className="os-row" onClick={() => go("projects", p.id)} style={{ padding: "9px 4px", borderBottom: `1px solid ${C.line2}`, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <StatusPill value={calc.projectAtRisk(p) ? "At Risk" : p.status} />
              </div>
              <div style={{ fontSize: 11.5, color: C.mute, marginBottom: 6 }}>{p.strategic_pillar || "No pillar"} · {p.next_milestone || "No milestone"}</div>
              <Progress value={p.progress_percent} />
            </div>
          )) : <Empty title="No major projects yet" />}
        </Card>
        <Card title="Strategic Risks">
          {d.activeProjects.filter((p) => p.risks || calc.projectAtRisk(p)).length
            ? d.activeProjects.filter((p) => p.risks || calc.projectAtRisk(p)).map((p) => <MiniItem key={p.id} onClick={() => go("projects", p.id)} left={<Pill tone="red" dot>Risk</Pill>} title={p.name} sub={p.risks || "Flagged at risk"} />)
            : <Empty title="No flagged risks" />}
        </Card>
      </div>
      <Card title="Quarterly Metrics">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          {metrics.map(([l, v]) => <Stat key={l} label={l} value={v} />)}
        </div>
      </Card>
      <div style={sectionGrid(2)}>
        <Card title="Client Portfolio Quality">{d.activeClients.length ? <div style={sectionGrid(2)}><Stat label="Green" value={db.clients.filter((c) => c.client_status === "Green").length} tone="green" /><Stat label="At risk" value={db.clients.filter((c) => ["Yellow", "Red"].includes(c.client_status)).length} tone="yellow" /><Stat label="Avg health" value={d.healthAvg ?? "—"} /><Stat label="Avg revenue" value={fmtMoney(d.activeClients.length ? d.agencyRevenue / d.activeClients.length : 0)} /></div> : <Empty title="No clients yet" />}</Card>
        <Card title="Systems Built This Quarter">{db.projects.filter((p) => p.strategic_pillar === "Systems").length ? db.projects.filter((p) => p.strategic_pillar === "Systems").map((p) => <MiniItem key={p.id} onClick={() => go("projects", p.id)} title={p.name} sub={p.current_phase} right={<StatusPill value={p.status} />} />) : <Empty title="No systems projects yet" hint="Tag projects with the Systems pillar." />}</Card>
      </div>
      <Card title="Quarterly Review Journal" sub="Strategic prompts"><QuickJournal cadence="Quarterly" /></Card>
    </div>
  );
}

/* ---- YEARLY ---- */
function YearlyDashboard() {
  const d = useDerived();
  const { db, settings } = useStore();
  const { go } = useNav();
  const year = new Date().getFullYear();
  const activeVision = db.vision.filter((v) => v.status === "Active");
  const annualRev = d.agencyRevenue * 12;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title={`${year} · Vision & Operating Plan`} sub="Annual direction"><FocusNote cadence="Yearly" label="Yearly vision statement" textarea /></Card>
      <CadenceCalendar scope="Yearly" />
      <div style={sectionGrid(3)}>
        <Card title="Annual Revenue (run-rate)"><div className="os-num" style={{ fontSize: 28, fontWeight: 760 }}>{fmtMoney(annualRev)}</div><div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>from current monthly revenue</div></Card>
        <Card title="Annual Pipeline"><div className="os-num" style={{ fontSize: 28, fontWeight: 760 }}>{fmtMoney(d.openPipeline)}</div><div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>{fmtMoney(d.weightedPipeline)} weighted</div></Card>
        <Card title="Active Vision Items"><div className="os-num" style={{ fontSize: 28, fontWeight: 760 }}>{activeVision.length}</div><div style={{ fontSize: 12, color: C.mute, marginTop: 4 }}>across {new Set(activeVision.map((v) => v.vision_type)).size} domains</div></Card>
      </div>
      <div style={sectionGrid(2)}>
        <Card title="Active Vision Items" right={<Btn variant="link" size="sm" onClick={() => go("vision")}>Open</Btn>}>
          {activeVision.length ? activeVision.map((v) => <MiniItem key={v.id} onClick={() => go("vision", v.id)} left={<Pill tone="blue">{v.time_horizon}</Pill>} title={v.title} sub={v.vision_type} right={<PrioBadge value={v.priority} />} />) : <Empty title="No vision items yet" hint="Define the future state." action={<Btn size="sm" variant="solid" onClick={() => go("vision")}>Add vision item</Btn>} />}
        </Card>
        <Card title="3 Strategic Pillars" sub="Active projects by pillar">
          {(() => {
            const byPillar = {};
            d.activeProjects.forEach((p) => { const k = p.strategic_pillar || "Unassigned"; (byPillar[k] = byPillar[k] || []).push(p); });
            const keys = Object.keys(byPillar);
            return keys.length ? keys.slice(0, 5).map((k) => <MiniItem key={k} title={k} sub={`${byPillar[k].length} active project${byPillar[k].length > 1 ? "s" : ""}`} right={<Pill>{Math.round(byPillar[k].reduce((s, p) => s + num(p.progress_percent), 0) / byPillar[k].length)}%</Pill>} />) : <Empty title="No active projects yet" />;
          })()}
        </Card>
      </div>
      <div style={sectionGrid(2)}>
        <Card title="Client Portfolio Summary">{d.activeClients.length ? <div style={sectionGrid(2)}><Stat label="Active clients" value={d.activeClients.length} /><Stat label="Monthly revenue" value={fmtMoney(d.agencyRevenue)} /><Stat label="Avg health" value={d.healthAvg ?? "—"} /><Stat label="Annual run-rate" value={fmtMoney(annualRev)} /></div> : <Empty title="No clients yet" />}</Card>
        <Card title="Major Projects Summary">{db.projects.length ? <div style={sectionGrid(2)}><Stat label="Total" value={db.projects.length} /><Stat label="Active" value={d.activeProjects.length} tone="blue" /><Stat label="Complete" value={db.projects.filter((p) => p.status === "Complete").length} tone="green" /><Stat label="At risk" value={db.projects.filter((p) => calc.projectAtRisk(p)).length} tone="red" /></div> : <Empty title="No projects yet" />}</Card>
      </div>
      <Card title="Annual Reflection" sub="Yearly prompts"><QuickJournal cadence="Yearly" /></Card>
    </div>
  );
}
/* =============================== ENTITY PAGES ============================= */
/* detail drawer shell */
function Drawer({ open, onClose, title, children, onEdit }) {
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div onMouseDown={onClose} className="os-fadeup" style={{ position: "fixed", inset: 0, background: "rgba(10,10,11,.4)", backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)", zIndex: 55, display: "flex", justifyContent: "flex-end" }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ width: "min(540px,100%)", height: "100%", background: "#fff", overflow: "auto", boxShadow: "-12px 0 50px rgba(0,0,0,.22)", animation: "os-drawer-in .24s " + C.ease }}>
        <header style={{ position: "sticky", top: 0, background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: `1px solid ${C.line2}`, zIndex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, paddingRight: 12 }}>{title}</h2>
          <div style={{ display: "flex", gap: 8 }}>{onEdit && <Btn size="sm" onClick={onEdit}>Edit</Btn>}<button onClick={onClose} aria-label="Close" style={{ border: "none", background: C.chip, width: 30, height: 30, borderRadius: 8, fontSize: 17 }}>×</button></div>
        </header>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}
const Detail = ({ label, value }) => (
  <div style={{ padding: "9px 0", borderBottom: `1px solid ${C.line2}`, display: "flex", justifyContent: "space-between", gap: 16 }}>
    <span style={{ fontSize: 12, color: C.mute, fontWeight: 600 }}>{label}</span>
    <span style={{ fontSize: 13, textAlign: "right", color: C.charcoal }}>{value == null || value === "" ? "—" : value}</span>
  </div>
);
const Section = ({ title, children }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: C.mute, marginBottom: 6 }}>{title}</div>
    {children}
  </div>
);

function PageHead({ title, sub, actions }) {
  return (
    <div className="os-pagehead" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: "var(--fs-h1)", fontWeight: 700, letterSpacing: "var(--ls-tight)" }}>{title}</h1>
        {sub && <p style={{ margin: "4px 0 0", color: C.mute, fontSize: "var(--fs-body)", lineHeight: 1.4 }}>{sub}</p>}
      </div>
      <div className="os-pagehead-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>
    </div>
  );
}

/* ------------------------------ MASTER TASKS ----------------------------- */
function TasksPage({ focusId }) {
  const { db, add, update, remove, settings } = useStore();
  const rel = useRel();
  const [editing, setEditing] = useState(null); // task obj or {} for new
  const [view, setView] = useState("table");
  const [q, setQ] = useState("");
  const [fStatus, setFStatus] = useState(""); const [fPrio, setFPrio] = useState(""); const [fType, setFType] = useState(""); const [fCad, setFCad] = useState("");
  const [sort, setSort] = useState("score");
  const [detail, setDetail] = useState(null);
  useEffect(() => { if (focusId) { const t = db.tasks.find((x) => x.id === focusId); if (t) setDetail(t); } }, [focusId]); // eslint-disable-line

  const filtered = db.tasks.filter((t) => {
    if (q && !(`${t.title} ${t.notes} ${t.next_step}`.toLowerCase().includes(q.toLowerCase()))) return false;
    if (fStatus && t.status !== fStatus) return false;
    if (fPrio && t.priority !== fPrio) return false;
    if (fType && t.task_type !== fType) return false;
    if (fCad && t.cadence !== fCad) return false;
    return true;
  }).sort((a, b) => {
    if (sort === "score") return calc.taskScore(b) - calc.taskScore(a);
    if (sort === "due") return (a.due_date || "9999") < (b.due_date || "9999") ? -1 : 1;
    if (sort === "priority") return settings.priorities.indexOf(b.priority) - settings.priorities.indexOf(a.priority);
    if (sort === "status") return settings.statuses.indexOf(a.status) - settings.statuses.indexOf(b.status);
    return 0;
  });

  const cols = [
    { key: "title", label: "Task", render: (t) => <div><div style={{ fontWeight: 600 }}>{t.title}</div>{t.related_client && <div style={{ fontSize: 11.5, color: C.mute }}>{rel.clientName(t.related_client)}</div>}</div> },
    { key: "task_type", label: "Type", render: (t) => <Pill>{t.task_type}</Pill> },
    { key: "priority", label: "Priority", render: (t) => <PrioBadge value={t.priority} /> },
    { key: "status", label: "Status", render: (t) => <StatusPill value={t.status} /> },
    { key: "score", label: "Score", align: "right", render: (t) => <span className="os-num" style={{ fontWeight: 700 }}>{calc.taskScore(t)}</span> },
    { key: "due_date", label: "Due", render: (t) => <span style={{ color: calc.taskOverdue(t) ? C.red : C.charcoal }} className="os-num">{fmtDate(t.due_date)}</span> },
  ];

  const save = (v) => { editing.id ? update("tasks", editing.id, v) : add("tasks", v); setEditing(null); };
  const csvCols = [
    { key: "title", label: "Title" }, { key: "task_type", label: "Type" }, { key: "priority", label: "Priority" },
    { key: "status", label: "Status" }, { label: "Score", get: (t) => calc.taskScore(t) }, { key: "due_date", label: "Due" },
    { label: "Client", get: (t) => rel.clientName(t.related_client) || "" }, { key: "next_step", label: "Next step" },
  ];

  return (
    <div>
      <PageHead title="Master Tasks" sub="The core operating table"
        actions={<>
          <Btn onClick={() => exportCSV(filtered, csvCols, "tasks.csv")} title="Export CSV">Export</Btn>
          <Btn variant={view === "table" ? "subtle" : "ghost"} onClick={() => setView("table")}>Table</Btn>
          <Btn variant={view === "board" ? "subtle" : "ghost"} onClick={() => setView("board")}>Board</Btn>
          <Btn variant="solid" onClick={() => setEditing({})}>+ New task</Btn>
        </>} />

      {/* radar / action / major callouts */}
      <div style={sectionGrid(3)}>
        <Card title="Top 3 Radar" pad={10}>{(() => { const r = db.tasks.filter((t) => t.task_type === "Radar" && !["Done", "Killed"].includes(t.status)).sort((a, b) => calc.taskScore(b) - calc.taskScore(a)); return r.length ? r.slice(0, 3).map((t, i) => <TaskMini key={t.id} t={t} rank={i + 1} onClick={() => setDetail(t)} />) : <Empty title="No radar items" />; })()}</Card>
        <Card title="Top 3 Action Items" pad={10}>{(() => { const r = db.tasks.filter((t) => t.task_type === "Action Item" && !["Done", "Killed"].includes(t.status)); return r.length ? r.slice(0, 3).map((t, i) => <TaskMini key={t.id} t={t} rank={i + 1} onClick={() => setDetail(t)} />) : <Empty title="No action items" />; })()}</Card>
        <Card title="5 Major Tasks" pad={10}>{(() => { const r = db.tasks.filter((t) => t.task_type === "Major Task" && !["Done", "Killed"].includes(t.status)); return r.length ? r.slice(0, 5).map((t) => <TaskMini key={t.id} t={t} onClick={() => setDetail(t)} />) : <Empty title="No major tasks" />; })()}</Card>
      </div>

      <div style={{ height: 16 }} />
      <Card pad={14}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Search tasks…" />
          <MiniSelect value={fType} onChange={setFType} options={TASK_TYPES} label="All types" />
          <MiniSelect value={fStatus} onChange={setFStatus} options={settings.statuses} label="All statuses" />
          <MiniSelect value={fPrio} onChange={setFPrio} options={settings.priorities} label="All priorities" />
          <MiniSelect value={fCad} onChange={setFCad} options={settings.cadences} label="All cadences" />
          <MiniSelect value={sort} onChange={setSort} options={["score", "due", "priority", "status"]} label="Sort" />
        </Toolbar>
        {view === "table" ? (
          <Table cols={cols} rows={filtered} onRow={setDetail}
            empty={<Empty title="No tasks yet. Add your first task." action={<Btn variant="solid" size="sm" onClick={() => setEditing({})}>+ New task</Btn>} />} />
        ) : (
          <Board rows={filtered} statuses={settings.statuses} onCard={setDetail} onMove={(id, status) => update("tasks", id, { status })} />
        )}
      </Card>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit task" : "New task"} wide>
        {editing && <TaskForm initial={editing} onClose={() => setEditing(null)} onSubmit={save} onDelete={editing.id ? () => { remove("tasks", editing.id); setEditing(null); } : null} />}
      </Modal>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.title}
        onEdit={() => { setEditing(detail); setDetail(null); }}>
        {detail && <TaskDetail t={detail} />}
      </Drawer>
    </div>
  );
}

function TaskDetail({ t }) {
  const rel = useRel();
  const { update } = useStore();
  const { settings } = useStore();
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Pill>{t.task_type}</Pill><PrioBadge value={t.priority} /><StatusPill value={t.status} />
        {calc.taskOverdue(t) && <Pill tone="red" dot>Overdue</Pill>}
      </div>
      <Section title="Quick status">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {settings.statuses.map((s) => <Btn key={s} size="sm" variant={t.status === s ? "solid" : "ghost"} onClick={() => update("tasks", t.id, { status: s, ...(s === "Done" ? { completed_date: todayStr() } : {}) })}>{s}</Btn>)}
        </div>
      </Section>
      {t.description && <Section title="Description"><p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: C.slate }}>{t.description}</p></Section>}
      <Section title="Details">
        <Detail label="Impact × Urgency" value={`${t.impact_score} × ${t.urgency_score} = ${calc.taskScore(t)}`} />
        <Detail label="Cadence" value={t.cadence} />
        <Detail label="Owner" value={t.owner} />
        <Detail label="Tool" value={t.tool} />
        <Detail label="Start" value={fmtDate(t.start_date)} />
        <Detail label="Due" value={fmtDate(t.due_date)} />
        <Detail label="Completed" value={fmtDate(t.completed_date)} />
      </Section>
      <Section title="Connections">
        <Detail label="Client" value={rel.clientName(t.related_client)} />
        <Detail label="Lead" value={rel.leadName(t.related_lead)} />
        <Detail label="Project" value={rel.projectName(t.related_project)} />
      </Section>
      {(t.blocker || t.next_step) && <Section title="Execution">
        {t.blocker && <Detail label="Blocker" value={t.blocker} />}
        {t.next_step && <Detail label="Next step" value={t.next_step} />}
      </Section>}
      {t.notes && <Section title="Notes"><p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: C.slate, whiteSpace: "pre-wrap" }}>{t.notes}</p></Section>}
    </div>
  );
}

/* kanban board reused for tasks + leads */
function Board({ rows, statuses, onCard, onMove, getStatus = (r) => r.status, render }) {
  const [drag, setDrag] = useState(null);
  return (
    <div className="os-board" style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 6, scrollSnapType: "x proximity", WebkitOverflowScrolling: "touch" }}>
      {statuses.map((s) => {
        const items = rows.filter((r) => getStatus(r) === s);
        return (
          <div key={s} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag) { onMove(drag, s); setDrag(null); } }}
            style={{ flex: "0 0 250px", scrollSnapAlign: "start", background: C.bg, borderRadius: 12, padding: 10, minHeight: 120 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, padding: "0 2px" }}>
              <Pill tone={statusTone(s)} dot>{s}</Pill>
              <span className="os-num" style={{ fontSize: 12, color: C.mute, fontWeight: 600 }}>{items.length}</span>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {items.map((r) => (
                <div key={r.id} draggable onDragStart={() => setDrag(r.id)} onClick={() => onCard(r)}
                  style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, padding: 11, cursor: "pointer" }}>
                  {render ? render(r) : (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{r.title}</div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <PrioBadge value={r.priority} />
                        <span className="os-num" style={{ fontSize: 11.5, color: calc.taskOverdue(r) ? C.red : C.mute }}>{fmtDate(r.due_date)}</span>
                      </div>
                    </>
                  )}
                </div>
              ))}
              {!items.length && <div style={{ fontSize: 12, color: C.mute, textAlign: "center", padding: "14px 0" }}>—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ MAJOR PROJECTS --------------------------- */
function ProjectsPage({ focusId }) {
  const { db, add, update, remove } = useStore();
  const rel = useRel();
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [q, setQ] = useState(""); const [fStatus, setFStatus] = useState("");
  useEffect(() => { if (focusId) { const p = db.projects.find((x) => x.id === focusId); if (p) setDetail(p); } }, [focusId]); // eslint-disable-line

  const rows = db.projects.filter((p) => (!q || p.name.toLowerCase().includes(q.toLowerCase())) && (!fStatus || p.status === fStatus));
  const cols = [
    { key: "name", label: "Project", render: (p) => <div><div style={{ fontWeight: 600 }}>{p.name}</div>{p.related_client && <div style={{ fontSize: 11.5, color: C.mute }}>{rel.clientName(p.related_client)}</div>}</div> },
    { key: "strategic_pillar", label: "Pillar", render: (p) => p.strategic_pillar ? <Pill>{p.strategic_pillar}</Pill> : "—" },
    { key: "status", label: "Status", render: (p) => <StatusPill value={calc.projectAtRisk(p) ? "At Risk" : p.status} /> },
    { key: "progress", label: "Progress", w: 150, render: (p) => <Progress value={p.progress_percent} /> },
    { key: "target_finish_date", label: "Target", render: (p) => <span className="os-num">{fmtDate(p.target_finish_date)}</span> },
  ];
  const save = (v) => { editing.id ? update("projects", editing.id, v) : add("projects", v); setEditing(null); };
  return (
    <div>
      <PageHead title="Major Projects" sub="Strategic initiatives"
        actions={<><Btn onClick={() => exportCSV(rows, [{ key: "name", label: "Name" }, { key: "status", label: "Status" }, { key: "strategic_pillar", label: "Pillar" }, { key: "progress_percent", label: "Progress" }, { key: "target_finish_date", label: "Target" }], "projects.csv")}>Export</Btn><Btn variant="solid" onClick={() => setEditing({})}>+ New project</Btn></>} />
      <Card pad={14}>
        <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Search projects…" /><MiniSelect value={fStatus} onChange={setFStatus} options={PROJECT_STATUS} label="All statuses" /></Toolbar>
        <Table cols={cols} rows={rows} onRow={setDetail} empty={<Empty title="No projects yet. Add your first major project." action={<Btn variant="solid" size="sm" onClick={() => setEditing({})}>+ New project</Btn>} />} />
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit project" : "New project"} wide>
        {editing && <ProjectForm initial={editing} onClose={() => setEditing(null)} onSubmit={save} onDelete={editing.id ? () => { remove("projects", editing.id); setEditing(null); } : null} />}
      </Modal>
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.name} onEdit={() => { setEditing(detail); setDetail(null); }}>
        {detail && <ProjectDetail p={detail} onOpenTask={(t) => { setDetail(null); }} />}
      </Drawer>
    </div>
  );
}

function ProjectDetail({ p }) {
  const { db, update, settings } = useStore();
  const rel = useRel();
  const linkedTasks = db.tasks.filter((t) => t.related_project === p.id);
  const taskProgress = linkedTasks.length ? Math.round((linkedTasks.filter((t) => t.status === "Done").length / linkedTasks.length) * 100) : null;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <StatusPill value={calc.projectAtRisk(p) ? "At Risk" : p.status} />{p.strategic_pillar && <Pill>{p.strategic_pillar}</Pill>}<Pill tone="blue">{p.cadence}</Pill>
      </div>
      <Section title="Progress">
        <Progress value={p.progress_percent} />
        {taskProgress != null && <div style={{ fontSize: 12, color: C.mute, marginTop: 6 }}>Linked task completion: {taskProgress}% ({linkedTasks.filter((t) => t.status === "Done").length}/{linkedTasks.length})</div>}
      </Section>
      {p.description && <Section title="Description"><p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: C.slate }}>{p.description}</p></Section>}
      <Section title="Details">
        <Detail label="Owner" value={p.owner} /><Detail label="Client" value={rel.clientName(p.related_client)} />
        <Detail label="Current phase" value={p.current_phase} /><Detail label="Next milestone" value={p.next_milestone} />
        <Detail label="Start" value={fmtDate(p.start_date)} /><Detail label="Target finish" value={fmtDate(p.target_finish_date)} />
        <Detail label="Budget" value={fmtMoney(p.budget)} /><Detail label="Revenue potential" value={fmtMoney(p.revenue_potential)} />
        <Detail label="Decision needed" value={p.decision_needed} />
      </Section>
      {p.risks && <Section title="Risks"><p style={{ margin: 0, fontSize: 13, color: C.red, lineHeight: 1.6 }}>{p.risks}</p></Section>}
      <Section title={`Connected tasks (${linkedTasks.length})`}>
        {linkedTasks.length ? linkedTasks.map((t) => <MiniItem key={t.id} title={t.title} sub={`Due ${fmtDate(t.due_date)}`} right={<StatusPill value={t.status} />} />) : <div style={{ fontSize: 12.5, color: C.mute }}>No tasks linked. Set a task's Related project to this.</div>}
      </Section>
      {p.notes && <Section title="Notes"><p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: C.slate, whiteSpace: "pre-wrap" }}>{p.notes}</p></Section>}
    </div>
  );
}
/* -------------------------------- CRM LEADS ------------------------------ */
function LeadsPage({ focusId, initialView }) {
  const { db, add, update, remove } = useStore();
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [view, setView] = useState(initialView || "table");
  const [q, setQ] = useState(""); const [fStage, setFStage] = useState("");
  useEffect(() => { if (focusId) { const l = db.leads.find((x) => x.id === focusId); if (l) setDetail(l); } }, [focusId]); // eslint-disable-line

  const open = db.leads.filter((l) => !["Closed Won", "Closed Lost"].includes(l.lead_status));
  const totalOpen = open.reduce((s, l) => s + num(l.deal_value), 0);
  const weighted = open.reduce((s, l) => s + calc.weightedPipeline(l), 0);
  const won = db.leads.filter((l) => l.lead_status === "Closed Won").length;
  const lost = db.leads.filter((l) => l.lead_status === "Closed Lost").length;
  const closeRate = won + lost ? Math.round((won / (won + lost)) * 100) : null;

  const rows = db.leads.filter((l) => (!q || `${l.lead_name} ${l.company_name}`.toLowerCase().includes(q.toLowerCase())) && (!fStage || l.lead_status === fStage));
  const cols = [
    { key: "lead_name", label: "Lead", render: (l) => <div><div style={{ fontWeight: 600 }}>{l.lead_name}</div><div style={{ fontSize: 11.5, color: C.mute }}>{l.company_name}</div></div> },
    { key: "lead_status", label: "Stage", render: (l) => <StatusPill value={l.lead_status} /> },
    { key: "deal_value", label: "Deal", align: "right", render: (l) => <span className="os-num">{fmtMoney(l.deal_value)}</span> },
    { key: "probability", label: "Prob", align: "right", render: (l) => <span className="os-num">{num(l.probability)}%</span> },
    { key: "weighted", label: "Weighted", align: "right", render: (l) => <span className="os-num" style={{ fontWeight: 700 }}>{fmtMoney(calc.weightedPipeline(l))}</span> },
    { key: "next_follow_up_date", label: "Follow-up", render: (l) => <span className="os-num" style={{ color: calc.followupOverdue(l) ? C.red : C.charcoal }}>{fmtDate(l.next_follow_up_date)}</span> },
  ];
  const save = (v) => { editing.id ? update("leads", editing.id, v) : add("leads", v); setEditing(null); };
  return (
    <div>
      <PageHead title="CRM Leads" sub="Sales pipeline"
        actions={<><Btn onClick={() => exportCSV(rows, [{ key: "lead_name", label: "Lead" }, { key: "company_name", label: "Company" }, { key: "lead_status", label: "Stage" }, { key: "deal_value", label: "Deal" }, { key: "probability", label: "Prob" }, { label: "Weighted", get: (l) => Math.round(calc.weightedPipeline(l)) }, { key: "next_follow_up_date", label: "Follow-up" }], "leads.csv")}>Export</Btn>
          <Btn variant={view === "table" ? "subtle" : "ghost"} onClick={() => setView("table")}>Table</Btn>
          <Btn variant={view === "board" ? "subtle" : "ghost"} onClick={() => setView("board")}>Pipeline</Btn>
          <Btn variant="solid" onClick={() => setEditing({})}>+ New lead</Btn></>} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 16 }}>
        <KPI label="Open Pipeline" value={fmtMoney(totalOpen)} />
        <KPI label="Weighted Pipeline" value={fmtMoney(weighted)} tone="blue" />
        <KPI label="Follow-ups Due Today" value={db.leads.filter((l) => l.next_follow_up_date === todayStr()).length} />
        <KPI label="Overdue Follow-ups" value={open.filter(calc.followupOverdue).length} tone={open.filter(calc.followupOverdue).length ? "yellow" : null} />
        <KPI label="Close Rate" value={closeRate == null ? "—" : closeRate + "%"} sub={`${won}W · ${lost}L`} />
      </div>
      <Card pad={14}>
        <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Search leads…" /><MiniSelect value={fStage} onChange={setFStage} options={LEAD_STATUS} label="All stages" /></Toolbar>
        {view === "table"
          ? <Table cols={cols} rows={rows} onRow={setDetail} empty={<Empty title="No leads yet. Add your first lead." action={<Btn variant="solid" size="sm" onClick={() => setEditing({})}>+ New lead</Btn>} />} />
          : <Board rows={rows} statuses={LEAD_STATUS} onCard={setDetail} getStatus={(l) => l.lead_status} onMove={(id, status) => update("leads", id, { lead_status: status })}
              render={(l) => <><div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{l.lead_name}</div><div style={{ fontSize: 11.5, color: C.mute, marginBottom: 6 }}>{l.company_name}</div><div style={{ display: "flex", justifyContent: "space-between" }}><span className="os-num" style={{ fontSize: 12, fontWeight: 700 }}>{fmtMoney(l.deal_value)}</span><span className="os-num" style={{ fontSize: 11.5, color: C.mute }}>{num(l.probability)}%</span></div></>} />}
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit lead" : "New lead"} wide>
        {editing && <LeadForm initial={editing} onClose={() => setEditing(null)} onSubmit={save} onDelete={editing.id ? () => { remove("leads", editing.id); setEditing(null); } : null} />}
      </Modal>
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={detail?.lead_name} onEdit={() => { setEditing(detail); setDetail(null); }}>
        {detail && <LeadDetail l={detail} onConverted={() => setDetail(null)} />}
      </Drawer>
    </div>
  );
}

function LeadDetail({ l, onConverted }) {
  const { add, update, db } = useStore();
  const already = db.clients.some((c) => c.notes?.includes("Converted from lead: " + l.id));
  const convert = () => {
    add("clients", {
      client_name: l.company_name || l.lead_name, primary_contact_name: l.contact_name, primary_contact_email: l.email,
      primary_contact_phone: l.phone, company_website: l.website, account_owner: l.owner, client_status: "Green",
      health_score: 80, service_line: l.service_interest, reporting_cadence: "Monthly", current_objective: l.pain_point,
      last_update: todayStr(), notes: `Converted from lead: ${l.id}\n${l.notes || ""}`,
    });
    update("leads", l.id, { lead_status: "Closed Won" });
    onConverted();
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <StatusPill value={l.lead_status} /><PrioBadge value={l.priority} />{calc.followupOverdue(l) && <Pill tone="red" dot>Follow-up overdue</Pill>}
      </div>
      <Section title="Pipeline value">
        <div style={sectionGrid(2)}><Stat label="Deal value" value={fmtMoney(l.deal_value)} /><Stat label="Weighted" value={fmtMoney(calc.weightedPipeline(l))} tone="blue" /></div>
      </Section>
      <Section title="Contact">
        <Detail label="Company" value={l.company_name} /><Detail label="Contact" value={l.contact_name} />
        <Detail label="Email" value={l.email} /><Detail label="Phone" value={l.phone} /><Detail label="Source" value={l.source} />
      </Section>
      <Section title="Sales">
        <Detail label="Probability" value={num(l.probability) + "%"} /><Detail label="Service interest" value={l.service_interest} />
        <Detail label="Expected close" value={fmtDate(l.expected_close_date)} /><Detail label="Next follow-up" value={fmtDate(l.next_follow_up_date)} />
        <Detail label="Last touch" value={fmtDate(l.last_touch_date)} />
      </Section>
      {l.pain_point && <Section title="Pain point"><p style={{ margin: 0, fontSize: 13, color: C.slate }}>{l.pain_point}</p></Section>}
      {l.next_step && <Section title="Next step"><p style={{ margin: 0, fontSize: 13, color: C.slate }}>{l.next_step}</p></Section>}
      {l.notes && <Section title="Notes"><p style={{ margin: 0, fontSize: 13, color: C.slate, whiteSpace: "pre-wrap" }}>{l.notes}</p></Section>}
      <div style={{ marginTop: 8 }}>
        {already ? <Pill tone="green" dot>Converted to client</Pill>
          : <Btn variant="solid" onClick={convert}>Convert to client →</Btn>}
      </div>
    </div>
  );
}

/* --------------------------------- CLIENTS ------------------------------- */
function ClientsPage({ focusId }) {
  const { db, add, update, remove } = useStore();
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [q, setQ] = useState(""); const [fStatus, setFStatus] = useState("");
  useEffect(() => { if (focusId) { const c = db.clients.find((x) => x.id === focusId); if (c) setDetail(c); } }, [focusId]); // eslint-disable-line

  const active = db.clients.filter((c) => !["Offboarding", "Paused"].includes(c.client_status));
  const revenue = active.reduce((s, c) => s + calc.agencyRevenue(c), 0);
  const healthAvg = active.length ? Math.round(active.reduce((s, c) => s + num(c.health_score), 0) / active.length) : null;
  const upcomingRenewals = db.clients.filter((c) => c.renewal_date && daysUntil(c.renewal_date) != null && daysUntil(c.renewal_date) <= 60 && daysUntil(c.renewal_date) >= 0).length;

  const rows = db.clients.filter((c) => (!q || c.client_name.toLowerCase().includes(q.toLowerCase())) && (!fStatus || c.client_status === fStatus));
  const cols = [
    { key: "client_name", label: "Client", render: (c) => <div><div style={{ fontWeight: 600 }}>{c.client_name}</div><div style={{ fontSize: 11.5, color: C.mute }}>{c.primary_contact_name || "—"}</div></div> },
    { key: "client_status", label: "Status", render: (c) => <StatusPill value={c.client_status} /> },
    { key: "health_score", label: "Health", w: 140, render: (c) => <Progress value={c.health_score} /> },
    { key: "revenue", label: "Revenue/mo", align: "right", render: (c) => <span className="os-num" style={{ fontWeight: 700 }}>{fmtMoney(calc.agencyRevenue(c))}</span> },
    { key: "service_line", label: "Service", render: (c) => c.service_line ? <Pill>{c.service_line}</Pill> : "—" },
    { key: "next_client_touch", label: "Next touch", render: (c) => <span className="os-num" style={{ color: calc.touchOverdue(c) ? C.red : C.charcoal }}>{fmtDate(c.next_client_touch)}</span> },
  ];
  const save = (v) => { editing.id ? update("clients", editing.id, v) : add("clients", v); setEditing(null); };
  return (
    <div>
      <PageHead title="Clients" sub="Account health & revenue"
        actions={<><Btn onClick={() => exportCSV(rows, [{ key: "client_name", label: "Client" }, { key: "client_status", label: "Status" }, { key: "health_score", label: "Health" }, { label: "Revenue", get: (c) => Math.round(calc.agencyRevenue(c)) }, { key: "service_line", label: "Service" }, { key: "renewal_date", label: "Renewal" }], "clients.csv")}>Export</Btn><Btn variant="solid" onClick={() => setEditing({})}>+ New client</Btn></>} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 16 }}>
        <KPI label="Active Clients" value={active.length} />
        <KPI label="Monthly Revenue" value={fmtMoney(revenue)} />
        <KPI label="Avg Health" value={healthAvg ?? "—"} tone={healthAvg == null ? null : healthAvg >= 75 ? "green" : healthAvg >= 50 ? "yellow" : "red"} />
        <KPI label="Green Clients" value={db.clients.filter((c) => c.client_status === "Green").length} tone="green" />
        <KPI label="Yellow / Red" value={db.clients.filter((c) => ["Yellow", "Red"].includes(c.client_status)).length} tone="yellow" />
        <KPI label="Renewals ≤60d" value={upcomingRenewals} />
      </div>
      <Card pad={14}>
        <Toolbar><SearchInput value={q} onChange={setQ} placeholder="Search clients…" /><MiniSelect value={fStatus} onChange={setFStatus} options={CLIENT_STATUS} label="All statuses" /></Toolbar>
        <Table cols={cols} rows={rows} onRow={setDetail} empty={<Empty title="No clients yet. Add your first client." action={<Btn variant="solid" size="sm" onClick={() => setEditing({})}>+ New client</Btn>} />} />
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit client" : "New client"} wide>
        {editing && <ClientForm initial={editing} onClose={() => setEditing(null)} onSubmit={save} onDelete={editing.id ? () => { remove("clients", editing.id); setEditing(null); } : null} />}
      </Modal>
      {detail && <ClientWorkspace clientId={detail.id} onClose={() => setDetail(null)} onEdit={() => { setEditing(detail); setDetail(null); }} />}
    </div>
  );
}

function ClientDetail({ c }) {
  const { db } = useStore();
  const tasks = db.tasks.filter((t) => t.related_client === c.id);
  const projects = db.projects.filter((p) => p.related_client === c.id);
  const journal = db.journal.filter((j) => j.related_client === c.id);
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <StatusPill value={c.client_status} />{c.billing_type && <Pill tone={c.billing_type === "Project" ? "blue" : c.billing_type === "Hybrid" ? "yellow" : "slate"}>{c.billing_type}</Pill>}{c.service_line && <Pill>{c.service_line}</Pill>}{c.converted_to_retainer_date && <Pill tone="green" dot>Converted</Pill>}{calc.touchOverdue(c) && <Pill tone="red" dot>Touch overdue</Pill>}
      </div>
      <Section title="Health & revenue">
        <Progress value={c.health_score} />
        <div style={{ ...sectionGrid(2), marginTop: 10 }}>
          <Stat label="Recurring / mo" value={fmtMoney(calc.recurringRevenue(c))} />
          <Stat label="Ad spend" value={fmtMoney(c.ad_spend)} />
        </div>
      </Section>
      <Section title="Billing">
        <div style={sectionGrid(2)}>
          <Detail label="Billing type" value={c.billing_type || "Retainer"} />
          <Detail label="Recurring / mo" value={fmtMoney(calc.recurringRevenue(c))} />
          {(c.billing_type === "Project" || c.billing_type === "Hybrid") && <>
            <Detail label="Project value" value={fmtMoney(c.project_value)} />
            <Detail label="Paid" value={fmtMoney(c.project_paid)} />
            <Detail label="Balance due" value={fmtMoney(calc.projectBalance(c))} />
            <Detail label="Expected on convert" value={fmtMoney(c.expected_monthly_on_convert)} />
            <Detail label="Project start" value={fmtDate(c.project_start)} />
            <Detail label="Project end" value={fmtDate(c.project_end)} />
          </>}
          <Detail label="Setup fee" value={fmtMoney(c.setup_fee)} />
          <Detail label="One-time bonus" value={fmtMoney(c.one_time_bonus)} />
          {c.one_time_bonus_note && <Detail label="Bonus note" value={c.one_time_bonus_note} />}
          {c.converted_to_retainer_date && <Detail label="Converted to retainer" value={fmtDate(c.converted_to_retainer_date)} />}
        </div>
      </Section>
      <Section title="Account">
        <Detail label="Contact" value={c.primary_contact_name} /><Detail label="Email" value={c.primary_contact_email} />
        <Detail label="Phone" value={c.primary_contact_phone} /><Detail label="Website" value={c.company_website} />
        <Detail label="Retainer" value={fmtMoney(c.monthly_retainer)} /><Detail label="Mgmt fee" value={c.management_fee_percent ? num(c.management_fee_percent) + "%" : "—"} />
        <Detail label="Reporting" value={c.reporting_cadence} /><Detail label="Comms" value={c.communication_channel} />
        <Detail label="CRM tool" value={c.crm_tool} /><Detail label="PM tool" value={c.pm_tool} />
        <Detail label="Next touch" value={fmtDate(c.next_client_touch)} /><Detail label="Renewal" value={fmtDate(c.renewal_date)} />
        <Detail label="Open deliverables" value={c.open_deliverables_count} /><Detail label="Blocked items" value={c.blocked_items_count} />
      </Section>
      {c.current_objective && <Section title="Current objective"><p style={{ margin: 0, fontSize: 13, color: C.slate }}>{c.current_objective}</p></Section>}
      <Section title={`Linked tasks (${tasks.length})`}>{tasks.length ? tasks.map((t) => <MiniItem key={t.id} title={t.title} right={<StatusPill value={t.status} />} />) : <div style={{ fontSize: 12.5, color: C.mute }}>None linked.</div>}</Section>
      <Section title={`Linked projects (${projects.length})`}>{projects.length ? projects.map((p) => <MiniItem key={p.id} title={p.name} right={<StatusPill value={p.status} />} />) : <div style={{ fontSize: 12.5, color: C.mute }}>None linked.</div>}</Section>
      {journal.length > 0 && <Section title={`Journal mentions (${journal.length})`}>{journal.map((j) => <MiniItem key={j.id} title={j.title || j.content.slice(0, 50)} sub={fmtDate(j.entry_date)} />)}</Section>}
      {c.notes && <Section title="Notes"><p style={{ margin: 0, fontSize: 13, color: C.slate, whiteSpace: "pre-wrap" }}>{c.notes}</p></Section>}
    </div>
  );
}

/* --------------------------- PROJECT MANAGEMENT -------------------------- */
function PMPage() {
  const { db, update, settings } = useStore();
  const { go } = useNav();
  const [groupBy, setGroupBy] = useState("project");
  const [view, setView] = useState("group");
  const rel = useRel();
  const completion = db.tasks.length ? Math.round((db.tasks.filter((t) => t.status === "Done").length / db.tasks.length) * 100) : null;
  const groups = useMemo(() => {
    const g = {};
    db.tasks.forEach((t) => {
      const key = groupBy === "project" ? (rel.projectName(t.related_project) || "Unassigned project") : (rel.clientName(t.related_client) || "Unassigned client");
      (g[key] = g[key] || []).push(t);
    });
    return g;
  }, [db.tasks, groupBy]); // eslint-disable-line
  return (
    <div>
      <PageHead title="Project Management" sub="Tasks across projects & clients"
        actions={<><Btn variant={view === "group" ? "subtle" : "ghost"} onClick={() => setView("group")}>Grouped</Btn><Btn variant={view === "board" ? "subtle" : "ghost"} onClick={() => setView("board")}>Board</Btn></>} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 16 }}>
        <KPI label="Total Tasks" value={db.tasks.length} />
        <KPI label="Completed" value={db.tasks.filter((t) => t.status === "Done").length} tone="green" />
        <KPI label="Blocked" value={db.tasks.filter((t) => t.status === "Blocked").length} tone={db.tasks.filter((t) => t.status === "Blocked").length ? "red" : null} />
        <KPI label="Completion" value={completion == null ? "—" : completion + "%"} />
      </div>
      {view === "board" ? (
        <Card pad={14}><Board rows={db.tasks} statuses={settings.statuses} onCard={(t) => go("tasks", t.id)} onMove={(id, status) => update("tasks", id, { status })} /></Card>
      ) : (
        <>
          <Toolbar><MiniSelect value={groupBy} onChange={setGroupBy} options={["project", "client"]} label="Group by" /></Toolbar>
          {Object.keys(groups).length ? Object.entries(groups).map(([name, items]) => (
            <Card key={name} title={name} sub={`${items.length} task${items.length > 1 ? "s" : ""} · ${items.filter((t) => t.status === "Done").length} done`} style={{ marginBottom: 14 }} pad={10}>
              {items.map((t) => (
                <MiniItem key={t.id} onClick={() => go("tasks", t.id)} left={<PrioBadge value={t.priority} />} title={t.title}
                  sub={<span>{t.owner || "—"} · {t.tool || "no tool"}{t.blocker ? ` · blocked: ${t.blocker}` : ""}</span>}
                  right={<span style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="os-num" style={{ fontSize: 11.5, color: calc.taskOverdue(t) ? C.red : C.mute }}>{fmtDate(t.due_date)}</span><StatusPill value={t.status} /></span>} />
              ))}
            </Card>
          )) : <Card><Empty title="No tasks yet. Add tasks in Master Tasks." action={<Btn variant="solid" size="sm" onClick={() => go("tasks")}>Go to tasks</Btn>} /></Card>}
        </>
      )}
    </div>
  );
}

/* ----------------------------- TEAM CAPACITY ----------------------------- */
function TeamPage() {
  const { db, add, update, remove } = useStore();
  const rel = useRel();
  const [editing, setEditing] = useState(null);
  const partners = db.team;
  const countLinks = (m) => (m.related_clients || []).length + (m.related_projects || []).length;
  const cols = [
    { key: "name", label: "Partner", render: (m) => <div><div style={{ fontWeight: 600 }}>{m.name}</div><div style={{ fontSize: 11.5, color: C.mute }}>{m.specialty || "—"}</div></div> },
    { key: "work_type", label: "Works on", render: (m) => <Pill tone="blue">{m.work_type || "—"}</Pill> },
    { key: "status", label: "Availability", render: (m) => <StatusPill value={m.status} /> },
    { key: "pay", label: "Pay", render: (m) => <span style={{ fontSize: 12.5 }}>{m.pay_basis}{m.rate ? ` · ${m.rate}` : ""}</span> },
    { key: "links", label: "On", align: "right", render: (m) => <span className="os-num">{countLinks(m) || "—"}</span> },
    { key: "current_work", label: "Current work", render: (m) => m.current_work || "—" },
  ];
  const save = (v) => { editing.id ? update("team", editing.id, v) : add("team", v); setEditing(null); };
  const byStatus = (st) => partners.filter((m) => m.status === st).length;
  return (
    <div>
      <PageHead title="Partners & Contractors" sub="The people who help on your projects and client work"
        actions={<><Btn onClick={() => exportCSV(partners, [{ key: "name", label: "Name" }, { key: "specialty", label: "Specialty" }, { key: "work_type", label: "Works on" }, { key: "status", label: "Status" }, { key: "pay_basis", label: "Pay basis" }, { key: "rate", label: "Rate" }], "partners.csv")}>Export</Btn><Btn variant="solid" onClick={() => setEditing({})}>+ Add partner</Btn></>} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 16 }}>
        <KPI label="Partners" value={partners.length} />
        <KPI label="Active" value={byStatus("Active")} tone="green" />
        <KPI label="Available" value={byStatus("Available")} tone="blue" />
        <KPI label="Busy" value={byStatus("Busy")} tone={byStatus("Busy") ? "yellow" : null} />
      </div>
      <Card pad={14}>
        <Table cols={cols} rows={partners} onRow={setEditing} empty={<Empty title="No partners yet" hint="Add the contractors and partners who help on client and project work." action={<Btn variant="solid" size="sm" onClick={() => setEditing({})}>+ Add partner</Btn>} />} />
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit partner" : "Add partner"} wide>
        {editing && <TeamForm initial={editing} onClose={() => setEditing(null)} onSubmit={save} onDelete={editing.id ? () => { remove("team", editing.id); setEditing(null); } : null} />}
      </Modal>
    </div>
  );
}
/* --------------------------------- JOURNAL ------------------------------- */
function JournalPage({ focusId }) {
  const { db, add, update, remove } = useStore();
  const rel = useRel();
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState(""); const [fCad, setFCad] = useState(""); const [fCat, setFCat] = useState("");
  useEffect(() => { if (focusId) { const j = db.journal.find((x) => x.id === focusId); if (j) setEditing(j); } }, [focusId]); // eslint-disable-line
  const rows = db.journal.filter((j) =>
    (!q || `${j.title} ${j.content} ${j.tags}`.toLowerCase().includes(q.toLowerCase())) &&
    (!fCad || j.cadence === fCad) && (!fCat || j.category === fCat));
  const save = (v) => { editing.id ? update("journal", editing.id, v) : add("journal", v); setEditing(null); };
  return (
    <div>
      <PageHead title="Journal" sub="CEO reflection across cadences"
        actions={<Btn variant="solid" onClick={() => setEditing({})}>+ New entry</Btn>} />
      <Card pad={14} style={{ marginBottom: 14 }}>
        <Toolbar>
          <SearchInput value={q} onChange={setQ} placeholder="Search entries, tags…" />
          <MiniSelect value={fCad} onChange={setFCad} options={["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"]} label="All cadences" />
          <MiniSelect value={fCat} onChange={setFCat} options={JOURNAL_CATEGORIES} label="All categories" />
        </Toolbar>
        {rows.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((j) => (
              <div key={j.id} className="os-row" onClick={() => setEditing(j)} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                    <Pill tone="blue">{j.cadence}</Pill><Pill>{j.category}</Pill>
                    <span className="os-num" style={{ fontSize: 12, color: C.mute }}>{fmtDate(j.entry_date)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 12, fontSize: 11.5, color: C.mute }}>
                    <span>M {j.mood_score}</span><span>E {j.energy_score}</span><span>F {j.focus_score}</span>
                  </div>
                </div>
                {j.title && <div style={{ fontWeight: 700, marginBottom: 3 }}>{j.title}</div>}
                <div style={{ fontSize: 13, color: C.slate, lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{j.content}</div>
                {(j.related_client || j.related_project) && <div style={{ marginTop: 8, fontSize: 11.5, color: C.mute }}>{[rel.clientName(j.related_client), rel.projectName(j.related_project)].filter(Boolean).join(" · ")}</div>}
              </div>
            ))}
          </div>
        ) : <Empty title="No journal entries yet. Start today's entry." action={<Btn variant="solid" size="sm" onClick={() => setEditing({})}>+ New entry</Btn>} />}
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit entry" : "New journal entry"} wide>
        {editing && <JournalForm initial={editing} onClose={() => setEditing(null)} onSubmit={save} onDelete={editing.id ? () => { remove("journal", editing.id); setEditing(null); } : null} />}
      </Modal>
    </div>
  );
}

/* --------------------------------- VISION -------------------------------- */
function VisionPage({ focusId }) {
  const { db, add, update, remove } = useStore();
  const [editing, setEditing] = useState(null);
  const [fType, setFType] = useState(""); const [fStatus, setFStatus] = useState("Active");
  useEffect(() => { if (focusId) { const v = db.vision.find((x) => x.id === focusId); if (v) setEditing(v); } }, [focusId]); // eslint-disable-line
  const rows = db.vision.filter((v) => (!fType || v.vision_type === fType) && (!fStatus || v.status === fStatus));
  const save = (v) => { editing.id ? update("vision", editing.id, v) : add("vision", v); setEditing(null); };
  return (
    <div>
      <PageHead title="Vision" sub="Where the agency is going"
        actions={<Btn variant="solid" onClick={() => setEditing({})}>+ New vision item</Btn>} />
      <Toolbar>
        <MiniSelect value={fType} onChange={setFType} options={VISION_TYPES} label="All types" />
        <MiniSelect value={fStatus} onChange={setFStatus} options={["Active", "Archived", "Complete"]} label="All statuses" />
      </Toolbar>
      {rows.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 14 }}>
          {rows.map((v) => {
            const linkedP = db.projects.filter((p) => p.related_vision === v.id).length;
            const linkedT = db.tasks.filter((t) => t.related_vision === v.id).length;
            return (
              <div key={v.id} className="os-row" onClick={() => setEditing(v)} style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, cursor: "pointer" }}>
                <div style={{ display: "flex", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
                  <Pill tone="blue">{v.time_horizon}</Pill><Pill>{v.vision_type}</Pill><PrioBadge value={v.priority} />
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{v.title}</div>
                {v.description && <p style={{ margin: "0 0 10px", fontSize: 13, color: C.slate, lineHeight: 1.5 }}>{v.description}</p>}
                {v.success_definition && <div style={{ fontSize: 12, color: C.mute, marginBottom: 8 }}><b style={{ color: C.slate }}>Success:</b> {v.success_definition}</div>}
                <div style={{ display: "flex", gap: 12, fontSize: 11.5, color: C.mute, borderTop: `1px solid ${C.line2}`, paddingTop: 10 }}>
                  <span>{linkedP} project{linkedP !== 1 ? "s" : ""}</span><span>{linkedT} task{linkedT !== 1 ? "s" : ""}</span>
                  <span style={{ marginLeft: "auto" }}>{v.target_date ? fmtDate(v.target_date) : "—"}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : <Card><Empty title="No vision items yet. Define the future state." action={<Btn variant="solid" size="sm" onClick={() => setEditing({})}>+ New vision item</Btn>} /></Card>}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit vision item" : "New vision item"} wide>
        {editing && <VisionForm initial={editing} onClose={() => setEditing(null)} onSubmit={save} onDelete={editing.id ? () => { remove("vision", editing.id); setEditing(null); } : null} />}
      </Modal>
    </div>
  );
}

/* -------------------------------- SETTINGS ------------------------------- */
function SettingsPage() {
  const { settings, setSettings, db } = useStore();
  const lists = [
    ["statuses", "Task statuses"], ["priorities", "Priorities"], ["cadences", "Cadences"],
    ["tools", "Tools"], ["serviceLines", "Service lines"], ["owners", "Owners / team"], ["pillars", "Strategic pillars"],
  ];
  const editList = (key, arr) => setSettings((s) => ({ ...s, [key]: arr }));
  return (
    <div>
      <PageHead title="Settings" sub="Configure the operating system" />
      <Card title="Targets" style={{ marginBottom: 14 }}>
        <FormGrid>
          <Field label="Monthly revenue target"><Text type="number" value={settings.revenueTargetMonthly} onChange={(e) => setSettings((s) => ({ ...s, revenueTargetMonthly: e.target.value }))} placeholder="0" /></Field>
          <Field label="Monthly pipeline target"><Text type="number" value={settings.pipelineTargetMonthly} onChange={(e) => setSettings((s) => ({ ...s, pipelineTargetMonthly: e.target.value }))} placeholder="0" /></Field>
          <Field label="Client touch cadence (days)"><Text type="number" value={settings.touchCadenceDays} onChange={(e) => setSettings((s) => ({ ...s, touchCadenceDays: e.target.value }))} placeholder="7" /></Field>
          <Field label="KPI freshness window (days)"><Text type="number" value={settings.kpiStaleDays} onChange={(e) => setSettings((s) => ({ ...s, kpiStaleDays: e.target.value }))} placeholder="4" /></Field>
        </FormGrid>
      </Card>
      <Card title="Google Calendar" sub="Show your live Google schedule on the Calendar page (Google → 📅 Google view)" style={{ marginBottom: 14 }}>
        <Field label="Calendar embed URL">
          <Text value={settings.googleCalendarUrl || ""} onChange={(e) => setSettings((s) => ({ ...s, googleCalendarUrl: e.target.value }))}
            placeholder="https://calendar.google.com/calendar/embed?src=you%40gmail.com&..." />
        </Field>
        <p style={{ fontSize: 12, color: C.mute, margin: "10px 0 0", lineHeight: 1.6 }}>
          In Google Calendar (desktop): <b>Settings ⚙ → </b> pick your calendar under “Settings for my calendars” →
          <b> Integrate calendar</b> → copy the URL inside the <b>Embed code</b>'s <code>src="…"</code>, paste it above.
          It then appears under Calendar → <b>📅 Google</b>. (For a private calendar, make sure it's shared/embeddable.)
        </p>
      </Card>
      <Card title="Client health weighting" sub="How the computed health score is blended (analytical signals + your gut)" style={{ marginBottom: 14 }}>
        <FormGrid>
          {[["roas", "ROAS vs target"], ["touch", "Touch recency"], ["deliverables", "Deliverables load"], ["trend", "ROAS trend"], ["gut", "Gut feel"]].map(([k, l]) => (
            <Field key={k} label={`${l} (${settings.health?.[k] ?? 0}%)`}>
              <input type="range" min="0" max="60" step="5" value={settings.health?.[k] ?? 0}
                onChange={(e) => setSettings((s) => ({ ...s, health: { ...s.health, [k]: Number(e.target.value) } }))} />
            </Field>
          ))}
        </FormGrid>
        <p style={{ fontSize: 12, color: C.mute, margin: "8px 0 0" }}>Weights are relative — they're normalized automatically, and any signal with no data is skipped.</p>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 14, marginBottom: 14 }}>
        {lists.map(([key, label]) => <ListEditor key={key} label={label} items={settings[key]} onChange={(a) => editList(key, a)} />)}
      </div>
      <Card title="Roles & permissions" sub="Structure ready — everything accessible for now">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["CEO / Admin", "Account Manager", "Ops", "Contractor", "Read-only"].map((r) => <Pill key={r}>{r}</Pill>)}
        </div>
        <p style={{ fontSize: 12.5, color: C.mute, marginTop: 12, marginBottom: 0 }}>Authentication-ready structure. Role gating can be enabled per module without restructuring data.</p>
      </Card>
      <DataPanel />
    </div>
  );
}

/* --------------------------- backup / import ----------------------------- */
/* Browser (localStorage) persistence keeps your data between sessions.
   This panel lets you snapshot everything to a JSON file, restore from one,
   and reset. Keeps the tool usable as a real system of record. */
function DataPanel() {
  const { db, setDb, settings, setSettings, syncState } = useStore();
  const toast = useToast();
  const fileRef = useRef(null);
  const [pushing, setPushing] = useState(false);

  // One-click migration: push everything currently loaded up to the cloud.
  const pushToCloud = async () => {
    if (!supabaseConfigured) { toast("Cloud not connected yet", "warn"); return; }
    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session) { toast("Sign in first", "warn"); return; }
    const rows = [];
    Object.entries(db).forEach(([coll, list]) => (list || []).forEach((r) => {
      if (r && r.id) rows.push({ id: r.id, collection: coll, data: r, updated_at: r.updated_at || nowISO() });
    }));
    if (!rows.length) { toast("Nothing to upload", "warn"); return; }
    setPushing(true);
    let ok = 0, fail = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await supabase.from("records").upsert(chunk);
      if (error) fail += chunk.length; else ok += chunk.length;
    }
    await supabase.from("app_settings").upsert({ data: settings, updated_at: nowISO() });
    setPushing(false);
    toast(fail ? `Uploaded ${ok}, ${fail} failed` : `Uploaded ${ok} records to cloud`, fail ? "warn" : "success");
  };
  const totalRecords = Object.values(db).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0);

  const exportBackup = () => {
    const payload = { app: "dtc-ceo-operating-system", version: 1, exported_at: nowISO(), db, settings };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dtc-os-backup-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Backup downloaded", "success");
  };

  const handleFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const incoming = parsed && parsed.db ? parsed.db : parsed; // accept raw db or wrapped backup
        if (!incoming || typeof incoming !== "object") throw new Error("Unrecognized file");
        const merged = { ...emptyDB() };
        let count = 0;
        Object.keys(merged).forEach((k) => {
          if (Array.isArray(incoming[k])) { merged[k] = incoming[k]; count += incoming[k].length; }
        });
        if (!window.confirm(`Replace ALL current data with this backup?\n\nIncoming: ${count} records across ${Object.keys(merged).length} tables.\nThis overwrites what's loaded now (export a backup first if unsure).`)) {
          if (fileRef.current) fileRef.current.value = "";
          return;
        }
        setDb(merged);
        if (parsed && parsed.settings && typeof parsed.settings === "object") {
          setSettings((s) => ({ ...s, ...parsed.settings, health: { ...s.health, ...(parsed.settings.health || {}) } }));
        }
        toast(`Imported ${count} records`, "success");
      } catch (err) {
        toast("Import failed — not a valid backup file", "danger");
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
    };
    reader.readAsText(file);
  };

  const wipeAll = () => {
    if (!window.confirm("Erase ALL data in this tool? This cannot be undone. Export a backup first if you want to keep it.")) return;
    if (!window.confirm("Are you absolutely sure? Every task, client, lead, project and note will be permanently removed.")) return;
    setDb(emptyDB());
    toast("All data cleared", "warn");
  };

  return (
    <Card title="Data backup & import" sub="Your data is saved in this browser. Snapshot it to a file, restore it, or reset." style={{ marginTop: 14 }}>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13, color: C.slate, marginBottom: 14 }}>
        {Object.entries(db).map(([k, v]) => <span key={k}>{k}: <b className="os-num">{Array.isArray(v) ? v.length : 0}</b></span>)}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Btn variant="solid" onClick={exportBackup}>↓ Export backup (.json)</Btn>
        <Btn onClick={() => fileRef.current && fileRef.current.click()}>↑ Import / restore</Btn>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={handleFile} style={{ display: "none" }} />
        {supabaseConfigured && <Btn onClick={pushToCloud}>{pushing ? "Uploading…" : "☁ Push local data to cloud"}</Btn>}
        <div style={{ flex: 1 }} />
        <Btn variant="danger" onClick={wipeAll}>Erase all data</Btn>
      </div>
      <p style={{ fontSize: 12, color: C.mute, margin: "12px 0 0" }}>
        {totalRecords} record{totalRecords === 1 ? "" : "s"} loaded.{" "}
        {supabaseConfigured
          ? (syncState === "synced" ? "Connected to the cloud — every change saves live and is available on any device you log in from."
             : syncState === "loading" ? "Syncing with the cloud…"
             : syncState === "error" ? "Cloud connected but a sync error occurred — check your connection."
             : "Cloud connected.")
          : "Local-only mode (browser storage). Add Supabase keys to go live across devices."}
        {" "}Use “Push local data to cloud” once to migrate data you entered before connecting.
      </p>
    </Card>
  );
}

function ListEditor({ label, items, onChange }) {
  const [val, setVal] = useState("");
  return (
    <Card title={label} pad={12}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {items.map((it) => (
          <span key={it} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: C.chip, borderRadius: 7, padding: "4px 8px", fontSize: 12.5 }}>
            {it}<button onClick={() => onChange(items.filter((x) => x !== it))} style={{ border: "none", background: "transparent", color: C.mute, cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</button>
          </span>
        ))}
        {!items.length && <span style={{ fontSize: 12.5, color: C.mute }}>No options.</span>}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="Add option…"
          onKeyDown={(e) => { if (e.key === "Enter" && val.trim()) { onChange([...items, val.trim()]); setVal(""); } }}
          style={{ ...inS, padding: "6px 9px" }} />
        <Btn size="sm" onClick={() => { if (val.trim()) { onChange([...items, val.trim()]); setVal(""); } }}>Add</Btn>
      </div>
    </Card>
  );
}

/* ----------------------------- NAV + SHELL ------------------------------- */
const NavCtx = createContext(null);
const useNav = () => useContext(NavCtx);

const NAV = [
  ["ceo", "CEO Dashboard", "◆"], ["daily", "Daily", "○"], ["weekly", "Weekly", "○"], ["monthly", "Monthly", "○"],
  ["quarterly", "Quarterly", "○"], ["yearly", "Yearly", "○"], ["calendar", "Calendar", "▦"], ["tasks", "Master Tasks", "▣"], ["projects", "Major Projects", "▤"],
  ["leads", "CRM Leads", "◈"], ["pipeline", "Sales Pipeline", "▰"], ["clients", "Clients", "◉"], ["money", "Money", "$"], ["reports", "Client Reports", "▢"], ["pm", "Project Management", "▦"], ["team", "Partners", "◐"],
  ["journal", "Journal", "✎"], ["inbox", "Capture Inbox", "⊕"], ["vision", "Vision", "✦"], ["settings", "Settings", "⚙"],
];
const NAV_GROUPS = [
  ["Command", ["ceo", "inbox"]],
  ["Cadence", ["daily", "weekly", "monthly", "quarterly", "yearly", "calendar"]],
  ["Execution", ["tasks", "projects", "pm", "team"]],
  ["Revenue", ["leads", "pipeline", "clients", "money", "reports"]],
  ["Strategy", ["journal", "vision"]],
  ["System", ["settings"]],
];
const labelOf = (id) => NAV.find((n) => n[0] === id)?.[1] || id;
const iconOf = (id) => NAV.find((n) => n[0] === id)?.[2] || "○";
/* ============================================================================
   PART 11 — CALENDAR & WORKLOAD ROLLUP
   Day completion → Week → Month → Quarter → Year. A day's health = % of that
   day's tasks marked Done. Higher levels average the level beneath them,
   counting only buckets that actually had tasks (empty = neutral, not failing).
============================================================================ */

/* ------------------------------ date math -------------------------------- */
const DAY_MS = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);
const parseYmd = (s) => new Date(s + "T00:00:00");
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = new Date(d); const g = (x.getDay() + 6) % 7; x.setDate(x.getDate() - g); x.setHours(0, 0, 0, 0); return x; }; // Monday start
const startOfMonth = (y, m) => new Date(y, m, 1);
const endOfMonth = (y, m) => new Date(y, m + 1, 0);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const quarterOf = (m) => Math.floor(m / 3); // 0..3
const quarterMonths = (q) => [q * 3, q * 3 + 1, q * 3 + 2];

/* health → tone + color. null = no tasks that period (neutral). */
const healthTone = (h) => h == null ? "none" : h >= 85 ? "green" : h >= 60 ? "blue" : h >= 35 ? "yellow" : "red";
const HEALTH_C = {
  none: { bg: "#f3f4f6", fg: "#9aa0a8", bar: "#e5e7eb" },
  green: { bg: "#e7f6ec", fg: "#1a7f43", bar: "#22a45d" },
  blue: { bg: "#e8f0fe", fg: "#1b5fd0", bar: "#2f6fe0" },
  yellow: { bg: "#fdf4e3", fg: "#9a6a00", bar: "#e0a82e" },
  red: { bg: "#fdecec", fg: "#c0392b", bar: "#e05c4f" },
};

/* ------------------------- rollup computation ---------------------------- */
// Returns { byDay: Map(ymd -> {total,done,health}), dayHealth(ymd), weekHealth(monday),
//           monthHealth(y,m), quarterHealth(y,q), yearHealth(y) }
function useWorkload() {
  const { db } = useStore();
  return useMemo(() => {
    const byDay = new Map();
    for (const t of db.tasks) {
      if (!t.due_date) continue;
      const k = t.due_date;
      const cur = byDay.get(k) || { total: 0, done: 0 };
      cur.total += 1;
      if (t.status === "Done") cur.done += 1;
      byDay.set(k, cur);
    }
    for (const [, v] of byDay) v.health = v.total ? Math.round((v.done / v.total) * 100) : null;

    const dayHealth = (k) => byDay.get(k)?.health ?? null;

    const avg = (vals) => {
      const xs = vals.filter((v) => v != null);
      return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    };
    const weekHealth = (monday) => {
      const days = [];
      for (let i = 0; i < 7; i++) days.push(dayHealth(ymd(addDays(monday, i))));
      return avg(days);
    };
    const monthHealth = (y, m) => {
      // average of the weeks that overlap this month, using only this month's days
      const first = startOfMonth(y, m), last = endOfMonth(y, m);
      const weeks = new Map();
      for (let d = new Date(first); d <= last; d = addDays(d, 1)) {
        const wk = ymd(startOfWeek(d));
        const h = dayHealth(ymd(d));
        if (h == null) continue;
        const cur = weeks.get(wk) || [];
        cur.push(h); weeks.set(wk, cur);
      }
      return avg([...weeks.values()].map((arr) => avg(arr)));
    };
    const quarterHealth = (y, q) => avg(quarterMonths(q).map((m) => monthHealth(y, m)));
    const yearHealth = (y) => avg([0, 1, 2, 3].map((q) => quarterHealth(y, q)));

    const totals = (() => {
      let total = 0, done = 0;
      for (const [, v] of byDay) { total += v.total; done += v.done; }
      return { total, done };
    })();

    return { byDay, dayHealth, weekHealth, monthHealth, quarterHealth, yearHealth, totals };
  }, [db.tasks]);
}

/* ----------------------------- small UI bits ----------------------------- */
function HealthDot({ health, size = 8 }) {
  const c = HEALTH_C[healthTone(health)];
  return <span style={{ width: size, height: size, borderRadius: 99, background: c.bar, display: "inline-block", flexShrink: 0 }} />;
}
function HealthBadge({ health, label }) {
  const c = HEALTH_C[healthTone(health)];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: c.bg, color: c.fg, padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
      <span className="os-num">{health == null ? "—" : health + "%"}</span>{label ? <span style={{ fontWeight: 600, opacity: 0.85 }}>{label}</span> : null}
    </span>
  );
}
function HealthLegend() {
  const items = [["On track", "green"], ["Steady", "blue"], ["Slipping", "yellow"], ["Behind", "red"], ["No work", "none"]];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", fontSize: 11.5, color: C.mute }}>
      {items.map(([l, t]) => (
        <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: HEALTH_C[t].bar }} />{l}
        </span>
      ))}
    </div>
  );
}

/* --------------------------- Month calendar ------------------------------ */
function MonthCalendar({ year, month, onPickDay, compact }) {
  const wl = useWorkload();
  const first = startOfMonth(year, month);
  const gridStart = startOfWeek(first);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const inMonth = d.getMonth() === month;
    const k = ymd(d);
    const rec = wl.byDay.get(k);
    const h = rec?.health ?? null;
    cells.push({ d, k, inMonth, h, total: rec?.total || 0, done: rec?.done || 0 });
    if (i >= 34 && d.getMonth() !== month && addDays(gridStart, i + 1).getMonth() !== month) break;
  }
  const today = todayStr();
  const cellH = compact ? 34 : 64;
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 6 }}>
        {WD.map((w) => <div key={w} style={{ textAlign: "center", fontSize: 10.5, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: 0.5 }}>{compact ? w[0] : w}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
        {cells.map((c, i) => {
          const tone = HEALTH_C[healthTone(c.h)];
          const isToday = c.k === today;
          const has = c.total > 0;
          return (
            <button key={i} onClick={() => onPickDay && onPickDay(c.k)} disabled={!onPickDay}
              title={has ? `${c.done}/${c.total} done` : "No tasks"}
              style={{
                position: "relative", height: cellH, borderRadius: 9, cursor: onPickDay ? "pointer" : "default",
                border: isToday ? `2px solid ${C.ink}` : `1px solid ${has ? "transparent" : C.line}`,
                background: has ? tone.bg : (c.inMonth ? "#fff" : "#fafafb"),
                opacity: c.inMonth ? 1 : 0.45, padding: compact ? 0 : "6px 7px",
                display: "flex", flexDirection: "column", alignItems: compact ? "center" : "flex-start", justifyContent: compact ? "center" : "space-between",
                transition: "transform .08s",
              }}
              onMouseEnter={(e) => { if (onPickDay) e.currentTarget.style.transform = "translateY(-1px)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; }}>
              <span className="os-num" style={{ fontSize: compact ? 11 : 12.5, fontWeight: isToday ? 800 : 600, color: has ? tone.fg : C.charcoal }}>{c.d.getDate()}</span>
              {!compact && has && (
                <span style={{ display: "flex", alignItems: "center", gap: 5, width: "100%" }}>
                  <span style={{ flex: 1, height: 4, borderRadius: 9, background: "rgba(0,0,0,.07)", overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${c.h}%`, background: tone.bar }} />
                  </span>
                  <span className="os-num" style={{ fontSize: 10, fontWeight: 700, color: tone.fg }}>{c.done}/{c.total}</span>
                </span>
              )}
              {compact && has && <span style={{ position: "absolute", bottom: 4, width: 5, height: 5, borderRadius: 99, background: tone.bar }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------- Year heat strip ----------------------------- */
function YearOverview({ year, onPickMonth }) {
  const wl = useWorkload();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 10 }}>
      {MONTHS.map((mn, m) => {
        const h = wl.monthHealth(year, m);
        const tone = HEALTH_C[healthTone(h)];
        const q = quarterOf(m);
        return (
          <button key={m} onClick={() => onPickMonth && onPickMonth(m)}
            style={{ textAlign: "left", border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, background: tone.bg, cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: tone.fg }}>{mn}</span>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: C.mute, textTransform: "uppercase" }}>Q{q + 1}</span>
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: tone.fg }} className="os-num">{h == null ? "—" : h + "%"}</div>
            <div style={{ height: 5, borderRadius: 9, background: "rgba(0,0,0,.06)", marginTop: 8, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${h || 0}%`, background: tone.bar }} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------- Quarter → month → week chain -------------------- */
function RollupChain({ year }) {
  const wl = useWorkload();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
      {[0, 1, 2, 3].map((q) => {
        const h = wl.quarterHealth(year, q);
        const tone = HEALTH_C[healthTone(h)];
        return (
          <div key={q} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, background: "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>Q{q + 1}</span>
              <HealthBadge health={h} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {quarterMonths(q).map((m) => {
                const mh = wl.monthHealth(year, m);
                const mt = HEALTH_C[healthTone(mh)];
                return (
                  <div key={m} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 28, fontSize: 11.5, fontWeight: 600, color: C.mute }}>{MONTHS[m]}</span>
                    <span style={{ flex: 1, height: 6, borderRadius: 9, background: "#f0f1f3", overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${mh || 0}%`, background: mt.bar }} />
                    </span>
                    <span className="os-num" style={{ fontSize: 11, fontWeight: 700, color: mt.fg, width: 32, textAlign: "right" }}>{mh == null ? "—" : mh + "%"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------- Day task drawer ----------------------------- */
function DayDrawer({ dayKey, onClose }) {
  const { db, update } = useStore();
  const { go } = useNav();
  if (!dayKey) return null;
  const tasks = db.tasks.filter((t) => t.due_date === dayKey);
  const done = tasks.filter((t) => t.status === "Done").length;
  const h = tasks.length ? Math.round((done / tasks.length) * 100) : null;
  const toggle = (t) => update("tasks", t.id, { status: t.status === "Done" ? "In Progress" : "Done", completed_date: t.status === "Done" ? "" : todayStr() });
  return (
    <Drawer open={!!dayKey} onClose={onClose} title={fmtDate(dayKey)}>
      <div style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <HealthBadge health={h} label="day health" />
          <span style={{ fontSize: 13, color: C.mute }}>{done}/{tasks.length} done</span>
        </div>
        {tasks.length === 0 ? (
          <Empty title="No tasks for this day" hint="Schedule work by setting a task's due date." action={<Btn size="sm" variant="solid" onClick={() => { onClose(); go("tasks"); }}>Go to tasks</Btn>} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {tasks.map((t) => {
              const isDone = t.status === "Done";
              return (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px" }}>
                  <button onClick={() => toggle(t)} title={isDone ? "Mark not done" : "Mark done"}
                    style={{ width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${isDone ? C.green : C.line}`, background: isDone ? C.green : "#fff", color: "#fff", display: "grid", placeItems: "center", fontSize: 13, flexShrink: 0 }}>{isDone ? "✓" : ""}</button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, textDecoration: isDone ? "line-through" : "none", color: isDone ? C.mute : C.ink }}>{t.title}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 3 }}>
                      <PrioBadge value={t.priority} /><StatusPill value={t.status} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Drawer>
  );
}

/* ----------------------- embeddable cadence widget ----------------------- */
// scope: "Daily" | "Weekly" | "Monthly" | "Quarterly" | "Yearly"
function CadenceCalendar({ scope }) {
  const wl = useWorkload();
  const now = new Date();
  const [ref, setRef] = useState(now);
  const [day, setDay] = useState(null);
  const y = ref.getFullYear(), m = ref.getMonth();

  if (scope === "Yearly") {
    return (
      <Card title={`${y} workload`} sub="Each month rolls up from its weeks and days" right={<HealthBadge health={wl.yearHealth(y)} label="year" />}>
        <div style={{ marginBottom: 12 }}><HealthLegend /></div>
        <YearOverview year={y} onPickMonth={() => {}} />
      </Card>
    );
  }
  if (scope === "Quarterly") {
    const q = quarterOf(m);
    return (
      <Card title={`Q${q + 1} ${y}`} sub="Months rolling up to the quarter" right={<HealthBadge health={wl.quarterHealth(y, q)} label="quarter" />}>
        <div style={{ display: "grid", gap: 10 }}>
          {quarterMonths(q).map((mm) => (
            <div key={mm}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{MONTHS_FULL[mm]}</span>
                <HealthBadge health={wl.monthHealth(y, mm)} />
              </div>
              <MonthCalendar year={y} month={mm} compact onPickDay={setDay} />
            </div>
          ))}
        </div>
        <DayDrawer dayKey={day} onClose={() => setDay(null)} />
      </Card>
    );
  }
  if (scope === "Monthly") {
    return (
      <Card title={`${MONTHS_FULL[m]} ${y}`} sub="Click any day to see its tasks"
        right={<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <HealthBadge health={wl.monthHealth(y, m)} label="month" />
          <Btn size="sm" onClick={() => setRef(new Date(y, m - 1, 1))}>‹</Btn>
          <Btn size="sm" onClick={() => setRef(new Date(y, m + 1, 1))}>›</Btn>
        </div>}>
        <div style={{ marginBottom: 12 }}><HealthLegend /></div>
        <MonthCalendar year={y} month={m} onPickDay={setDay} />
        <DayDrawer dayKey={day} onClose={() => setDay(null)} />
      </Card>
    );
  }
  // Weekly + Daily → a single week strip
  const base = scope === "Daily" ? now : ref;
  const monday = startOfWeek(base);
  const weekH = wl.weekHealth(monday);
  return (
    <Card title={scope === "Daily" ? "This week" : "Week view"}
      sub={`${fmtDate(ymd(monday))} – ${fmtDate(ymd(addDays(monday, 6)))}`}
      right={<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <HealthBadge health={weekH} label="week" />
        {scope === "Weekly" && <><Btn size="sm" onClick={() => setRef(addDays(monday, -7))}>‹</Btn><Btn size="sm" onClick={() => setRef(addDays(monday, 7))}>›</Btn></>}
      </div>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6 }}>
        {Array.from({ length: 7 }, (_, i) => {
          const d = addDays(monday, i), k = ymd(d);
          const rec = wl.byDay.get(k); const h = rec?.health ?? null;
          const tone = HEALTH_C[healthTone(h)]; const isToday = k === todayStr();
          return (
            <button key={i} onClick={() => setDay(k)}
              style={{ border: isToday ? `2px solid ${C.ink}` : `1px solid ${rec ? "transparent" : C.line}`, background: rec ? tone.bg : "#fff", borderRadius: 11, padding: "10px 8px", cursor: "pointer", textAlign: "center" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: C.mute, textTransform: "uppercase" }}>{WD[i]}</div>
              <div className="os-num" style={{ fontSize: 17, fontWeight: 800, margin: "3px 0", color: rec ? tone.fg : C.charcoal }}>{d.getDate()}</div>
              {rec ? <div className="os-num" style={{ fontSize: 11, fontWeight: 700, color: tone.fg }}>{rec.done}/{rec.total}</div>
                : <div style={{ fontSize: 11, color: C.mute }}>—</div>}
            </button>
          );
        })}
      </div>
      <DayDrawer dayKey={day} onClose={() => setDay(null)} />
    </Card>
  );
}

/* ----------------------------- Calendar page ----------------------------- */
function GoogleCalendarView() {
  const { settings } = useStore();
  const url = (settings.googleCalendarUrl || "").trim();
  const { go } = useNav();
  if (!url) {
    return (
      <Card>
        <Empty title="Connect your Google Calendar"
          hint="Paste your calendar's embed link in Settings → it'll show your live schedule right here, next to your task rollup."
          action={<Btn variant="solid" onClick={() => go("settings")}>Open Settings</Btn>} />
        <div style={{ marginTop: 14, fontSize: 12, color: C.mute, lineHeight: 1.6, borderTop: `1px solid ${C.line2}`, paddingTop: 12 }}>
          <b>Where to get the link:</b> Google Calendar (on desktop) → Settings ⚙ → click your calendar under
          “Settings for my calendars” → “Integrate calendar” → copy the <b>Embed code</b>'s <code>src="..."</code> URL
          (or the public URL). Paste it into Settings here.
        </div>
      </Card>
    );
  }
  return (
    <Card pad={0} style={{ overflow: "hidden" }}>
      <iframe title="Google Calendar" src={url} style={{ width: "100%", height: "70vh", minHeight: 540, border: 0, display: "block" }} />
    </Card>
  );
}

function CalendarPage() {
  const wl = useWorkload();
  const now = new Date();
  const [ref, setRef] = useState(now);
  const [zoom, setZoom] = useState("Month"); // Year | Quarter | Month | Week | Google
  const [day, setDay] = useState(null);
  const y = ref.getFullYear(), m = ref.getMonth(), q = quarterOf(m);
  const step = (dir) => {
    if (zoom === "Year") setRef(new Date(y + dir, m, 1));
    else if (zoom === "Quarter") setRef(new Date(y, m + dir * 3, 1));
    else if (zoom === "Month") setRef(new Date(y, m + dir, 1));
    else setRef(addDays(ref, dir * 7));
  };
  const label = zoom === "Year" ? `${y}` : zoom === "Quarter" ? `Q${q + 1} ${y}` : zoom === "Week" ? `Week of ${fmtDate(ymd(startOfWeek(ref)))}` : `${MONTHS_FULL[m]} ${y}`;
  const topHealth = zoom === "Year" ? wl.yearHealth(y) : zoom === "Quarter" ? wl.quarterHealth(y, q) : zoom === "Week" ? wl.weekHealth(startOfWeek(ref)) : wl.monthHealth(y, m);

  return (
    <div>
      <PageHead title="Calendar" sub="Daily completion rolls up into weeks, months, quarters, and the year"
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {["Year", "Quarter", "Month", "Week", "Google"].map((z) => (
              <Btn key={z} variant={zoom === z ? "subtle" : "ghost"} size="sm" onClick={() => setZoom(z)}>{z === "Google" ? "📅 Google" : z}</Btn>
            ))}
            {zoom !== "Google" && <><Btn size="sm" onClick={() => step(-1)}>‹</Btn>
            <Btn size="sm" onClick={() => setRef(new Date())}>Today</Btn>
            <Btn size="sm" onClick={() => step(1)}>›</Btn></>}
          </div>
        } />

      {zoom === "Google" ? <GoogleCalendarView /> : (
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, padding: "2px 2px 14px" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-.01em" }}>{label}</div>
            <div style={{ fontSize: 12.5, color: C.mute, marginTop: 2 }}>{wl.totals.done}/{wl.totals.total} tasks complete all-time</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <HealthBadge health={topHealth} label={zoom.toLowerCase()} />
            <HealthLegend />
          </div>
        </div>

        {zoom === "Year" && (<><YearOverview year={y} onPickMonth={(mm) => { setRef(new Date(y, mm, 1)); setZoom("Month"); }} /><div style={{ height: 16 }} /><RollupChain year={y} /></>)}
        {zoom === "Quarter" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14 }}>
            {quarterMonths(q).map((mm) => (
              <div key={mm}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <button onClick={() => { setRef(new Date(y, mm, 1)); setZoom("Month"); }} style={{ border: "none", background: "none", cursor: "pointer", fontWeight: 700, fontSize: 14, color: C.ink }}>{MONTHS_FULL[mm]}</button>
                  <HealthBadge health={wl.monthHealth(y, mm)} />
                </div>
                <MonthCalendar year={y} month={mm} compact onPickDay={setDay} />
              </div>
            ))}
          </div>
        )}
        {zoom === "Month" && <MonthCalendar year={y} month={m} onPickDay={setDay} />}
        {zoom === "Week" && <CadenceWeekStrip ref0={ref} onPickDay={setDay} />}
      </Card>
      )}

      <DayDrawer dayKey={day} onClose={() => setDay(null)} />
    </div>
  );
}

function CadenceWeekStrip({ ref0, onPickDay }) {
  const wl = useWorkload();
  const monday = startOfWeek(ref0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 8 }}>
      {Array.from({ length: 7 }, (_, i) => {
        const d = addDays(monday, i), k = ymd(d);
        const rec = wl.byDay.get(k); const h = rec?.health ?? null;
        const tone = HEALTH_C[healthTone(h)]; const isToday = k === todayStr();
        return (
          <button key={i} onClick={() => onPickDay(k)}
            style={{ border: isToday ? `2px solid ${C.ink}` : `1px solid ${rec ? "transparent" : C.line}`, background: rec ? tone.bg : "#fff", borderRadius: 12, padding: "14px 8px", cursor: "pointer", textAlign: "center", minHeight: 96 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.mute, textTransform: "uppercase" }}>{WD[i]}</div>
            <div className="os-num" style={{ fontSize: 22, fontWeight: 800, margin: "4px 0", color: rec ? tone.fg : C.charcoal }}>{d.getDate()}</div>
            {rec ? <div className="os-num" style={{ fontSize: 12, fontWeight: 700, color: tone.fg }}>{rec.done}/{rec.total}</div> : <div style={{ fontSize: 12, color: C.mute }}>—</div>}
          </button>
        );
      })}
    </div>
  );
}
/* ============================================================================
   PART 12 — CLIENT WORKSPACE · MONEY · CAPTURE · KPIs · MEETINGS · REPORTS
============================================================================ */

/* ----------------------------- small helpers ----------------------------- */
function MiniForm({ fields, initial, onSave, onCancel, submitLabel = "Save" }) {
  const [f, set] = useForm(initial);
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, background: C.panel, marginBottom: 12 }}>
      <FormGrid>
        {fields.map((fld) => (
          <Field key={fld.k} label={fld.label} span={fld.span}>
            {fld.type === "area" ? <Area value={f[fld.k]} onChange={set(fld.k)} placeholder={fld.ph} />
              : fld.type === "select" ? <Select value={f[fld.k]} onChange={set(fld.k)} options={fld.options} allowEmpty={fld.allowEmpty !== false} />
              : <Text type={fld.type || "text"} value={f[fld.k]} onChange={set(fld.k)} placeholder={fld.ph} />}
          </Field>
        ))}
      </FormGrid>
      <FormActions onCancel={onCancel} submitLabel={submitLabel} onSubmit={() => onSave(f)} />
    </div>
  );
}
// FormActions has no onSubmit; provide a thin wrapper that calls save on the primary button.
function InlineActions({ onCancel, onSave, label = "Save" }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
      <Btn onClick={onCancel}>Cancel</Btn>
      <Btn variant="solid" onClick={onSave}>{label}</Btn>
    </div>
  );
}

const fmtX = (v) => (v === "" || v == null ? "—" : (Math.round(num(v) * 100) / 100) + "×");
const fmtDateTime = (iso) => { try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return "—"; } };

/* =============================== MONEY ==================================== */
function MoneyPage() {
  const { db, settings } = useStore();
  const { go } = useNav();
  const active = db.clients.filter((c) => !["Offboarding"].includes(c.client_status));
  const spendUnderMgmt = active.reduce((s, c) => s + num(c.ad_spend), 0);
  const mrr = active.reduce((s, c) => s + calc.recurringRevenue(c), 0);
  const retainer = active.reduce((s, c) => s + (c.billing_type === "Project" ? 0 : num(c.monthly_retainer)), 0);
  const perf = mrr - retainer;
  const oneTimeTotal = active.reduce((s, c) => s + calc.oneTimeRevenue(c), 0);
  const setupTotal = active.reduce((s, c) => s + num(c.setup_fee), 0);
  const bonusTotal = active.reduce((s, c) => s + num(c.one_time_bonus), 0);
  const projectClients = active.filter((c) => (c.billing_type === "Project" || c.billing_type === "Hybrid") && num(c.project_value) > 0);
  const projectOutstanding = projectClients.reduce((s, c) => s + calc.projectBalance(c), 0);
  const oneTimeRows = active.filter((c) => calc.oneTimeRevenue(c) > 0).sort((a, b) => calc.oneTimeRevenue(b) - calc.oneTimeRevenue(a));
  const openPipe = db.leads.filter((l) => !["Closed Won", "Closed Lost"].includes(l.lead_status));
  const weighted = openPipe.reduce((s, l) => s + calc.weightedPipeline(l), 0);

  const byClient = [...active].sort((a, b) => calc.recurringRevenue(b) - calc.recurringRevenue(a));
  const renewals = active.filter((c) => { const d = daysUntil(c.renewal_date); return d != null && d <= 60 && d >= -7; })
    .sort((a, b) => (daysUntil(a.renewal_date) - daysUntil(b.renewal_date)));

  // bonus triggers
  const bonuses = active.map((c) => {
    const k = calc.latestKpi(db, c.id);
    const roas = k ? num(k.roas) : null;
    const spend = num(c.ad_spend);
    const needRoas = num(c.bonus_threshold_roas), needSpend = num(c.bonus_threshold_spend);
    if (!needRoas && !needSpend) return null;
    const roasOk = !needRoas || (roas != null && roas >= needRoas);
    const spendOk = !needSpend || spend >= needSpend;
    return { c, roas, spend, needRoas, needSpend, roasOk, spendOk, hit: roasOk && spendOk };
  }).filter(Boolean);

  const target = num(settings.revenueTargetMonthly);
  const attain = target ? Math.round((mrr / target) * 100) : null;

  return (
    <div>
      <PageHead title="Money" sub="The numbers that determine revenue"
        actions={<Btn onClick={() => exportCSV(byClient.map((c) => ({ client: c.client_name, retainer: num(c.monthly_retainer), spend: num(c.ad_spend), fee_pct: num(c.management_fee_percent), revenue: Math.round(calc.agencyRevenue(c)) })), [{ key: "client", label: "Client" }, { key: "retainer", label: "Retainer" }, { key: "spend", label: "Ad spend" }, { key: "fee_pct", label: "Fee %" }, { key: "revenue", label: "Revenue" }], "money.csv")}>Export</Btn>} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(165px,1fr))", gap: 12, marginBottom: 16 }}>
        <KPI label="Monthly Revenue" value={fmtMoney(mrr)} sub={attain != null ? `${attain}% of target` : "set target in Settings"} tone={attain != null && attain >= 100 ? "green" : null} />
        <KPI label="Spend Under Mgmt" value={fmtMoney(spendUnderMgmt)} tone="blue" />
        <KPI label="Performance Revenue" value={fmtMoney(perf)} sub="from % of spend" />
        <KPI label="Retainer Revenue" value={fmtMoney(retainer)} />
        <KPI label="One-Time Revenue" value={fmtMoney(oneTimeTotal)} sub="setup + bonus (not in MRR)" tone={oneTimeTotal ? "green" : null} />
        <KPI label="Project Outstanding" value={fmtMoney(projectOutstanding)} sub="balance to collect" tone={projectOutstanding ? "yellow" : null} />
        <KPI label="Weighted Pipeline" value={fmtMoney(weighted)} tone="blue" />
        <KPI label="Annual Run-Rate" value={fmtMoney(mrr * 12)} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,340px),1fr))", gap: 14 }}>
        <Card title="Revenue by Client" sub="Highest first">
          {byClient.length ? byClient.map((c) => {
            const rev = calc.recurringRevenue(c);
            const pct = mrr ? Math.round((rev / mrr) * 100) : 0;
            return (
              <div key={c.id} onClick={() => go("clients", c.id)} className="os-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 6px", borderRadius: 8, cursor: "pointer" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{c.client_name}</div>
                  <div style={{ height: 5, borderRadius: 9, background: "#f0f1f3", marginTop: 5, overflow: "hidden" }}><div style={{ height: "100%", width: `${pct}%`, background: C.ink }} /></div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="os-num" style={{ fontSize: 13, fontWeight: 700 }}>{fmtMoney(rev)}</div>
                  <div className="os-num" style={{ fontSize: 11, color: C.mute }}>{pct}%</div>
                </div>
              </div>
            );
          }) : <Empty title="No clients yet" hint="Add a client to see revenue." />}
        </Card>

        <Card title="Renewals (next 60 days)">
          {renewals.length ? renewals.map((c) => {
            const d = daysUntil(c.renewal_date);
            return <MiniItem key={c.id} onClick={() => go("clients", c.id)} title={c.client_name} sub={`Renews ${fmtDate(c.renewal_date)}`} right={<Pill tone={d < 14 ? "red" : d < 30 ? "yellow" : "blue"}>{d < 0 ? "Overdue" : `${d}d`}</Pill>} />;
          }) : <Empty title="No upcoming renewals" hint="Set renewal dates on clients." />}
        </Card>

        <Card title="Bonus Triggers" sub="Performance thresholds in play">
          {bonuses.length ? bonuses.map(({ c, roas, spend, needRoas, needSpend, roasOk, spendOk, hit }) => (
            <div key={c.id} onClick={() => go("clients", c.id)} className="os-row" style={{ padding: "10px 6px", borderRadius: 8, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{c.client_name}</span>
                <Pill tone={hit ? "green" : "yellow"}>{hit ? "Bonus hit" : "Pending"}</Pill>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 11.5, color: C.mute }}>
                {needRoas ? <span style={{ color: roasOk ? C.green : C.charcoal }}>ROAS {roas == null ? "—" : fmtX(roas)} / {fmtX(needRoas)}</span> : null}
                {needSpend ? <span style={{ color: spendOk ? C.green : C.charcoal }}>Spend {fmtMoney(spend)} / {fmtMoney(needSpend)}</span> : null}
              </div>
            </div>
          )) : <Empty title="No bonus thresholds set" hint="Add ROAS/spend bonus targets on a client." />}
        </Card>

        <Card title="One-Time Revenue" sub="Setup fees & bonus pay — separate from MRR">
          {oneTimeRows.length ? (<>
            {oneTimeRows.map((c) => (
              <div key={c.id} onClick={() => go("clients", c.id)} className="os-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 6px", borderRadius: 8, cursor: "pointer" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{c.client_name}</div>
                  <div style={{ fontSize: 11.5, color: C.mute }}>
                    {num(c.setup_fee) > 0 ? `Setup ${fmtMoney(c.setup_fee)}` : ""}{num(c.setup_fee) > 0 && num(c.one_time_bonus) > 0 ? " · " : ""}{num(c.one_time_bonus) > 0 ? `Bonus ${fmtMoney(c.one_time_bonus)}` : ""}
                    {c.one_time_bonus_note ? ` — ${c.one_time_bonus_note}` : ""}
                  </div>
                </div>
                <div className="os-num" style={{ fontSize: 13, fontWeight: 700 }}>{fmtMoney(calc.oneTimeRevenue(c))}</div>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.line2}`, fontSize: 12.5 }}>
              <span style={{ color: C.mute }}>Setup {fmtMoney(setupTotal)} · Bonus {fmtMoney(bonusTotal)}</span>
              <b className="os-num">{fmtMoney(oneTimeTotal)} total</b>
            </div>
          </>) : <Empty title="No one-time fees yet" hint="Add a setup fee or bonus on a client." />}
        </Card>

        <Card title="Project Balances" sub="Project & hybrid clients — value vs collected">
          {projectClients.length ? projectClients.map((c) => {
            const val = num(c.project_value), paid = num(c.project_paid), bal = calc.projectBalance(c);
            const pct = val ? Math.round((paid / val) * 100) : 0;
            return (
              <div key={c.id} onClick={() => go("clients", c.id)} className="os-row" style={{ padding: "9px 6px", borderRadius: 8, cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{c.client_name} {c.billing_type === "Hybrid" ? <span style={{ fontSize: 11, color: C.mute }}>(Hybrid)</span> : null}</span>
                  <span className="os-num" style={{ fontSize: 12.5, fontWeight: 700 }}>{fmtMoney(bal)} due</span>
                </div>
                <div style={{ height: 5, borderRadius: 9, background: "#f0f1f3", overflow: "hidden" }}><div style={{ height: "100%", width: `${pct}%`, background: pct >= 100 ? C.green : C.blue }} /></div>
                <div style={{ fontSize: 11, color: C.mute, marginTop: 3 }}>{fmtMoney(paid)} of {fmtMoney(val)} collected ({pct}%)</div>
              </div>
            );
          }) : <Empty title="No project clients" hint="Set billing type to Project or Hybrid on a client." />}
        </Card>
      </div>
    </div>
  );
}

/* ============================ CAPTURE INBOX ============================== */
function InboxPage() {
  const { db, add, update, remove } = useStore();
  const { go } = useNav();
  const toast = useToast();
  const rel = useRel();
  const [text, setText] = useState("");
  const [triage, setTriage] = useState(null);
  const open = db.inbox.filter((i) => !i.triaged);
  const quickAdd = () => { if (!text.trim()) return; add("inbox", { content: text.trim(), triaged: false }); setText(""); toast("Captured", "success"); };

  return (
    <div>
      <PageHead title="Capture Inbox" sub="Dump it now, sort it later" />
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="Brain dump — idea, to-do, reminder…"
            onKeyDown={(e) => { if (e.key === "Enter") quickAdd(); }}
            style={{ ...inS, flex: 1, fontSize: 15 }} />
          <Btn variant="solid" onClick={quickAdd}>Capture</Btn>
        </div>
      </Card>

      {open.length === 0 ? (
        <Empty title="Inbox zero" hint="Captured thoughts land here until you triage them." />
      ) : open.map((i) => (
        <Card key={i.id} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14 }}>{i.content}</div>
              <div style={{ fontSize: 11, color: C.mute, marginTop: 4 }}>{fmtDateTime(i.created_at)}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <Btn size="sm" onClick={() => setTriage(triage === i.id ? null : i.id)}>Triage</Btn>
              <Btn size="sm" variant="danger" onClick={() => remove("inbox", i.id)}>Delete</Btn>
            </div>
          </div>
          {triage === i.id && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line2}` }}>
              <div style={{ fontSize: 12, color: C.mute, marginBottom: 8 }}>Convert to — and optionally attach to a client/project:</div>
              <TriagePanel item={i} rel={rel}
                onConvert={(coll, rec) => { add(coll, rec); update("inbox", i.id, { triaged: true, triaged_to: coll }); setTriage(null); toast(`Moved to ${coll === "tasks" ? "tasks" : coll}`, "success"); }} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function TriagePanel({ item, rel, onConvert }) {
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Field label="Attach to client"><RelSelect value={client} onChange={setClient} options={rel.clientOpts} /></Field>
        <Field label="Attach to project"><RelSelect value={project} onChange={setProject} options={rel.projectOpts} /></Field>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn variant="solid" size="sm" onClick={() => onConvert("tasks", { title: item.content, task_type: "General Task", priority: "Medium", status: "Not Started", cadence: "Daily", related_client: client, related_project: project, impact_score: 3, urgency_score: 3 })}>→ Task</Btn>
        <Btn size="sm" onClick={() => onConvert("journal", { title: item.content.slice(0, 60), content: item.content, category: "Idea", cadence: "Daily", related_client: client, related_project: project })}>→ Journal</Btn>
        <Btn size="sm" onClick={() => onConvert("vision", { title: item.content.slice(0, 60), description: item.content, vision_type: "Business", time_horizon: "1 Year", status: "Active", priority: "Medium" })}>→ Vision</Btn>
        <Btn size="sm" onClick={() => onConvert("notes", { content: item.content, related_client: client, related_project: project })}>→ Note</Btn>
      </div>
    </div>
  );
}

/* ====================== CLIENT WORKSPACE (deep hub) ====================== */
function ClientWorkspace({ clientId, onClose, onEdit }) {
  const { db, settings, add, update, remove } = useStore();
  const { go } = useNav();
  const c = db.clients.find((x) => x.id === clientId);
  const [tab, setTab] = useState("overview");
  if (!c) return null;

  const tasks = db.tasks.filter((t) => t.related_client === c.id);
  const openTasks = tasks.filter((t) => !["Done", "Killed"].includes(t.status)).sort((a, b) => calc.taskScore(b) - calc.taskScore(a));
  const projects = db.projects.filter((p) => p.related_client === c.id);
  const meetings = db.meetings.filter((m) => m.client_id === c.id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const updates = db.updates.filter((u) => u.client_id === c.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const kpis = calc.kpisFor(db, c.id);
  const health = calc.computedHealth(db, settings, c);
  const band = calc.healthBand(health);
  const tone = band === "Green" ? "green" : band === "Yellow" ? "yellow" : band === "Red" ? "red" : "slate";

  const TABS = [["overview", "Overview"], ["meetings", "Meeting Notes"], ["kpis", "KPIs"], ["updates", "Updates"], ["tasks", "Priorities"], ["loop", "Follow-up Loop"]];

  return (
    <Drawer open={!!clientId} onClose={onClose} title={c.client_name} onEdit={onEdit}>
      <div style={{ padding: "0 0 24px", margin: -20 }}>
        {/* header band */}
        <div style={{ padding: "0 20px 14px", borderBottom: `1px solid ${C.line2}` }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <HealthBadge health={health} label="health" />
            <Pill tone={tone}>{band}</Pill>
            <Pill tone="slate">{fmtMoney(calc.agencyRevenue(c))}/mo</Pill>
            {calc.kpiStale(db, settings, c) && <Pill tone="yellow" dot>KPI stale</Pill>}
            {calc.touchOverdue(c) && <Pill tone="red" dot>Touch overdue</Pill>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
            {TABS.map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)}
                style={{ padding: "6px 11px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
                  background: tab === k ? C.ink : C.chip, color: tab === k ? "#fff" : C.charcoal }}>{l}</button>
            ))}
          </div>
        </div>

        <div style={{ padding: 20 }}>
          {tab === "overview" && <ClientOverview c={c} health={health} kpis={kpis} db={db} settings={settings} go={go} onClose={onClose} />}
          {tab === "meetings" && <MeetingNotes c={c} meetings={meetings} add={add} update={update} remove={remove} />}
          {tab === "kpis" && <ClientKpis c={c} kpis={kpis} add={add} remove={remove} settings={settings} />}
          {tab === "updates" && <ClientUpdates c={c} updates={updates} add={add} remove={remove} />}
          {tab === "tasks" && <ClientPriorities c={c} tasks={openTasks} go={go} onClose={onClose} update={update} />}
          {tab === "loop" && <FollowUpLoop c={c} update={update} add={add} />}
        </div>
      </div>
    </Drawer>
  );
}

function ClientOverview({ c, health, kpis, db, settings, go, onClose }) {
  const k = kpis[0];
  const trend = calc.kpiTrend(db, c.id);
  const renewalD = daysUntil(c.renewal_date);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10 }}>
        <Stat label="ROAS (latest)" value={k ? fmtX(k.roas) : "—"} tone={k && c.roas_target && num(k.roas) >= num(c.roas_target) ? "green" : k ? "yellow" : null} />
        <Stat label="ROAS target" value={c.roas_target ? fmtX(c.roas_target) : "—"} />
        <Stat label="Trend" value={trend == null ? "—" : (trend > 0 ? "▲ " : trend < 0 ? "▼ " : "→ ") + fmtX(Math.abs(trend))} tone={trend > 0 ? "green" : trend < 0 ? "red" : null} />
        <Stat label="Ad spend" value={fmtMoney(c.ad_spend)} />
        <Stat label="Revenue/mo" value={fmtMoney(calc.agencyRevenue(c))} />
        <Stat label="Days to renewal" value={renewalD == null ? "—" : renewalD + "d"} tone={renewalD != null && renewalD < 30 ? "yellow" : null} />
      </div>
      {c.current_objective && <Detail label="Current objective" value={c.current_objective} />}
      <HealthBreakdown c={c} db={db} settings={settings} health={health} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn size="sm" onClick={() => { onClose(); go("tasks"); }}>View tasks</Btn>
        <Btn size="sm" onClick={() => { onClose(); go("reports", c.id); }}>Generate report</Btn>
      </div>
    </div>
  );
}

function HealthBreakdown({ c, db, settings, health }) {
  const w = settings.health;
  const k = calc.latestKpi(db, c.id);
  const dst = calc.daysSinceTouch(c);
  const rows = [
    ["ROAS vs target", w.roas, k && c.roas_target ? `${fmtX(k.roas)} / ${fmtX(c.roas_target)}` : "no data"],
    ["Touch recency", w.touch, dst == null ? "no data" : `${dst}d ago (cadence ${num(settings.touchCadenceDays)}d)`],
    ["Deliverables load", w.deliverables, `${num(c.open_deliverables_count)} open · ${num(c.blocked_items_count)} blocked`],
    ["ROAS trend", w.trend, calc.kpiTrend(db, c.id) == null ? "need 2+ logs" : "tracked"],
    ["Gut feel", w.gut, `${num(c.health_score)}/100`],
  ];
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: C.mute }}>Health breakdown</span>
        <HealthBadge health={health} />
      </div>
      {rows.map(([label, weight, detail]) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", fontSize: 12.5 }}>
          <span style={{ color: C.charcoal }}>{label} <span style={{ color: C.mute }}>· {weight}%</span></span>
          <span style={{ color: C.mute }}>{detail}</span>
        </div>
      ))}
    </div>
  );
}

function MeetingNotes({ c, meetings, add, remove }) {
  const { settings } = useStore();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [f, set] = useForm({ date: todayStr(), type: "Weekly Sync", attendees: "", summary: "", decisions: "", action_items: "" });
  const save = () => { if (!f.summary.trim()) return; add("meetings", { ...f, client_id: c.id }); setF0(); setAdding(false); toast("Meeting note saved", "success"); };
  const setF0 = () => { set("date")(todayStr()); set("summary")(""); set("decisions")(""); set("action_items")(""); set("attendees")(""); };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{meetings.length} meeting{meetings.length === 1 ? "" : "s"}</span>
        <Btn size="sm" variant="solid" onClick={() => setAdding(!adding)}>{adding ? "Close" : "+ Log meeting"}</Btn>
      </div>
      {adding && (
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <FormGrid>
            <Field label="Date"><Text type="date" value={f.date} onChange={set("date")} /></Field>
            <Field label="Type"><Select value={f.type} onChange={set("type")} options={settings.meetingTypes} allowEmpty={false} /></Field>
            <Field label="Attendees" span={2}><Text value={f.attendees} onChange={set("attendees")} placeholder="Who was on the call" /></Field>
            <Field label="Summary" span={2}><Area value={f.summary} onChange={set("summary")} placeholder="What was discussed" /></Field>
            <Field label="Decisions" span={2}><Area value={f.decisions} onChange={set("decisions")} placeholder="What was decided" /></Field>
            <Field label="Action items" span={2}><Area value={f.action_items} onChange={set("action_items")} placeholder="Who does what next" /></Field>
          </FormGrid>
          <InlineActions onCancel={() => setAdding(false)} onSave={save} label="Save meeting" />
        </div>
      )}
      {meetings.length === 0 && !adding ? <Empty title="No meeting notes yet" hint="Log your first client call." />
        : meetings.map((m) => (
          <div key={m.id} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}><Pill tone="blue">{m.type}</Pill><span style={{ fontSize: 12, color: C.mute }}>{fmtDate(m.date)}</span></div>
              <button onClick={() => remove("meetings", m.id)} style={{ border: "none", background: "none", color: C.mute, cursor: "pointer", fontSize: 16 }}>×</button>
            </div>
            {m.attendees && <div style={{ fontSize: 12, color: C.mute, marginBottom: 6 }}>With: {m.attendees}</div>}
            {m.summary && <Detail label="Summary" value={m.summary} />}
            {m.decisions && <Detail label="Decisions" value={m.decisions} />}
            {m.action_items && <Detail label="Action items" value={m.action_items} />}
          </div>
        ))}
    </div>
  );
}

function ClientKpis({ c, kpis, add, remove, settings }) {
  const toast = useToast();
  const [f, set] = useForm({ date: todayStr(), roas: "", spend: "", revenue: "", cpa: "", notes: "" });
  const save = () => { if (f.roas === "" && f.spend === "") return; add("kpis", { ...f, client_id: c.id, roas_target: c.roas_target }); set("roas")(""); set("spend")(""); set("revenue")(""); set("cpa")(""); set("notes")(""); toast("KPI logged", "success"); };
  const series = [...kpis].reverse();
  return (
    <div>
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5, color: C.mute }}>Log snapshot (every ~72h)</div>
        <FormGrid>
          <Field label="Date"><Text type="date" value={f.date} onChange={set("date")} /></Field>
          <Field label="ROAS"><Text type="number" value={f.roas} onChange={set("roas")} placeholder={c.roas_target ? `target ${c.roas_target}` : "0.0"} /></Field>
          <Field label="Spend (period)"><Text type="number" value={f.spend} onChange={set("spend")} placeholder="0" /></Field>
          <Field label="Revenue"><Text type="number" value={f.revenue} onChange={set("revenue")} placeholder="0" /></Field>
          <Field label="CPA"><Text type="number" value={f.cpa} onChange={set("cpa")} placeholder="0" /></Field>
          <Field label="Notes" span={1}><Text value={f.notes} onChange={set("notes")} placeholder="context" /></Field>
        </FormGrid>
        <InlineActions onCancel={() => { set("roas")(""); set("spend")(""); }} onSave={save} label="Log KPI" />
      </div>
      {series.length >= 2 && (
        <Card title="ROAS over time" style={{ marginBottom: 14 }}>
          <RoasSpark points={series} target={num(c.roas_target)} />
        </Card>
      )}
      {kpis.length === 0 ? <Empty title="No KPIs logged yet" hint="Log ROAS/spend to track performance and drive health." />
        : kpis.map((k) => {
          const hit = c.roas_target && num(k.roas) >= num(c.roas_target);
          return (
            <div key={k.id} style={{ display: "flex", alignItems: "center", gap: 12, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: C.mute, width: 70 }}>{fmtDate(k.date)}</span>
              <span className="os-num" style={{ fontWeight: 700, color: hit ? C.green : C.ink }}>{fmtX(k.roas)}</span>
              <span className="os-num" style={{ fontSize: 12, color: C.mute }}>{k.spend ? fmtMoney(k.spend) : ""}</span>
              <span style={{ flex: 1, fontSize: 12, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.notes}</span>
              <button onClick={() => remove("kpis", k.id)} style={{ border: "none", background: "none", color: C.mute, cursor: "pointer", fontSize: 15 }}>×</button>
            </div>
          );
        })}
    </div>
  );
}

function RoasSpark({ points, target }) {
  const vals = points.map((p) => num(p.roas));
  const max = Math.max(target || 0, ...vals, 1) * 1.15;
  const W = 280, H = 70, n = vals.length;
  const x = (i) => n <= 1 ? 0 : (i / (n - 1)) * W;
  const y = (v) => H - (v / max) * H;
  const path = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 80 }}>
      {target ? <line x1="0" y1={y(target)} x2={W} y2={y(target)} stroke={C.green} strokeDasharray="4 4" strokeWidth="1" /> : null}
      <path d={path} fill="none" stroke={C.ink} strokeWidth="2" />
      {vals.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={target && v >= target ? C.green : C.ink} />)}
    </svg>
  );
}

function ClientUpdates({ c, updates, add, remove }) {
  const [text, setText] = useState("");
  const save = () => { if (!text.trim()) return; add("updates", { client_id: c.id, content: text.trim() }); setText(""); };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an ongoing update…" onKeyDown={(e) => e.key === "Enter" && save()} style={{ ...inS, flex: 1 }} />
        <Btn variant="solid" onClick={save}>Post</Btn>
      </div>
      {updates.length === 0 ? <Empty title="No updates yet" hint="Track ongoing progress and context here." />
        : <div style={{ position: "relative" }}>
          {updates.map((u) => (
            <div key={u.id} style={{ display: "flex", gap: 10, paddingBottom: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: C.ink, marginTop: 4 }} />
                <span style={{ flex: 1, width: 2, background: C.line2 }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13 }}>{u.content}</div>
                <div style={{ fontSize: 11, color: C.mute, marginTop: 3 }}>{fmtDateTime(u.created_at)}</div>
              </div>
              <button onClick={() => remove("updates", u.id)} style={{ border: "none", background: "none", color: C.mute, cursor: "pointer", fontSize: 15 }}>×</button>
            </div>
          ))}
        </div>}
    </div>
  );
}

function ClientPriorities({ c, tasks, go, onClose, update }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: C.mute, marginBottom: 10 }}>Open work for {c.client_name}, ranked by impact × urgency.</div>
      {tasks.length === 0 ? <Empty title="No open priorities" hint="Add tasks linked to this client." action={<Btn size="sm" variant="solid" onClick={() => { onClose(); go("tasks"); }}>Go to tasks</Btn>} />
        : tasks.map((t, i) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
            <RankDot n={i + 1} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 3, alignItems: "center" }}><PrioBadge value={t.priority} /><StatusPill value={t.status} /><span className="os-num" style={{ fontSize: 11, color: C.mute }}>Score {calc.taskScore(t)}</span></div>
            </div>
            <Btn size="sm" onClick={() => update("tasks", t.id, { status: "Done", completed_date: todayStr() })}>Done</Btn>
          </div>
        ))}
    </div>
  );
}

function FollowUpLoop({ c, update, add }) {
  const toast = useToast();
  const [f, set] = useForm({ last_completed_summary: c.last_completed_summary || "", next_steps: c.next_steps || "", next_client_touch: c.next_client_touch || "" });
  const saveLoop = () => { update("clients", c.id, { last_completed_summary: f.last_completed_summary, next_steps: f.next_steps, next_client_touch: f.next_client_touch }); toast("Loop saved", "success"); };
  const logTouch = () => { update("clients", c.id, { last_touch_date: todayStr() }); add("updates", { client_id: c.id, content: "Client touch logged." }); toast("Touch logged today", "success"); };
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 12.5, color: C.mute }}>The loop: summarize what you completed → define next steps → schedule the follow-up that guides the client.</div>
      <Field label="① Completed work summary"><Area value={f.last_completed_summary} onChange={set("last_completed_summary")} placeholder="What did you just deliver for them?" /></Field>
      <Field label="② Next steps"><Area value={f.next_steps} onChange={set("next_steps")} placeholder="What happens next — and how you'll guide them" /></Field>
      <Field label="③ Next client touch date"><Text type="date" value={f.next_client_touch} onChange={set("next_client_touch")} /></Field>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn variant="solid" onClick={saveLoop}>Save loop</Btn>
        <Btn onClick={logTouch}>Log touch today</Btn>
      </div>
    </div>
  );
}

/* ============================== REPORTS ================================= */
function ReportsPage({ focusId }) {
  const { db, settings, add, remove } = useStore();
  const { go } = useNav();
  const toast = useToast();
  const [clientId, setClientId] = useState(focusId || "");
  const [kind, setKind] = useState("BOW"); // BOW | EOW
  const rel = useRel();
  useEffect(() => { if (focusId) setClientId(focusId); }, [focusId]);
  const c = db.clients.find((x) => x.id === clientId);

  const generate = () => {
    if (!c) { toast("Pick a client first", "warn"); return; }
    const k = calc.latestKpi(db, c.id);
    const openTasks = db.tasks.filter((t) => t.related_client === c.id && !["Done", "Killed"].includes(t.status));
    const doneTasks = db.tasks.filter((t) => t.related_client === c.id && t.status === "Done");
    const body = buildReport(kind, c, k, openTasks, doneTasks, settings);
    add("reports", { client_id: c.id, kind, title: `${kind === "BOW" ? "Beginning-of-Week" : "End-of-Week"} · ${c.client_name} · ${fmtDate(todayStr())}`, body });
    toast("Report generated", "success");
  };

  const reports = db.reports.filter((r) => !clientId || r.client_id === clientId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return (
    <div>
      <PageHead title="Client Reports" sub="Beginning-of-week & end-of-week client updates" />
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ minWidth: 200, flex: 1 }}><Field label="Client"><RelSelect value={clientId} onChange={setClientId} options={rel.clientOpts} placeholder="Choose client" /></Field></div>
          <div><Field label="Report"><Select value={kind} onChange={setKind} options={["BOW", "EOW"]} allowEmpty={false} /></Field></div>
          <Btn variant="solid" onClick={generate}>Generate</Btn>
        </div>
        <div style={{ fontSize: 11.5, color: C.mute, marginTop: 8 }}>BOW = beginning-of-week plan · EOW = end-of-week recap. Pulls live tasks + latest KPIs.</div>
      </Card>

      {reports.length === 0 ? <Empty title="No reports yet" hint="Pick a client and generate a weekly update." />
        : reports.map((r) => (
          <Card key={r.id} style={{ marginBottom: 12 }} title={r.title}
            right={<div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" onClick={() => { if (navigator.clipboard) { navigator.clipboard.writeText(r.body); toast("Copied to clipboard", "success"); } }}>Copy</Btn>
              <Btn size="sm" variant="danger" onClick={() => remove("reports", r.id)}>Delete</Btn>
            </div>}>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55, margin: 0, color: C.charcoal }}>{r.body}</pre>
          </Card>
        ))}
    </div>
  );
}

function buildReport(kind, c, k, openTasks, doneTasks, settings) {
  const L = [];
  const head = kind === "BOW" ? "Beginning-of-Week Update" : "End-of-Week Update";
  L.push(`${head} — ${c.client_name}`);
  L.push(fmtDate(todayStr()));
  L.push("");
  if (kind === "EOW") {
    L.push("✓ What we shipped this week");
    if (doneTasks.length) doneTasks.slice(0, 8).forEach((t) => L.push(`  • ${t.title}`));
    else L.push("  • (add completed work)");
    L.push("");
    L.push("📊 Performance");
    L.push(k ? `  • ROAS ${fmtX(k.roas)}${c.roas_target ? ` (target ${fmtX(c.roas_target)})` : ""}${k.spend ? ` · spend ${fmtMoney(k.spend)}` : ""}` : "  • (log latest KPIs)");
    if (c.last_completed_summary) { L.push(""); L.push("📝 Summary"); L.push(`  ${c.last_completed_summary}`); }
    L.push("");
    L.push("→ Next steps");
    L.push(c.next_steps ? `  ${c.next_steps}` : "  • (define next steps)");
  } else {
    L.push("🎯 Focus this week");
    L.push(c.current_objective ? `  ${c.current_objective}` : "  • (set objective)");
    L.push("");
    L.push("📋 Priorities");
    if (openTasks.length) openTasks.slice(0, 6).forEach((t) => L.push(`  • ${t.title}`));
    else L.push("  • (add priorities)");
    L.push("");
    L.push("📊 Where we stand");
    L.push(k ? `  • ROAS ${fmtX(k.roas)}${c.roas_target ? ` (target ${fmtX(c.roas_target)})` : ""}` : "  • (log latest KPIs)");
    if (c.next_steps) { L.push(""); L.push("→ Planned next steps"); L.push(`  ${c.next_steps}`); }
  }
  L.push("");
  L.push("— Dean · DTC Paid Ads");
  return L.join("\n");
}
/* ============================================================================
   PART 10 — APP SHELL: NavProvider · Sidebar · TopBar · GlobalSearch ·
   QuickAdd · Router · Root App
============================================================================ */

/* ------------------------------ NavProvider ------------------------------ */
function NavProvider({ children }) {
  const [page, setPage] = useState("ceo");
  const [focusId, setFocusId] = useState(null);
  const [pageView, setPageView] = useState(null); // optional initial sub-view (e.g. pipeline)
  const go = (p, id = null, view = null) => { setPage(p); setFocusId(id); setPageView(view); };
  return <NavCtx.Provider value={{ page, focusId, pageView, go }}>{children}</NavCtx.Provider>;
}

/* ------------------------------ Sidebar ---------------------------------- */
function Sidebar({ open, onClose }) {
  const { page, go } = useNav();
  const item = (id) => {
    const active = page === id;
    return (
      <button key={id} onClick={() => { go(id); onClose && onClose(); }}
        style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
          padding: "8px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer",
          background: active ? C.ink : "transparent", color: active ? "#fff" : C.charcoal,
          fontSize: 13.5, fontWeight: active ? 600 : 500, transition: "background .12s,color .12s",
        }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.chip; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
        <span style={{ width: 16, textAlign: "center", fontSize: 13, opacity: active ? 1 : 0.7 }}>{iconOf(id)}</span>
        <span>{labelOf(id)}</span>
      </button>
    );
  };
  return (
    <>
      <div className="os-sidebar" data-open={open ? "1" : "0"}
        style={{
          width: 244, flexShrink: 0, borderRight: `1px solid ${C.line}`, background: C.panel,
          height: "100vh", position: "sticky", top: 0, display: "flex", flexDirection: "column",
          overflowY: "auto",
        }}>
        <div style={{ padding: "18px 16px 12px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 7, background: C.ink, color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 14, letterSpacing: -0.5 }}>D</div>
            <div style={{ lineHeight: 1.15 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, letterSpacing: -0.2 }}>DTC Paid Ads</div>
              <div style={{ fontSize: 10.5, color: C.mute, textTransform: "uppercase", letterSpacing: 0.8 }}>CEO Operating System</div>
            </div>
          </div>
        </div>
        <nav style={{ padding: "10px 10px 24px", display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV_GROUPS.map(([group, ids]) => (
            <div key={group} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: 1, padding: "6px 12px 4px" }}>{group}</div>
              {ids.map(item)}
            </div>
          ))}
        </nav>
      </div>
      {open && <div onClick={onClose} className="os-scrim" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 40 }} />}
    </>
  );
}

/* ---------------------------- Global Search ------------------------------ */
function GlobalSearch() {
  const { db } = useStore();
  const { go } = useNav();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const ql = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!ql) return [];
    const hit = (s) => (s || "").toLowerCase().includes(ql);
    const out = [];
    db.clients.forEach((c) => hit(c.client_name) || hit(c.primary_contact_name) ? out.push({ t: "Client", label: c.client_name, page: "clients", id: c.id }) : null);
    db.leads.forEach((l) => hit(l.lead_name) || hit(l.company_name) ? out.push({ t: "Lead", label: l.lead_name || l.company_name, page: "leads", id: l.id }) : null);
    db.tasks.forEach((t) => hit(t.title) ? out.push({ t: "Task", label: t.title, page: "tasks", id: t.id }) : null);
    db.projects.forEach((p) => hit(p.name) ? out.push({ t: "Project", label: p.name, page: "projects", id: p.id }) : null);
    db.journal.forEach((j) => hit(j.title) || hit(j.content) ? out.push({ t: "Journal", label: j.title || "(entry)", page: "journal", id: j.id }) : null);
    db.vision.forEach((v) => hit(v.title) ? out.push({ t: "Vision", label: v.title, page: "vision", id: v.id }) : null);
    db.notes.forEach((n) => hit(n.content) ? out.push({ t: "Note", label: (n.content || "").slice(0, 40), page: "journal", id: null }) : null);
    db.meetings.forEach((mt) => hit(mt.summary) || hit(mt.decisions) || hit(mt.action_items) ? out.push({ t: "Meeting", label: mt.summary ? mt.summary.slice(0, 40) : "(meeting)", page: "clients", id: mt.client_id }) : null);
    db.inbox.forEach((it) => !it.triaged && hit(it.content) ? out.push({ t: "Inbox", label: (it.content || "").slice(0, 40), page: "inbox", id: null }) : null);
    return out.slice(0, 12);
  }, [ql, db]);

  return (
    <div ref={ref} className="os-search" style={{ position: "relative", flex: 1, maxWidth: 460 }}>
      <SearchInput value={q} onChange={(v) => { setQ(v); setOpen(true); }} placeholder="Search clients, leads, tasks, projects, journal…" onFocus={() => setOpen(true)} />
      {open && ql && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: C.sh3, zIndex: 60, overflow: "hidden", maxHeight: 380, overflowY: "auto" }} className="os-pop">
          {results.length === 0 ? (
            <div style={{ padding: "14px 14px", fontSize: 13, color: C.mute }}>No matches.</div>
          ) : results.map((r, i) => (
            <button key={i} onClick={() => { go(r.page, r.id); setOpen(false); setQ(""); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "9px 14px", border: "none", borderBottom: `1px solid ${C.line2}`, background: "#fff", cursor: "pointer", fontSize: 13 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.chip)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: 0.5, width: 56, flexShrink: 0 }}>{r.t}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Quick Add -------------------------------- */
const QUICK_ADD = [
  ["task", "New Task", { coll: "tasks" }],
  ["radar", "New Radar Item", { coll: "tasks", initial: { task_type: "Radar" } }],
  ["action", "New Action Item", { coll: "tasks", initial: { task_type: "Action Item" } }],
  ["project", "New Project", { coll: "projects" }],
  ["client", "New Client", { coll: "clients" }],
  ["lead", "New Lead", { coll: "leads" }],
  ["journal", "New Journal Entry", { coll: "journal" }],
  ["vision", "New Vision Item", { coll: "vision" }],
  ["team", "New Team Member", { coll: "team" }],
  ["note", "New Note", { coll: "notes" }],
];

function QuickAddForm({ coll, initial, onSubmit, onClose }) {
  if (coll === "tasks") return <TaskForm initial={initial} onSubmit={onSubmit} onClose={onClose} />;
  if (coll === "projects") return <ProjectForm initial={initial} onSubmit={onSubmit} onClose={onClose} />;
  if (coll === "clients") return <ClientForm initial={initial} onSubmit={onSubmit} onClose={onClose} />;
  if (coll === "leads") return <LeadForm initial={initial} onSubmit={onSubmit} onClose={onClose} />;
  if (coll === "team") return <TeamForm initial={initial} onSubmit={onSubmit} onClose={onClose} />;
  if (coll === "journal") return <JournalForm initial={initial} onSubmit={onSubmit} onClose={onClose} />;
  if (coll === "vision") return <VisionForm initial={initial} onSubmit={onSubmit} onClose={onClose} />;
  if (coll === "note") return <NoteForm initial={initial} onSubmit={onSubmit} onClose={onClose} />;
  return null;
}

function NoteForm({ initial, onSubmit, onClose }) {
  const rel = useRel();
  const [f, set] = useForm({ content: "", related_client: "", related_project: "", ...initial });
  const submit = (e) => { e.preventDefault(); if (!f.content.trim()) return; onSubmit(f); };
  return (
    <form onSubmit={submit}>
      <FormGrid>
        <Field label="Note" span={2}><Area value={f.content} onChange={set("content")} autoFocus placeholder="Write a quick note…" rows={5} /></Field>
        <Field label="Related Client"><RelSelect value={f.related_client} onChange={set("related_client")} options={rel.clientOpts} /></Field>
        <Field label="Related Project"><RelSelect value={f.related_project} onChange={set("related_project")} options={rel.projectOpts} /></Field>
      </FormGrid>
      <FormActions onCancel={onClose} submitLabel="Save note" />
    </form>
  );
}

function QuickAddMenu() {
  const { add } = useStore();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const [form, setForm] = useState(null); // {coll, initial, title}
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setMenu(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const pick = (label, cfg) => { setMenu(false); setForm({ ...cfg, title: label }); };
  const save = (v) => { add(form.coll, v); toast(`${form.title.replace(/^New /, "")} created`, "success"); setForm(null); };
  return (
    <>
      <div ref={ref} style={{ position: "relative" }}>
        <Btn variant="solid" onClick={() => setMenu((m) => !m)}>+ Quick Add</Btn>
        {menu && (
          <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: C.sh3, zIndex: 60, overflow: "hidden", width: 210, padding: 6 }} className="os-pop">
            {QUICK_ADD.map(([k, label, cfg]) => (
              <button key={k} onClick={() => pick(label, cfg)}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", borderRadius: 7, background: "#fff", cursor: "pointer", fontSize: 13, color: C.charcoal }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.chip)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}>{label}</button>
            ))}
          </div>
        )}
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.title} wide>
        {form && <QuickAddForm coll={form.coll} initial={form.initial} onSubmit={save} onClose={() => setForm(null)} />}
      </Modal>
    </>
  );
}

/* ----------------------------- Notifications ----------------------------- */
function NotificationsBell() {
  const d = useDerived();
  const { go } = useNav();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const alerts = [];
  if (d.overdueTasks.length) alerts.push([`${d.overdueTasks.length} overdue task${d.overdueTasks.length > 1 ? "s" : ""}`, "tasks", C.red]);
  if (d.overdueFollowups.length) alerts.push([`${d.overdueFollowups.length} overdue follow-up${d.overdueFollowups.length > 1 ? "s" : ""}`, "leads", C.red]);
  if (d.overdueTouches.length) alerts.push([`${d.overdueTouches.length} overdue client touch${d.overdueTouches.length > 1 ? "es" : ""}`, "clients", C.yellow]);
  if (d.atRiskClients.length) alerts.push([`${d.atRiskClients.length} client${d.atRiskClients.length > 1 ? "s" : ""} at risk`, "clients", C.red]);
  if (d.staleKpiClients.length) alerts.push([`${d.staleKpiClients.length} client${d.staleKpiClients.length > 1 ? "s" : ""} need KPI update`, "clients", C.yellow]);
  if (d.criticalOpen.length) alerts.push([`${d.criticalOpen.length} open critical task${d.criticalOpen.length > 1 ? "s" : ""}`, "tasks", C.red]);
  if (d.overloaded.length) alerts.push([`${d.overloaded.length} overloaded team member${d.overloaded.length > 1 ? "s" : ""}`, "team", C.yellow]);
  const n = alerts.length;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} title="Alerts"
        style={{ position: "relative", width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.line}`, background: "#fff", cursor: "pointer", fontSize: 15, color: C.charcoal, display: "grid", placeItems: "center" }}>
        ◔
        {n > 0 && <span style={{ position: "absolute", top: -5, right: -5, minWidth: 17, height: 17, padding: "0 4px", borderRadius: 9, background: C.red, color: "#fff", fontSize: 10.5, fontWeight: 700, display: "grid", placeItems: "center" }}>{n}</span>}
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 280, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: C.sh3, zIndex: 60, overflow: "hidden" }} className="os-pop">
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: C.mute }}>Alerts</div>
          {n === 0 ? (
            <div style={{ padding: "16px 14px", fontSize: 13, color: C.mute }}>Nothing needs attention. You're clear.</div>
          ) : alerts.map(([label, page, color], i) => (
            <button key={i} onClick={() => { go(page); setOpen(false); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "10px 14px", border: "none", borderBottom: `1px solid ${C.line2}`, background: "#fff", cursor: "pointer", fontSize: 13 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.chip)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: color, flexShrink: 0 }} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Top Bar --------------------------------- */
function TopBar({ onMenu }) {
  const { settings, setSettings } = useStore();
  const [cadence, setCadence] = useState("Daily");
  const [date, setDate] = useState(todayStr());
  return (
    <div className="os-topbar" style={{ position: "sticky", top: 0, zIndex: 30, background: "rgba(255,255,255,.86)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.line}`, padding: "10px 18px", display: "flex", alignItems: "center", gap: 12 }}>
      <button className="os-menu-btn os-tap" onClick={onMenu} title="Menu" aria-label="Open menu"
        style={{ display: "none", width: 38, height: 38, borderRadius: 8, border: `1px solid ${C.line}`, background: "#fff", cursor: "pointer", fontSize: 17, flexShrink: 0 }}>≡</button>
      <GlobalSearch />
      <div style={{ flex: 1 }} />
      <div className="os-topbar-controls" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input className="os-date" type="date" value={date} onChange={(e) => setDate(e.target.value)}
          style={{ height: 36, border: `1px solid ${C.line}`, borderRadius: 8, padding: "0 10px", fontSize: 13, color: C.charcoal, background: "#fff", fontFamily: "inherit" }} />
        <span className="os-cadence"><MiniSelect value={cadence} onChange={setCadence} options={settings.cadences} /></span>
        <NotificationsBell />
        <QuickAddMenu />
        <div className="os-profile" style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 6 }}>
          <div style={{ width: 32, height: 32, borderRadius: 16, background: C.ink, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 13 }}>CEO</div>
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Router ---------------------------------- */
function Router() {
  const { page, focusId, pageView } = useNav();
  switch (page) {
    case "ceo": return <CEODashboard />;
    case "daily": return <DailyDashboard />;
    case "weekly": return <WeeklyDashboard />;
    case "monthly": return <MonthlyDashboard />;
    case "quarterly": return <QuarterlyDashboard />;
    case "yearly": return <YearlyDashboard />;
    case "calendar": return <CalendarPage />;
    case "tasks": return <TasksPage focusId={focusId} />;
    case "projects": return <ProjectsPage focusId={focusId} />;
    case "leads": return <LeadsPage focusId={focusId} initialView={pageView} />;
    case "pipeline": return <LeadsPage initialView="board" />;
    case "clients": return <ClientsPage focusId={focusId} />;
    case "pm": return <PMPage />;
    case "money": return <MoneyPage />;
    case "reports": return <ReportsPage focusId={focusId} />;
    case "inbox": return <InboxPage />;
    case "team": return <TeamPage />;
    case "journal": return <JournalPage focusId={focusId} />;
    case "vision": return <VisionPage focusId={focusId} />;
    case "settings": return <SettingsPage />;
    default: return <CEODashboard />;
  }
}

/* -------------------------------- App ------------------------------------ */
function OperatingSystem() {
  const [sidebar, setSidebar] = useState(false);
  useEffect(() => {
    document.body.style.overflow = sidebar ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [sidebar]);
  return (
    <StoreProvider>
      <ToastHost>
        <NavProvider>
        <GlobalStyle />
        <div style={{ display: "flex", minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" }}>
          <Sidebar open={sidebar} onClose={() => setSidebar(false)} />
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <TopBar onMenu={() => setSidebar(true)} />
            <main className="os-main" style={{ flex: 1, padding: "22px 26px 64px", maxWidth: 1440, width: "100%", margin: "0 auto" }}>
              <Router />
            </main>
          </div>
        </div>
      </NavProvider>
      </ToastHost>
    </StoreProvider>
  );
}

export default function App() {
  return (
    <AuthGate>
      <OperatingSystem />
    </AuthGate>
  );
}
