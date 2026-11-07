// 見積もり計算（DOM に依存しない純粋関数だけを置く）

/** 計算ルールの初期値（ダミー）。本番の値は settings シート（Seed.gs で投入）で上書きする */
export const DEFAULT_RULES = {
  parentAreaKm2: 200, // 親機 1 台あたりの面積
  relayAreaKm2: 20, // 中継機 1 台あたりの面積
  rangeLowPct: -10, // 概算表示の下限
  rangeHighPct: 20, // 概算表示の上限
  laborPerUnit: 100000, // 現地調査・設置工事：人件費（1 台あたり）
  travelPer5Units: 100000, // 往復交通費（5 台ごと）
  vehiclePerUnit: 10000, // 車両費（1 台あたり）
  fuelPerUnit: 1000, // 燃料費（1 台あたり）
  lodgingPerUnit: 10000, // 宿泊費（（台数 − 1）あたり）
  overheadPct: 10, // 諸経費（%）
  specialPerDay: 100000, // 特殊技術対策費（1 日あたり）
  setupFeePerUnit: 1000, // 初期設定費（1 台あたり）
  contractFee: 1000, // 契約事務手数料
  maintenancePct: 10, // 保守費（機器合計に対する % / 年）
  chatsPerRouter: 4, // GeoChat 何台ごとに GeoChat Router 1 台
};

export const GROUP_ORDER = ['基地局', '子機', 'オプション', 'センサー'];

export const BASE_TYPES = [
  { key: 'multi', label: '多用途利用' },
  { key: 'std', label: '限られた用途に利用' },
];

export function rules(settings = {}) {
  const out = { ...DEFAULT_RULES };
  for (const k of Object.keys(DEFAULT_RULES)) {
    if (settings[k] !== undefined && settings[k] !== '' && Number.isFinite(Number(settings[k]))) out[k] = Number(settings[k]);
  }
  return out;
}

/** 面積(km²)から親機・中継機の提案台数を出す */
export function suggestCounts(areaKm2, settings = {}) {
  const area = Number(areaKm2);
  if (!(area > 0)) return { parent: 0, relay: 0 };
  const r = rules(settings);
  const perParent = r.parentAreaKm2 > 0 ? r.parentAreaKm2 : DEFAULT_RULES.parentAreaKm2;
  const perRelay = r.relayAreaKm2 > 0 ? r.relayAreaKm2 : DEFAULT_RULES.relayAreaKm2;
  return {
    parent: Math.max(1, Math.ceil(round6(area / perParent))),
    relay: Math.max(1, Math.ceil(round6(area / perRelay))),
  };
}

/** GeoChat の台数から GeoChat Router の台数（chatsPerRouter 台ごとに 1 台、端数切り上げ） */
export function routersFor(chatQty, settings = {}) {
  const per = rules(settings).chatsPerRouter || DEFAULT_RULES.chatsPerRouter;
  const n = Math.max(0, Number(chatQty) || 0);
  return Math.ceil(n / per);
}

// 浮動小数の誤差で 600/30 が 20.000000001 になって切り上がるのを防ぐ
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** 品目マスタを表示順に並べ、使える形に整える（整形済みを渡しても崩れない） */
export function normalizeItems(items = []) {
  return items
    .filter((it) => it && it.key && toBool(it.active, true))
    .map((it, i) => ({
      key: String(it.key),
      name: String(it.name || it.key),
      group: String(it.group || 'その他'),
      baseType: String(it.baseType || ''),
      role: String(it.role || ''),
      price: toNumber(it.price),
      cloudYearly: toNumber(it.cloudYearly),
      unit: String(it.unit || '台'),
      countSetup: toBool(it.countSetup, true),
      countInstall: toBool(it.countInstall, false),
      sort: it.sort === '' || it.sort == null ? i : toNumber(it.sort),
    }))
    .sort((a, b) => a.sort - b.sort);
}

/** 見積もりの初期状態 */
export function initEstimateState() {
  return {
    skipped: false,
    mode: 'area', // area=エリア整備 / spot=スポット利用
    baseType: 'multi', // multi=多用途利用 / std=限られた用途に利用
    areaKm2: '',
    qty: { parent: 0, relay: 0, router: 0 },
    solarOff: {},
    vital: { on: false, model: '', qty: 0 },
    specialDays: { install: 0, survey: 0 },
    maintenanceOff: true, // true=保守費を計上しない（初期は「なし」）
    display: 'summary', // summary=概算 / detail=詳細
  };
}

/** 品目ごとの数量（役割のある品目は連動ルールで決まる） */
export function qtyFor(item, state, items) {
  const q = state.qty || {};
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  if (item.group === '基地局' && item.baseType && item.baseType !== state.baseType) return 0;
  switch (item.role) {
    case 'parent': return n(q.parent);
    case 'relay': return n(q.relay);
    case 'relaySolar': return state.solarOff?.[item.key] ? 0 : n(q.relay);
    case 'connectSolar': {
      const connect = items.find((x) => x.role === 'connect');
      return state.solarOff?.[item.key] || !connect ? 0 : n(q[connect.key]);
    }
    case 'router': return n(q.router);
    case 'vital': return state.vital?.on && state.vital.model === item.key ? n(state.vital.qty) : 0;
    default: return n(q[item.key]);
  }
}

