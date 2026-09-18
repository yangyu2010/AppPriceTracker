/**
 * 定价看板生成（方案第 7 节）。
 *
 * 读 data/pricing/current.json + points + daily rollup，
 * 生成 public/pricing.html（内嵌全部档位序列，前端切换纯本地重绘）。
 *
 * 用法：node src/price-dashboard.js
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { PRICING_DIR, COUNTRY_NAMES, beijingDateOf, beijingStr, esc, alignSlot } from "./pricing-util.js";
import { loadPointsRange, loadCrawlsRange, loadDaily } from "./price-store.js";

const PUBLIC_DIR = "public";

/**
 * 档位定义。
 * source: "points"（4h 槽原始点）/ "daily"（北京日日聚合 close_price）
 */
const RANGES = [
  { key: "1d", label: "今天", days: 2, source: "points" },
  { key: "3d", label: "3天", days: 4, source: "points" },
  { key: "1w", label: "1周", days: 8, source: "points" },
  { key: "1m", label: "1月", days: 31, source: "daily" },
  { key: "3m", label: "3月", days: 92, source: "daily" },
];

function isoDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** 列出 from~to 覆盖的所有 "YYYY-MM"。 */
function monthList(fromDate, toDate) {
  const months = [];
  const [fy, fm] = fromDate.split("-").map(Number);
  const [ty, tm] = toDate.split("-").map(Number);
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

/** 生成 [start, end] 之间所有 4h 槽起点（UTC），end 为当前对齐槽。 */
function slotRange(fromDate, toDate) {
  const slots = [];
  const end = new Date(toDate + "T23:59:59Z").getTime();
  let cur = new Date(fromDate + "T00:00:00Z").getTime();
  while (cur <= end) {
    slots.push(new Date(cur).toISOString().replace(".000Z", "Z"));
    cur += 4 * 3600 * 1000;
  }
  return slots;
}

const SLOT_MS = 4 * 3600 * 1000;

function slotStart(ts) {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  const h = Math.floor(d.getUTCHours() / 4) * 4;
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

async function buildHistory(current) {
  const nowSlot = alignSlot();
  const nowBj = beijingDateOf(nowSlot);

  // meta：图标回退（读 pricing 专用 meta，键 app_id|country）
  let metaByKey = new Map();
  try {
    const meta = JSON.parse(await readFile(join(PRICING_DIR, "meta/apps.json"), "utf-8"));
    metaByKey = new Map(Object.entries(meta.apps || {}));
  } catch {}

  // points / crawls：覆盖最长 points 档（8 天）
  const points = await loadPointsRange(isoDay(-8), isoDay(0));
  const crawls = await loadCrawlsRange(isoDay(-8), isoDay(0));

  // daily：覆盖 3 个月
  const daily = await loadDaily(monthList(isoDay(-91), isoDay(0)));

  // ---- 索引 ----
  // points by `${app_id}|${country}|${item_key}|${slot}`，取槽内最后一个
  const pointBySlot = new Map();
  for (const p of points) {
    const key = `${p.app_id}|${p.country}|${p.item_key}|${slotStart(p.ts)}`;
    pointBySlot.set(key, p); // 追加顺序即时间顺序，最后一个覆盖
  }
  // crawls by `${app_id}|${country}|${slot}` → status（product page / lookup）
  const crawlStatusBySlot = new Map();
  for (const c of crawls) {
    const key = `${c.app_id}|${c.country}|${slotStart(c.ts)}`;
    crawlStatusBySlot.set(key, c.status); // 同槽 lookup + store_page 两条，store_page 后写覆盖
  }
  // daily by `${app_id}|${country}|${item_key}` → Map<date_beijing, row>
  const dailyByKey = new Map();
  for (const d of daily) {
    const key = `${d.app_id}|${d.country}|${d.item_key}`;
    if (!dailyByKey.has(key)) dailyByKey.set(key, new Map());
    dailyByKey.get(key).set(d.date_beijing, d);
  }

  // 当前 app 键集合（app_id|country → app 条目）
  const appKeyOf = (app) => `${app.app_id}|${app.country}`;
  const apps = current.apps.map((app) => {
    const k = appKeyOf(app);
    const meta = metaByKey.get(k);
    return {
      k,
      app_id: String(app.app_id),
      name: app.name,
      platform: app.platform,
      pricing: app.pricing,
      country: app.country,
      ccName: COUNTRY_NAMES[app.country] || app.country.toUpperCase(),
      icon: meta?.artwork_url || "",
      status: app.status,
      suspect: !!app.suspect,
      locale_fallback: !!app.locale_fallback,
      error: app.error || "",
      items: (app.items || []).map((it) => ({
        item_key: it.item_key,
        name: it.name,
        price: it.price,
        currency: it.currency,
        formatted_price: it.formatted_price,
        delta: it.delta,
      })),
    };
  });

  // 每个 app 的 item_key 全集（含上轮出现过但本轮没有的：从 daily/points 反推）
  // 注意：只存裸 item_key，app 维度由外层 app 循环负责；
  // 若带 app 前缀存进来，下方 fullKey 会双重拼接且 point 匹配永远失败 → 0 series。
  const knownItemKeys = new Set(); // 裸 item_key
  for (const app of current.apps) {
    for (const it of app.items || []) knownItemKeys.add(it.item_key);
  }
  // 近 8 天 points 里出现过的 item_key 也收进来（消失条目的 icon/name 从 points 拿）
  for (const p of points) knownItemKeys.add(p.item_key);
  for (const d of daily) knownItemKeys.add(d.item_key);

  // ---- 序列 ----
  const series = {}; // `${appKey}|${itemKey}@${rangeKey}` → { labels, values, gaps }
  const itemMeta = {}; // `${appKey}|${itemKey}` → { name, currency, kind, last }

  for (const range of RANGES) {
    const fromDate = isoDay(-(range.days - 1));
    const buckets = range.source === "points" ? slotRange(fromDate, isoDay(0)) : beijingDates(fromDate, isoDay(0));
    const N = buckets.length;

    for (const app of current.apps) {
      const ak = appKeyOf(app);
      const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

      for (const itemKey of knownItemKeys) {
        // itemKey 为裸 key，加上 app 前缀构成全局唯一 series key
        const fullKey = `${ak}|${itemKey}`;

        const values = new Array(N).fill(null);
        const gaps = new Array(N).fill(0); // 0=无观测不画，1=有值，2=采集但未列出，3=采集失败

        if (range.source === "points") {
          for (const p of points) {
            if (String(p.app_id) !== String(app.app_id) || p.country !== app.country || p.item_key !== itemKey) continue;
            const bi = bucketIndex.get(slotStart(p.ts));
            if (bi === undefined) continue;
            values[bi] = p.price;
            gaps[bi] = 1;
          }
          // 补 gap 状态：槽内有 crawl 但无该 item 的点
          for (let i = 0; i < N; i++) {
            if (gaps[i] === 1) continue;
            const st = crawlStatusBySlot.get(`${app.app_id}|${app.country}|${buckets[i]}`);
            if (st === "ok" || st === "no_iap") gaps[i] = 2;
            else if (st === "error" || st === "unavailable") gaps[i] = 3;
            // st === undefined → 未来槽/无采集，保持 0
          }
          // 未来槽（> nowSlot）清空
          for (let i = 0; i < N; i++) {
            if (buckets[i] > nowSlot) {
              values[i] = null;
              gaps[i] = 0;
            }
          }
        } else {
          const dayMap = dailyByKey.get(`${app.app_id}|${app.country}|${itemKey}`) || new Map();
          for (let i = 0; i < N; i++) {
            const row = dayMap.get(buckets[i]);
            if (row) {
              values[i] = row.close_price;
              gaps[i] = 1;
            }
          }
        }

        // 跳过整条无数据 & 无任何观测的
        const hasAny = values.some((v) => v !== null && v !== undefined);
        if (!hasAny) continue;

        // 记录 item meta（名字/货币取最近出现）
        const lastPoint = [...points].reverse().find(
          (p) => String(p.app_id) === String(app.app_id) && p.country === app.country && p.item_key === itemKey
        );
        const lastDaily = [...(dailyByKey.get(`${app.app_id}|${app.country}|${itemKey}`) || new Map()).values()].pop();
        itemMeta[fullKey] = {
          name: lastPoint?.name || lastDaily?.name || itemKey,
          currency: lastPoint?.currency || lastDaily?.currency || "",
          item_kind: lastPoint?.item_kind || lastDaily?.item_kind || "iap",
        };

        series[`${fullKey}@${range.key}`] = {
          labels: buckets,
          values: values.map((v) => (v === null || v === undefined ? null : v)),
          gaps,
        };
      }
    }
  }

  console.log(
    `[dashboard] history: ${Object.keys(series).length} series, ${apps.length} apps, ${knownItemKeys.size} item keys`
  );
  return { apps, series, itemMeta };
}

/** 生成 from~to（含 from）之间的北京日期列表。 */
function beijingDates(fromDate, toDate) {
  const out = [];
  const start = new Date(fromDate + "T00:00:00Z");
  const end = new Date(toDate + "T00:00:00Z");
  const cur = new Date(start);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  let current;
  try {
    current = JSON.parse(await readFile(join(PRICING_DIR, "current.json"), "utf-8"));
  } catch {
    console.error("[dashboard] current.json 不存在，先跑 node src/price-crawl.js --once");
    process.exit(1);
  }

  const history = await buildHistory(current);
  const html = generateHtml(current, history);
  if (!existsSync(PUBLIC_DIR)) await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(join(PUBLIC_DIR, "pricing.html"), html, "utf-8");
  console.log("[dashboard] public/pricing.html generated");
}

function generateHtml(current, history) {
  const { data_ts, generated_at, display_timezone } = current;
  const data = {
    ts: data_ts,
    generated_at,
    tz: display_timezone,
    apps: history.apps,
    itemMeta: history.itemMeta,
    series: history.series,
    ranges: RANGES.map((r) => ({ key: r.key, label: r.label, source: r.source })),
  };
  const chartDataJson = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const countryFlag = {
    us: "🇺🇸", jp: "🇯🇵", cn: "🇨🇳", gb: "🇬🇧", de: "🇩🇪", fr: "🇫🇷", ca: "🇨🇦",
    au: "🇦🇺", in: "🇮🇳", br: "🇧🇷", nz: "🇳🇿", nl: "🇳🇱", pt: "🇵🇹", se: "🇸🇪",
    ch: "🇨🇭", es: "🇪🇸", tw: "🇹🇼", mx: "🇲🇽", it: "🇮🇹", be: "🇧🇪", hk: "🇭🇰",
    sg: "🇸🇬", za: "🇿🇦",
  };

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>App Store 定价监控</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"><\/script>
<style>
:root{
  color-scheme:light;
  --surface-1:#fcfcfb; --plane:#f9f9f7;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#2a78d6; --good-ink:#006300; --bad-ink:#b02a2a; --lim-ink:#9c4f22;
  --critical:#d03b3b; --serious:#ec835a;
  --chip-good-bg:rgba(12,163,12,.10); --chip-bad-bg:rgba(208,59,59,.10);
  --wash:rgba(11,11,11,.04);
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --surface-1:#1a1a19; --plane:#0d0d0d;
  --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --series-1:#3987e5; --good-ink:#0ca30c; --bad-ink:#e66767; --lim-ink:#ec835a;
  --critical:#d03b3b; --serious:#ec835a;
  --chip-good-bg:rgba(12,163,12,.16); --chip-bad-bg:rgba(208,59,59,.18);
  --wash:rgba(255,255,255,.05);
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:var(--plane);color:var(--ink);padding:24px 32px;-webkit-font-smoothing:antialiased}
h1{font-size:22px;margin-bottom:4px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:12px;margin-bottom:20px}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.themebtn{border:1px solid var(--border);background:var(--surface-1);color:var(--ink-2);
  border-radius:7px;padding:6px 11px;font-size:12px;cursor:pointer;font-family:inherit}

/* ---- App 卡片 ---- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-bottom:24px}
.app-card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;
  padding:14px 16px;cursor:pointer;transition:box-shadow .15s,border-color .15s;position:relative}
.app-card:hover{box-shadow:0 3px 10px var(--border);border-color:var(--axis)}
.app-card .row1{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.app-card img{width:44px;height:44px;border-radius:9px;background:var(--wash);object-fit:cover;flex:0 0 auto}
.app-card .aname{font-size:15px;font-weight:600;line-height:1.25}
.app-card .ameta{font-size:11px;color:var(--muted);margin-top:2px}
.badge{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:6px;
  background:var(--wash);color:var(--ink-2);margin-right:4px;vertical-align:middle}
.badge.paid{color:var(--lim-ink)}
.badge.free{color:var(--good-ink);background:var(--chip-good-bg)}
.badge.flag{font-size:11px;padding:1px 5px}
.badge.warn{color:var(--critical);background:var(--chip-bad-bg)}
.summary{font-size:13px;margin-top:6px}
.summary .cur{font-weight:700;font-size:16px}
.delta-up{color:var(--good-ink);font-size:12px;font-weight:600}
.delta-dn{color:var(--bad-ink);font-size:12px;font-weight:600}
.delta-flat{color:var(--muted);font-size:12px}
.status-err{color:var(--bad-ink);font-size:12px;margin-top:4px}
.status-unav{color:var(--muted);font-size:12px;margin-top:4px}

/* ---- 详情 ---- */
.detail{display:none;background:var(--surface-1);border:1px solid var(--border);border-radius:12px;
  padding:18px 20px;margin-bottom:20px}
.detail.open{display:block}
.detail h2{font-size:17px;margin-bottom:4px}
.detail .dmeta{font-size:12px;color:var(--muted);margin-bottom:12px}
.filters{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:8px}
.fgroup{display:flex;align-items:center;gap:8px}
.flabel{font-size:12px;color:var(--muted)}
select{padding:6px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;
  background:var(--surface-1);color:var(--ink);max-width:340px}
.seg{display:inline-flex;background:var(--wash);border-radius:8px;padding:2px;gap:2px}
.seg button{border:0;background:transparent;color:var(--ink-2);font-size:13px;
  padding:5px 11px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap}
.seg button:hover{color:var(--ink)}
.seg button[aria-pressed="true"]{background:var(--surface-1);color:var(--ink);font-weight:600;
  box-shadow:0 1px 2px var(--border)}
.chart-box{width:100%;height:340px;position:relative}
.empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  text-align:center;color:var(--muted);font-size:13px;line-height:1.7;padding:0 24px}
.empty.on{display:flex}

/* ---- 内购表 ---- */
table.iap{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 4px}
table.iap th,table.iap td{padding:7px 9px;text-align:left;border-bottom:1px solid var(--border)}
table.iap th{background:var(--wash);font-weight:600;color:var(--muted);font-size:11px}
table.iap tbody tr{cursor:pointer}
table.iap tbody tr:hover{background:var(--wash)}
table.iap tbody tr.sel{background:var(--wash);box-shadow:inset 3px 0 0 var(--series-1)}
.num{font-variant-numeric:tabular-nums;font-weight:600}
.muted{color:var(--muted)}
.leg{display:flex;gap:14px;font-size:12px;color:var(--ink-2);margin-top:8px;flex-wrap:wrap}
.leg-item{display:flex;align-items:center;gap:5px}
.leg-mark{width:11px;height:11px;display:inline-block;flex:0 0 auto;border-radius:2px}
.leg-line{width:16px;height:3px;border-radius:2px;display:inline-block}
.navlink{font-size:13px;color:var(--series-1);text-decoration:none;margin-bottom:12px;display:inline-block}
.navlink:hover{text-decoration:underline}
@media (max-width:720px){body{padding:16px}.chart-box{height:280px}}
</style></head><body>
<div class="top">
<div>
<h1>App Store 定价监控</h1>
<p class="sub">数据时间: ${beijingStr(data_ts)} · 生成: ${beijingStr(generated_at)} · 时区: ${esc(display_timezone)}（显示为北京时间） · 点击卡片查看走势</p>
</div>
<button class="themebtn" id="theme" type="button">切换主题</button>
</div>

<div class="grid" id="grid"></div>
<div class="detail" id="detail"></div>

<script>
const D = ${chartDataJson};
const $ = (id) => document.getElementById(id);
const ccFlag = ${JSON.stringify(countryFlag)};

const GAP_NAME = { 2:'未列出', 3:'采集失败' };

// ---- 主题 ----
(function(){try{var t=localStorage.getItem('pt-theme');
if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
$('theme').addEventListener('click',()=>{
  const next=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',next);
  try{localStorage.setItem('pt-theme',next);}catch(e){}
  renderChart();
});

function tokens(){
  const cs=getComputedStyle(document.documentElement);
  const g=n=>cs.getPropertyValue(n).trim();
  return {series:g('--series-1'),muted:g('--muted'),grid:g('--grid'),axis:g('--axis'),
    ink:g('--ink'),ink2:g('--ink-2'),surface:g('--surface-1'),critical:g('--critical'),serious:g('--serious')};
}

// UTC ISO → 北京时间 Date
function bjDate(iso){
  if(!iso) return null;
  const d=new Date(iso);
  if(isNaN(d.getTime())) return null;
  d.setUTCHours(d.getUTCHours()+8);
  return d;
}
function fmtFull(iso){
  const d=bjDate(iso); if(!d) return '—';
  return (d.getUTCMonth()+1)+'月'+d.getUTCDate()+'日 '+String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');
}
function fmtDay(iso){
  const d=bjDate(iso); if(!d) return '—';
  return (d.getUTCMonth()+1)+'月'+d.getUTCDate()+'日';
}
function fmtTick(iso,source){
  const d=bjDate(iso); if(!d) return '';
  if(source==='daily') return String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
  const md=String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
  return md+' '+String(d.getUTCHours()).padStart(2,'0')+':00';
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtPrice(v,cur){
  if(v===null||v===undefined) return '—';
  const num=Number(v);
  if(!isFinite(num)) return String(v);
  if(cur==='JPY') return '¥'+num.toLocaleString('en-US',{maximumFractionDigits:0});
  return num.toLocaleString('en-US',{minimumFractionDigits:num%1?2:0,maximumFractionDigits:2});
}
function curFor(app,itemKey){
  const meta=D.itemMeta[app.k+'|'+itemKey];
  return meta&&meta.currency?meta.currency:'';
}
function deltaChip(delta){
  if(delta===null||delta===undefined) return '<span class="delta-flat">新</span>';
  if(delta===0) return '<span class="delta-flat">持平</span>';
  if(delta>0) return '<span class="delta-dn">&uarr; +'+delta.toLocaleString('en-US',{maximumFractionDigits:2})+'</span>';
  return '<span class="delta-up">&darr; '+Math.abs(delta).toLocaleString('en-US',{maximumFractionDigits:2})+'</span>';
}

// ---- 卡片 ----
function priceSummary(app){
  if(app.status==='unavailable') return '<div class="status-unav">该店无此 App</div>';
  if(app.status==='error') return '<div class="status-err">采集失败'+(app.error?'：'+esc(app.error):'')+'</div>';
  if(app.status==='no_iap') return '<div class="summary"><span class="cur">免费</span> <span class="muted">· 无内购</span></div>';
  if(app.pricing==='paid'){
    const it=app.items[0];
    if(!it) return '<div class="status-err">无价格数据</div>';
    return '<div class="summary"><span class="cur">'+esc(it.formatted_price||fmtPrice(it.price,it.currency))+'</span> '+deltaChip(it.delta)+'</div>';
  }
  // free
  const prices=app.items.map(i=>Number(i.price)).filter(v=>isFinite(v));
  const min=prices.length?Math.min(...prices):null;
  const max=prices.length?Math.max(...prices):null;
  const cur=app.items[0]?curFor(app,app.items[0].item_key):'';
  const rangeStr=(min!==null&&max!==null)?(min===max?fmtPrice(min,cur):fmtPrice(min,cur)+' ~ '+fmtPrice(max,cur)):'—';
  const changed=app.items.some(i=>i.delta!==null&&i.delta!==0);
  return '<div class="summary"><span class="cur">'+app.items.length+'</span> 项内购 · '+rangeStr
    +(changed?' <span class="delta-dn">有变动</span>':' <span class="delta-flat">无变动</span>')+'</div>';
}

const grid=$('grid');
D.apps.forEach((app)=>{
  const card=document.createElement('div');
  card.className='app-card';
  card.dataset.k=app.k;
  const flag=(ccFlag[app.country]||'')+' '+esc(app.ccName)+' ('+app.country.toUpperCase()+')';
  const pbadge=app.pricing==='paid'?'<span class="badge paid">付费</span>':'<span class="badge free">免费·内购</span>';
  const warn=app.suspect?'<span class="badge warn">待核对</span>':(app.locale_fallback?'<span class="badge warn">非英文</span>':'');
  card.innerHTML='<div class="row1">'+(app.icon?'<img src="'+esc(app.icon)+'" width="44" height="44" alt="" loading="lazy" onerror="this.remove()">':'<div style="width:44px;height:44px"></div>')
    +'<div><div class="aname">'+esc(app.name)+'</div>'
    +'<div class="ameta">'+pbadge+'<span class="badge flag">'+flag+'</span><span class="badge">'+esc(app.platform||'')+'</span>'+warn+'</div></div></div>'
    +priceSummary(app);
  grid.appendChild(card);
});

// ---- 详情 ----
let selApp=null, selItem=null, curRange='1d', chart=null;
const detailEl=$('detail');

function openDetail(app){
  selApp=app;
  selItem=app.pricing==='free'&&app.items.length?app.items[0].item_key:null;
  if(app.pricing==='paid') selItem='__app__';
  const flag=(ccFlag[app.country]||'')+' '+esc(app.ccName)+' ('+app.country.toUpperCase()+')';
  const warn=app.suspect?'<span class="badge warn">待核对</span>':(app.locale_fallback?'<span class="badge warn">非英文（该店无英文本地化）</span>':'');
  const statusMap={ok:'正常',error:'采集失败',unavailable:'该店无此 App',no_iap:'免费·无内购'};
  let h='<h2>'+esc(app.name)+' <span class="badge flag">'+flag+'</span>'+(app.pricing==='paid'?'<span class="badge paid">付费</span>':'<span class="badge free">免费·内购</span>')+warn+'</h2>';
  h+='<div class="dmeta">状态：'+(statusMap[app.status]||app.status)+(app.error?'（'+esc(app.error)+'）':'')+'</div>';

  // 付费：当前价行
  if(app.pricing==='paid'){
    const it=app.items[0];
    if(it){
      h+='<div class="summary" style="margin-bottom:12px">当前价 <span class="cur">'+esc(it.formatted_price||fmtPrice(it.price,it.currency))+'</span> '+deltaChip(it.delta)+'</div>';
    }
  } else {
    // 免费：内购表
    h+='<table class="iap"><thead><tr><th>项目</th><th>当前价</th><th>Δ 上轮</th><th>相对 7 天</th></tr></thead><tbody>';
    // 7 天前的价格：取 1w 序列第一个有值点
    for(const it of app.items){
      const wk=D.series[app.k+'|'+it.item_key+'@1w'];
      let prev7='—';
      if(wk){
        const vals=wk.values;
        let first=null;
        for(let i=vals.length-1;i>=0;i--){ if(vals[i]!==null) first=vals[i]; }
        const firstIdx=vals.findIndex(v=>v!==null);
        if(firstIdx>=0){ const last=vals[vals.length-1]; if(last!==null&&first!==null){ const chg=last-first; prev7=(chg===0?'持平':(chg>0?'+'+chg.toLocaleString('en-US',{maximumFractionDigits:2}):chg.toLocaleString('en-US',{maximumFractionDigits:2}))); } }
      }
      const delta=it.delta;
      h+='<tr data-item="'+esc(it.item_key)+'"'+(selItem===it.item_key?' class="sel"':'')+'>'
        +'<td>'+esc(it.name)+'</td>'
        +'<td class="num">'+esc(it.formatted_price||fmtPrice(it.price,it.currency))+'</td>'
        +'<td>'+(delta===null?'<span class="muted">新</span>':(delta===0?'<span class="muted">—</span>':deltaChip(delta)))+'</td>'
        +'<td class="muted">'+prev7+'</td></tr>';
    }
    h+='</tbody></table>';
  }

  h+='<div class="filters"><div class="fgroup"><span class="flabel">时间范围</span><div class="seg" id="ranges"></div></div></div>';
  h+='<div class="chart-box"><div id="cb" style="width:100%;height:100%"></div><div class="empty" id="empty"></div></div>';
  h+='<div class="leg" id="leg"></div>';
  detailEl.innerHTML=h;
  detailEl.classList.add('open');
  detailEl.scrollIntoView({behavior:'smooth',block:'start'});

  // 范围按钮
  const seg=$('ranges');
  D.ranges.forEach(r=>{
    const b=document.createElement('button');
    b.type='button'; b.textContent=r.label; b.dataset.k=r.key;
    b.setAttribute('aria-pressed',String(r.key===curRange));
    b.addEventListener('click',()=>{curRange=r.key;[...seg.children].forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.k===curRange)));renderChart();});
    seg.appendChild(b);
  });
  // 免费：表行点击选 item
  detailEl.querySelectorAll('table.iap tbody tr').forEach(tr=>{
    tr.addEventListener('click',()=>{
      selItem=tr.dataset.item;
      detailEl.querySelectorAll('table.iap tbody tr').forEach(x=>x.classList.toggle('sel',x===tr));
      renderChart();
    });
  });

  // ECharts 从 CDN 加载；加载失败时给出提示而不是抛错导致后续脚本中断
  if(typeof echarts==='undefined'){
    const cb=$('cb');
    if(cb) cb.innerHTML='<div class="empty on"><div>图表库（ECharts）加载失败——请检查网络后刷新，或确认可访问 cdn.jsdelivr.net。</div></div>';
    return;
  }
  if(!chart) chart=echarts.init($('cb'),null,{renderer:'canvas'});
  window.addEventListener('resize',()=>chart.resize());
  renderChart();
}

function renderChart(){
  if(!selApp) return;
  const T=tokens();
  const emptyEl=$('empty');
  if(!emptyEl) return;
  const itemKey=selApp.pricing==='paid'?'__app__':selItem;
  const s=D.series[selApp.k+'|'+itemKey+'@'+curRange];
  const range=D.ranges.find(r=>r.key===curRange);
  if(!s){
    chart.clear();
    emptyEl.classList.add('on');
    emptyEl.textContent=range.label+' 在此区间没有该'+(selApp.pricing==='paid'?'App':'内购项')+'的采集记录。';
    $('leg').innerHTML='';
    return;
  }
  emptyEl.classList.remove('on');
  const labels=s.labels, vals=s.values, gaps=s.gaps;
  const cur=curFor(selApp,itemKey);
  const name=(D.itemMeta[selApp.k+'|'+itemKey]||{}).name||itemKey;

  // 折线数据：null 断开
  const data=vals.map((v,i)=>v===null?null:v);
  // gap 标记点：未列出 / 采集失败（放在价格数据范围外，避免遮挡曲线）
  const priceVals=vals.filter(v=>v!==null&&v!==undefined);
  const minV=priceVals.length?Math.min(...priceVals):0;
  const maxV=priceVals.length?Math.max(...priceVals):1;
  const span=(maxV-minV)||1;
  const yLo=minV-span*0.35;
  const yHi=maxV+span*0.15;
  const gapPts={2:[],3:[]};
  for(let i=0;i<gaps.length;i++){ if(gaps[i]===2) gapPts[2].push([i,yLo]); else if(gaps[i]===3) gapPts[3].push([i,yLo]); }

  const opt={
    animationDuration:260,
    grid:{top:26,right:50,bottom:34,left:56},
    tooltip:{trigger:'axis',axisPointer:{type:'line',snap:true,lineStyle:{color:T.axis,width:1,type:'solid'}},
      backgroundColor:T.surface,borderColor:T.grid,borderWidth:1,padding:[8,10],
      textStyle:{color:T.ink,fontSize:12},extraCssText:'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.13)',
      formatter:(ps)=>{
        const i=ps[0].dataIndex;
        const v=vals[i];
        const label=range.source==='daily'?fmtDay(labels[i]):fmtFull(labels[i]);
        let h='<div style="font-weight:600;margin-bottom:4px">'+label+' 北京时间</div>';
        if(v!==null&&v!==undefined) h+='<div style="font-size:15px;font-weight:700">'+fmtPrice(v,cur)+'</div>';
        else if(gaps[i]===2) h+='<div style="font-size:13px;color:'+T.muted+'">未列出</div>';
        else if(gaps[i]===3) h+='<div style="font-size:13px;color:'+T.critical+'">采集失败</div>';
        else h+='<div style="color:'+T.muted+'">无采集记录</div>';
        return h;
      }},
    xAxis:{type:'category',data:labels,boundaryGap:false,
      axisLine:{lineStyle:{color:T.axis,width:1}},axisTick:{show:false},
      axisLabel:{color:T.muted,fontSize:11,hideOverlap:true,formatter:v=>fmtTick(v,range.source)},
      splitLine:{show:false}},
    yAxis:{type:'value',scale:true,min:yLo,max:yHi,
      axisLine:{show:false},axisTick:{show:false},axisLabel:{color:T.muted,fontSize:11},
      splitLine:{lineStyle:{color:T.grid,width:1,type:'solid'}}},
    series:[
      {name:name,type:'line',z:3,data:data,connectNulls:false,showSymbol:vals.length<=90,
        symbol:'circle',symbolSize:5,lineStyle:{width:2,color:T.series},
        itemStyle:{color:T.series,borderWidth:2,borderColor:T.surface},emphasis:{scale:1.3}},
      {name:'未列出',type:'scatter',z:5,symbol:'diamond',symbolSize:10,
        itemStyle:{color:T.serious,borderWidth:1.5,borderColor:T.surface},
        data:gapPts[2],
        tooltip:{formatter:(p)=>{const i=p.dataIndex;return fmtFull(labels[i])+' 北京时间<br/><b>未列出</b>';}}},
      {name:'采集失败',type:'scatter',z:5,symbol:'cross',symbolSize:11,
        itemStyle:{color:T.critical,borderWidth:1.5,borderColor:T.surface},
        data:gapPts[3],
        tooltip:{formatter:(p)=>{const i=p.dataIndex;return fmtFull(labels[i])+' 北京时间<br/><b>采集失败</b>';}}},
    ],
  };
  chart.setOption(opt,true);
  renderLeg(T,gapPts,range);
}

function renderLeg(T,gapPts,range){
  const items=['<div class="leg-item"><span class="leg-line" style="background:'+T.series+'"></span>价格走势</div>'];
  if(gapPts[2].length) items.push('<div class="leg-item" style="color:var(--muted)"><span class="leg-mark" style="background:'+T.serious+';transform:rotate(45deg)"></span>未列出</div>');
  if(gapPts[3].length) items.push('<div class="leg-item" style="color:var(--muted)"><span class="leg-mark" style="background:'+T.critical+';border-radius:50%"></span>采集失败</div>');
  const leg=$('leg'); if(leg) leg.innerHTML=items.join('');
}

grid.addEventListener('click',(e)=>{
  const card=e.target.closest('.app-card');
  if(!card) return;
  const app=D.apps.find(a=>a.k===card.dataset.k);
  if(app) openDetail(app);
});

// 默认打开第一个有数据的 App
if(D.apps.length) openDetail(D.apps[0]);

window.addEventListener('resize',()=>{ if(chart) chart.resize(); });
<\/script></body></html>`;
}

main().catch((err) => { console.error("[dashboard]", err); process.exit(1); });