/** 設置工事・現地調査の金額と内訳 */
export function workCost(units, days, settings = {}) {
  const r = rules(settings);
  const N = Math.max(0, Math.floor(Number(units) || 0));
  const D = Math.max(0, Math.floor(Number(days) || 0));
  if (N === 0 && D === 0) return { total: 0, breakdown: [] };
  const trips = N > 0 ? Math.ceil(N / 5) : 0;
  const parts = [
    { label: '人件費', calc: `${yen(r.laborPerUnit)} × ${N}台`, amount: N * r.laborPerUnit },
    { label: '往復交通費', calc: `${yen(r.travelPer5Units)} × ${trips}（5台ごと）`, amount: trips * r.travelPer5Units },
    { label: '車両費', calc: `${yen(r.vehiclePerUnit)} × ${N}台`, amount: N * r.vehiclePerUnit },
    { label: '燃料費', calc: `${yen(r.fuelPerUnit)} × ${N}台`, amount: N * r.fuelPerUnit },
    { label: '宿泊費', calc: `${yen(r.lodgingPerUnit)} × ${Math.max(0, N - 1)}泊`, amount: Math.max(0, N - 1) * r.lodgingPerUnit },
  ];
  const base = sum(parts.map((p) => p.amount));
  const overhead = Math.round((base * r.overheadPct) / 100);
  parts.push({ label: '諸経費', calc: `上記合計 × ${r.overheadPct}%`, amount: overhead });
  if (D > 0) parts.push({ label: '特殊技術対策費', calc: `${yen(r.specialPerDay)} × ${D}日`, amount: D * r.specialPerDay });
  return { total: base + overhead + D * r.specialPerDay, breakdown: parts.filter((p) => p.amount > 0) };
}

/** 見積もりを計算する */
export function computeEstimate(items, state, settings = {}) {
  const r = rules(settings);
  const list = normalizeItems(items).filter((it) => it.group !== '基地局' || !it.baseType || it.baseType === state.baseType);
  const lines = list.map((it) => {
    const qty = qtyFor(it, state, list);
    return { ...it, qty, subtotal: qty * it.price, cloudSubtotal: qty * it.cloudYearly };
  });
  const equipmentLines = lines.filter((l) => l.qty > 0);
  const equipmentTotal = sum(equipmentLines.map((l) => l.subtotal));
  const installUnits = sum(lines.filter((l) => l.countInstall).map((l) => l.qty));
  const setupCount = sum(lines.filter((l) => l.countSetup).map((l) => l.qty));

  const install = workCost(installUnits, state.specialDays?.install, settings);
  const survey = workCost(installUnits, state.specialDays?.survey, settings);
  const work = [
    { key: 'survey', name: '現地調査', qty: 1, unit: '式', subtotal: survey.total, breakdown: survey.breakdown },
    { key: 'install', name: '設置工事', qty: 1, unit: '式', subtotal: install.total, breakdown: install.breakdown },
    { key: 'setup', name: '初期設定費', qty: setupCount, unit: '台', price: r.setupFeePerUnit, subtotal: setupCount * r.setupFeePerUnit },
    { key: 'contract', name: '契約事務手数料', qty: 1, unit: '式', price: r.contractFee, subtotal: equipmentTotal > 0 ? r.contractFee : 0 },
  ].filter((w) => w.subtotal > 0);

  const cloudYearly = sum(lines.map((l) => l.cloudSubtotal));
  const maintenanceYearly = state.maintenanceOff ? 0 : Math.round((equipmentTotal * r.maintenancePct) / 100);
  const running = [
    { key: 'cloud', name: 'クラウド利用料', subtotal: cloudYearly, lines: equipmentLines.filter((l) => l.cloudSubtotal > 0) },
    { key: 'maintenance', name: '保守費', subtotal: maintenanceYearly, calc: `機器合計 × ${r.maintenancePct}%` },
  ].filter((x) => x.subtotal > 0);

  return {
    lines,
    equipmentLines,
    equipmentTotal,
    installUnits,
    setupCount,
    work,
    running,
    initialTotal: equipmentTotal + sum(work.map((w) => w.subtotal)),
    cloudYearly,
    maintenanceYearly,
    runningYearly: cloudYearly + maintenanceYearly,
  };
}

/** 概算モード用の幅（100 万円以上は万円単位、未満は千円単位。下限は切り捨て、上限は切り上げ） */
export function priceRange(total, settings = {}) {
  const r = rules(settings);
  if (!(total > 0)) return { low: 0, high: 0 };
  const unit = total >= 1_000_000 ? 10_000 : 1_000;
  return {
    low: Math.floor((total * (1 + r.rangeLowPct / 100)) / unit) * unit,
    high: Math.ceil((total * (1 + r.rangeHighPct / 100)) / unit) * unit,
  };
}

/** 見積もりを 1 行の要約文にする（スプレッドシート用） */
export function summarizeEstimate(result) {
  return result.equipmentLines.map((l) => `${l.name}×${l.qty}`).join('、');
}

export function formatYen(n) {
  return `${Math.round(toNumber(n)).toLocaleString('ja-JP')}円`;
}
const yen = formatYen;

/** 金額を「1,234万円」「85万円」のように読みやすく */
export function formatMan(n) {
  const v = toNumber(n);
  if (v >= 10_000) {
    const man = v / 10_000;
    const text = Number.isInteger(man) ? man.toLocaleString('ja-JP') : man.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
    return `${text}万円`;
  }
  return formatYen(v);
}

export function formatRange(range) {
  if (!range.high) return '—';
  return `約${formatMan(range.low)}〜${formatMan(range.high)}`;
}

export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[,，円¥￥\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no|いいえ)$/i.test(String(v).trim());
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}
