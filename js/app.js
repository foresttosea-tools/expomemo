import { GAS_URL } from './config.js';
import { callApi, NetworkError, ApiError } from './api.js';
import {
  suggestCounts, routersFor, normalizeItems, initEstimateState, computeEstimate, priceRange,
  formatYen, formatRange, summarizeEstimate, toNumber, rules, GROUP_ORDER, BASE_TYPES,
} from './estimate.js';
import { parseCardText, CARD_FIELDS } from './ocr-parse.js';

// ================================================================ 保存まわり

const LS = {
  conn: 'expomemo.conn',
  config: 'expomemo.config.v2',
  draft: 'expomemo.draft.v2',
  pending: 'expomemo.pending.v2',
  active: 'expomemo.lastActive',
};
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 保存できない環境でも画面は動かす */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  },
};

const CUSTOMER_KEYS = CARD_FIELDS.map((f) => f.key).concat(['cardFileId', 'cardUrl']);
const EMPTY_CUSTOMER = Object.fromEntries(CUSTOMER_KEYS.map((k) => [k, '']));
const OTHER = 'その他';

// 社内メモの項目（前回の展示会フォームと同じ並び）
const MEMO_FIELDS = [
  { key: 'industry', opt: 'industry', label: 'お客様の業種・所属区分', required: true },
  { key: 'division', opt: 'division', label: 'お客様の部署・担当分野' },
  { key: 'usages', opt: 'usage', label: '関心のある用途', multi: true },
  { key: 'products', opt: 'product', label: '関心のある製品・サービス', multi: true },
  { key: 'materials', opt: 'material', label: '資料をお渡ししたか', multi: true },
  { key: 'status', opt: 'status', label: '検討状況', required: true },
  { key: 'priority', opt: 'priority', label: '優先フォロー度', required: true },
  { key: 'subsidies', opt: 'subsidy', label: '検討している補助金・財源', multi: true },
  { key: 'timing', opt: 'timing', label: '想定している導入時期' },
  { key: 'nextActions', opt: 'nextAction', label: '次回アクション', multi: true },
];
const REQUIRED = {
  customer: [['company', 'ご所属'], ['name', 'お名前']],
  memo: [['visitDate', '来場日'], ['staff', '対応者'], ['industry', '業種・所属区分'], ['status', '検討状況'], ['priority', '優先フォロー度']],
};

const S = {
  conn: { gasUrl: GAS_URL, token: '', staff: '', ...store.get(LS.conn, {}) },
  config: store.get(LS.config, null),
  draft: store.get(LS.draft, null),
  pending: store.get(LS.pending, []),
  view: 'home',
  leads: [],
  leadsLoaded: false,
  search: '',
  lockedMessage: '',
  cardPreview: '',
  ocrBusy: false,
  staffOther: false,
  invalid: new Set(),
  admin: { token: '', tab: 'event', event: null, items: null, staff: null },
  lastRefresh: 0,
};
if (!S.conn.gasUrl) S.conn.gasUrl = GAS_URL;

const saveConn = () => store.set(LS.conn, S.conn);
const saveDraft = () => (S.draft ? store.set(LS.draft, S.draft) : store.del(LS.draft));
const savePending = () => store.set(LS.pending, S.pending);

// ================================================================ ユーティリティ

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');
const $busy = document.getElementById('busy');

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
function toast(message, kind = 'info') {
  $toast.textContent = message;
  $toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.className = 'toast'), 3500);
}

function busy(text) {
  if (text) {
    $busy.querySelector('.busy-text').textContent = text;
    $busy.hidden = false;
  } else {
    $busy.hidden = true;
  }
}

function openModal(html) {
  $toast.className = 'toast';
  $modal.innerHTML = `<div class="modal-backdrop" data-action="closeModal"></div><div class="modal-sheet" role="dialog" aria-modal="true">${html}</div>`;
  $modal.hidden = false;
  $modal.querySelector('input')?.focus();
}
function closeModal() {
  $modal.hidden = true;
  $modal.innerHTML = '';
}

function api(action, payload = {}) {
  return callApi(S.conn.gasUrl, action, payload, S.conn.token);
}
function adminApi(action, payload = {}) {
  return api(action, { ...payload, adminToken: S.admin.token });
}

function settings() {
  return S.config?.settings || {};
}
function options(type) {
  return S.config?.options?.[type] || [];
}
function items() {
  return S.config?.items || [];
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
function dayLabel(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
}
function parseYmd(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
/** 会期中の日付（来場日の選択肢）。会期が未設定なら今日だけ */
function eventDays() {
  const s = settings();
  const start = parseYmd(s.eventStart);
  const end = parseYmd(s.eventEnd);
  if (!start || !end || start > end) return [dayLabel(new Date())];
  const out = [];
  for (let d = new Date(start); d <= end && out.length < 31; d.setDate(d.getDate() + 1)) out.push(dayLabel(d));
  return out;
}
function defaultVisitDate() {
  const today = dayLabel(new Date());
  return eventDays().includes(today) ? today : '';
}

/** パスワード切れ・通信エラーの共通処理 */
function handleError(err, fallbackMessage) {
  if (err instanceof ApiError && err.code === 'unauthorized') {
    lock('パスワードが変更されたか、正しくありません。もう一度入力してください。');
    return;
  }
  if (err instanceof ApiError && err.code === 'admin_unauthorized') {
    S.admin = { token: '', tab: 'event', event: null, items: null, staff: null };
    toast('管理者パスワードが違います', 'error');
    if (S.view === 'admin') {
      S.view = 'home';
      render();
    }
    return;
  }
  if (err instanceof NetworkError) {
    toast(`${fallbackMessage}（通信できませんでした）`, 'error');
    return;
  }
  toast(`${fallbackMessage}（${err.message}）`, 'error');
}

// ================================================================ ロック（一定時間操作なし）

function touch() {
  store.set(LS.active, Date.now());
}
function checkTimeout() {
  if (!S.conn.token) return;
  const min = Number(settings().sessionTimeoutMin) || 120;
  const last = Number(store.get(LS.active, Date.now()));
  if (Date.now() - last > min * 60_000) lock('しばらく操作がなかったのでロックしました。パスワードを入力してください。');
}
function lock(message) {
  S.conn.token = '';
  saveConn();
  S.config = null;
  store.del(LS.config);
  S.admin = { token: '', tab: 'event', event: null, items: null, staff: null };
  S.lockedMessage = message || '';
  closeModal();
  busy(false);
  S.view = 'setup';
  render();
}

// ================================================================ 設定の自動更新

async function refreshConfig({ silent = true, force = false } = {}) {
  if (!S.conn.token) return;
  if (!force && Date.now() - S.lastRefresh < 30_000) return;
  S.lastRefresh = Date.now();
  try {
    const res = await api('getConfig');
    S.config = { settings: res.settings || {}, items: res.items || [], options: res.options || {} };
    store.set(LS.config, S.config);
    if (!silent) toast('最新の設定に更新しました', 'success');
    if (!['admin'].includes(S.view) && !isTyping()) render();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'unauthorized') handleError(err);
    else if (!silent) handleError(err, '設定を取得できませんでした');
  }
}

function isTyping() {
  const a = document.activeElement;
  return a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

// ================================================================ 描画

function render() {
  const active = document.activeElement;
  const focusId = active && active.id && $app.contains(active) ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  if (!S.conn.token || !S.config) S.view = 'setup';
  else if (!S.conn.staff) S.view = 'setup';
  if (['step1', 'step2', 'step3'].includes(S.view) && !S.draft) S.view = 'home';
  if (S.view === 'admin' && !S.admin.token) S.view = 'home';

  const views = { setup: viewSetup, home: viewHome, step1: viewEstimate, step2: viewCustomer, step3: viewMemo, list: viewList, admin: viewAdmin };
  $app.innerHTML = (views[S.view] || viewHome)();

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel && el.setSelectionRange && /^(text|search|tel|email|url|)$/.test(el.type || '')) {
        try {
          el.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* 選択範囲を持たない入力欄 */
        }
      }
    }
  }
}

function header(sub = '') {
  const s = settings();
  return `
  <div class="topbar">
    <header class="appbar">
      <div class="appbar-row">
        <button class="brand" data-action="goHome" aria-label="ホームへ">
          <img src="icons/logo.svg" alt="" class="brand-mark" width="28" height="28">
          <span class="brand-name">ExpoMemo</span>
        </button>
        ${S.conn.staff ? `<button class="staff-chip" data-action="changeStaff">${esc(S.conn.staff)}</button>` : ''}
      </div>
      <p class="event ${s.eventName ? '' : 'unset'}">${esc(s.eventName || '展示会未設定（管理者メニューで設定）')}</p>
    </header>
  </div>
  ${sub}`;
}

/** 項目名の横に置く「？」ボタン。押すと解説を表示する */
function helpBtn(title, text) {
  if (!text) return '';
  return `<button type="button" class="help-btn" data-action="help" data-title="${esc(title)}" data-text="${esc(text)}" aria-label="${esc(title)}の説明">?</button>`;
}

/** 計算ルールから作る解説文。概算表示では金額を伏せる */
function fixedHelp(key, isDetail) {
  const r = rules(settings());
  const y = formatYen;
  const texts = {
    area: `親機は ${r.parentAreaKm2}km² ごとに1台、中継機は ${r.relayAreaKm2}km² ごとに1台を目安に、必要な台数を自動で計算します（端数は切り上げ）。\n地形や見通しによって必要な台数は変わるため、＋/−で調整してください。`,
    vital: '基本は GeoChat と同じ台数を自動で入力します。台数は手動でも変更できますが、GeoChat の台数を変えると再計算されます。',
    work: isDetail
      ? `現地調査と設置工事は、対象台数（親機・中継機・GeoConnect）をもとに、それぞれ次のように計算します。目安は1台1日です。\n\n・人件費：${y(r.laborPerUnit)} × 台数\n・往復交通費：5台ごとに ${y(r.travelPer5Units)}\n・車両費：${y(r.vehiclePerUnit)} × 台数\n・燃料費：${y(r.fuelPerUnit)} × 台数\n・宿泊費：${y(r.lodgingPerUnit)} ×（台数 − 1）\n・諸経費：上記合計の ${r.overheadPct}%\n・特殊技術対策費：${y(r.specialPerDay)} × 日数（諸経費の対象外）\n\nセンサーと GeoChat Router は対象台数に含めません。`
      : '現地調査と設置工事は、対象台数（親機・中継機・GeoConnect）をもとに、人件費・交通費・車両費・燃料費・宿泊費・諸経費をそれぞれ計算しています。目安は1台1日です。',
    special: isDetail
      ? `通常の作業に加えて、特別な技術的対策が必要になる場合に、その日数を入力します。1日あたり ${y(r.specialPerDay)} で、諸経費の対象外です。`
      : '通常の作業に加えて、特別な技術的対策が必要になる場合に、その日数を入力します。',
    maintenance: `機器（親機・中継機・子機・オプション・ソーラーバッテリー・センサー）の合計金額の ${r.maintenancePct}% を、年額で計上します。`,
    display: '概算：品目と台数を表示し、合計金額は幅を持たせて表示します。\n詳細：単価・金額と、工事費などの内訳まで表示します。',
    setup: `お客様向けに各機器を設定する作業費です。親機・中継機・子機・オプション・センサーの台数分を計上します（ソーラーバッテリーと GeoFlash は除く）。${isDetail ? `1台あたり ${y(r.setupFeePerUnit)}。` : ''}`,
    contract: '初回のご契約時にのみかかる事務手数料です。',
    cloud: '親機・中継機・子機ごとに定められたクラウド利用料（年額）の合計です。',
  };
  texts.survey = texts.work;
  texts.install = texts.work;
  return texts[key] || '';
}

/** 自動計算・連動のある品目だけに付ける解説 */
function roleHelp(it) {
  const r = rules(settings());
  switch (it.role) {
    case 'relaySolar': return '中継機と同じ台数を自動で計上します。商用電源が使える場所では、スイッチで外せます。';
    case 'connectSolar': return 'GeoConnect と同じ台数を自動で計上します。商用電源が使える場所では、スイッチで外せます。';
    case 'router': return `GeoChat ${r.chatsPerRouter}台ごとに1台（端数は切り上げ）を自動で入力します。台数は手動でも変更できますが、GeoChat の台数を変えると再計算されます。`;
    default: return '';
  }
}

function reqMark(required) {
  return required ? '<b class="req" aria-label="必須">必須</b>' : '';
}
function invalidClass(key) {
  return S.invalid.has(key) ? 'invalid' : '';
}

// ---------------------------------------------------------------- 初回設定 / ロック解除 / 担当者選択

function viewSetup() {
  const connected = S.conn.token && S.config;
  if (connected) {
    const staff = options('staff');
    const isOther = S.staffOther || (S.conn.staff && !staff.includes(S.conn.staff));
    return `
    ${header()}
    <main class="page narrow">
      <h1 class="page-title">担当者を選択</h1>
      <p class="lead">選んだ名前はこの端末に記憶され、登録データの「対応者」に入ります。</p>
      <div class="choice-grid two">
        ${staff.map((n) => `<button class="choice ${n === S.conn.staff ? 'on' : ''}" data-action="pickStaff" data-value="${esc(n)}">${esc(n)}</button>`).join('')}
        <button class="choice wide ${isOther ? 'on' : ''}" data-action="staffOther">その他</button>
      </div>
      ${isOther ? `
      <form class="card form" data-submit="staffOther">
        <label class="field">
          <span>お名前</span>
          <input id="f-staff-other" name="name" type="text" autocomplete="name" value="${esc(staff.includes(S.conn.staff) ? '' : S.conn.staff)}" required>
        </label>
        <button class="btn primary block" type="submit">この名前で始める</button>
      </form>` : ''}
    </main>`;
  }
  const custom = S.conn.gasUrl !== GAS_URL;
  return `
  <main class="page narrow setup">
    <div class="setup-hero">
      <img src="icons/logo.svg" alt="" width="64" height="64">
      <h1>ExpoMemo</h1>
      <p>展示会のヒアリング・見積もり・名刺登録</p>
    </div>
    ${S.lockedMessage ? `<p class="notice warn">${esc(S.lockedMessage)}</p>` : ''}
    <form class="card form" data-submit="connect">
      <label class="field">
        <span>パスワード</span>
        <input id="f-token" name="token" type="password" autocomplete="current-password" required>
        ${S.conn.gasUrl === 'mock' ? '<small>いまは「お試しモード」です。データはこの端末の中だけに保存されます（パスワードは <b>demo</b>）。</small>' : ''}
      </label>
      <details class="advanced" ${custom ? 'open' : ''}>
        <summary>詳細設定</summary>
        <label class="field">
          <span>接続先（GAS の URL）</span>
          <input id="f-gas" name="gasUrl" type="text" inputmode="url" autocomplete="off" value="${esc(S.conn.gasUrl)}" placeholder="https://script.google.com/macros/s/.../exec" required pattern="mock|https://.*">
          <small>通常は変更不要です。</small>
        </label>
      </details>
      <button class="btn primary block" type="submit">接続する</button>
    </form>
  </main>`;
}

// ---------------------------------------------------------------- ホーム

function viewHome() {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  return `
  ${header()}
  <main class="page">
    ${pendingBanner()}
    ${S.draft ? `
      <div class="notice">
        <div><b>入力途中のデータがあります</b><br><small>${esc(draftLabel(S.draft))}</small></div>
        <div class="notice-actions">
          <button class="btn small" data-action="discardDraft">破棄</button>
          <button class="btn small primary" data-action="resumeDraft">続きから</button>
        </div>
      </div>` : ''}
    <button class="hero-btn" data-action="newLead">
      <span class="hero-icon" aria-hidden="true">＋</span>
      <span><b>新しく登録する</b><small>ヒアリング・見積もりから始める</small></span>
    </button>
    <button class="hero-btn secondary" data-action="openList">
      <span class="hero-icon" aria-hidden="true">≡</span>
      <span><b>登録一覧</b><small>検索・編集・追記</small></span>
    </button>
    <div class="home-links">
      <button class="link" data-action="reloadConfig">最新の設定に更新</button>
      <button class="link" data-action="openAdmin">管理者メニュー</button>
      <button class="link" data-action="lockNow">ロックする</button>
    </div>
    ${standalone ? '' : '<p class="tip">ブラウザのメニューから「ホーム画面に追加」すると、アプリとして使えます。</p>'}
  </main>`;
}

function draftLabel(d) {
  const c = d.customer || {};
  const who = [c.company, c.name].filter(Boolean).join(' / ');
  return `${d.id ? '編集中' : '新規'}：${who || '（お客様情報まだ）'}`;
}

function pendingBanner() {
  if (!S.pending.length) return '';
  return `
  <div class="notice error">
    <div><b>未送信のデータが ${S.pending.length} 件あります</b><br><small>電波のよい場所で再送信してください</small></div>
    <div class="notice-actions"><button class="btn small primary" data-action="retryPending">再送信</button></div>
  </div>`;
}

// ---------------------------------------------------------------- 入力ステップ共通

function stepper(current) {
  const steps = [
    ['step1', '見積もり'],
    ['step2', 'お客様情報'],
    ['step3', '社内メモ'],
  ];
  return `
  <nav class="steps" aria-label="入力ステップ">
    ${steps.map(([v, label], i) => `
      <button class="step ${v === current ? 'on' : ''}" data-action="goStep" data-value="${v}" ${v === current ? 'aria-current="step"' : ''}>
        <span class="step-no">${i + 1}</span><span class="step-label">${label}</span>
      </button>`).join('')}
  </nav>
  ${S.draft?.id ? `<p class="editing">編集中：${esc(draftLabel(S.draft).replace(/^編集中：/, ''))}</p>` : ''}`;
}

function bottomBar(left, right) {
  return `<div class="bottombar"><div class="bottombar-inner">${left}${right}</div></div>`;
}

function qtyStepper(id, label, value, action, key, extra = '') {
  const qty = Number(value) || 0;
  return `
  <span class="qty">
    <button class="qty-btn" data-action="${action}" data-key="${esc(key)}" data-delta="-1" aria-label="${esc(label)}を減らす" ${qty <= 0 ? 'disabled' : ''}>−</button>
    <input class="qty-input" id="${esc(id)}" type="text" inputmode="numeric" value="${qty}" ${extra} aria-label="${esc(label)}の数量">
    <button class="qty-btn" data-action="${action}" data-key="${esc(key)}" data-delta="1" aria-label="${esc(label)}を増やす">＋</button>
  </span>`;
}

// ---------------------------------------------------------------- STEP 1 見積もり

function viewEstimate() {
  const est = S.draft.estimate;
  const s = settings();
  if (est.skipped) {
    return `
    ${header(stepper('step1'))}
    <main class="page with-bottombar">
      <div class="card center">
        <p>見積もりはスキップしました。</p>
        <button class="btn primary" data-action="unskipEstimate">見積もりを作る</button>
      </div>
    </main>
    ${bottomBar('<button class="btn" data-action="goHome">ホーム</button>', '<button class="btn primary" data-action="goStep" data-value="step2">次へ</button>')}`;
  }

  const list = normalizeItems(items());
  const result = computeEstimate(items(), est, s);
  const lineOf = Object.fromEntries(result.lines.map((l) => [l.key, l]));
  const isDetail = est.display === 'detail';
  const auto = suggestCounts(est.areaKm2, s);
  const autoDiffers = est.mode === 'area' && auto.parent > 0 && (Number(est.qty.parent) !== auto.parent || Number(est.qty.relay) !== auto.relay);
  const groupItems = (g) => list.filter((it) => it.group === g && (g !== '基地局' || !it.baseType || it.baseType === est.baseType));
  const otherGroups = [...new Set(list.map((it) => it.group))].filter((g) => !GROUP_ORDER.includes(g));

  return `
  ${header(stepper('step1'))}
  <main class="page with-bottombar estimate">
    <section class="quote-head">
      <p class="quote-kicker">${esc(s.companyName || '')}</p>
      <h1>GEO-WAVE 概算お見積もり</h1>
      <button class="link small-link" data-action="skipEstimate">見積もりをスキップする</button>
    </section>

    <div class="segmented" role="tablist">
      <button role="tab" class="${est.mode === 'area' ? 'on' : ''}" data-action="setMode" data-value="area" aria-selected="${est.mode === 'area'}">エリア整備</button>
      <button role="tab" class="${est.mode === 'spot' ? 'on' : ''}" data-action="setMode" data-value="spot" aria-selected="${est.mode === 'spot'}">スポット利用</button>
    </div>

    ${est.mode === 'area' ? `
    <section class="card area-card">
      <label class="field" for="f-area">
        <span>整備したいエリアの面積${helpBtn('整備したいエリアの面積', fixedHelp('area', isDetail))}</span>
        <div class="area-input">
          <input id="f-area" type="text" inputmode="decimal" autocomplete="off" placeholder="例：600" value="${esc(est.areaKm2)}" data-bind="estimate.areaKm2" data-rerender="input">
          <span class="unit">km²</span>
        </div>
      </label>
      ${auto.parent > 0 ? `
        <p class="auto-result">自動算出：<b>親機 ${auto.parent}台</b>・<b>中継機 ${auto.relay}台</b></p>
        ${autoDiffers ? '<button class="btn small" data-action="resetAuto">自動算出の台数に戻す</button>' : ''}` : '<p class="hint">面積を入れると、必要な親機・中継機の台数を自動で計算します。</p>'}
    </section>` : '<p class="hint">ご利用になる場所の広さや地形に合わせて、台数を入力してください。</p>'}

    <section class="card item-group">
      <h2>基地局</h2>
      <div class="segmented small tabs" role="tablist" aria-label="基地局の種類">
        ${BASE_TYPES.map((b) => `<button role="tab" class="${est.baseType === b.key ? 'on' : ''}" data-action="setBaseType" data-value="${b.key}" aria-selected="${est.baseType === b.key}">${b.label}</button>`).join('')}
      </div>
      ${groupItems('基地局').map((it) => itemRow(it, lineOf[it.key], est, isDetail)).join('')}
    </section>

    ${['子機', 'オプション', 'センサー', ...otherGroups].map((g) => {
      const rows = groupItems(g);
      if (!rows.length) return '';
      return `
      <section class="card item-group">
        <h2>${esc(g)}</h2>
        ${g === 'オプション' ? optionRows(rows, lineOf, est, isDetail) : rows.map((it) => itemRow(it, lineOf[it.key], est, isDetail)).join('')}
      </section>`;
    }).join('')}

    <section class="card item-group">
      <h2>工事・設定${helpBtn('現地調査・設置工事', fixedHelp('work', isDetail))}</h2>
      <p class="hint">現地調査・設置工事の対象台数：<b>${result.installUnits}台</b>（親機・中継機・GeoConnect。目安：1台1日）</p>
      <div class="item-row">
        <span class="item-name">特殊技術対策費（現地調査）${helpBtn('特殊技術対策費', fixedHelp('special', isDetail))}<small class="price">必要な日数</small></span>
        ${qtyStepper('d-survey', '現地調査の特殊技術対策費の日数', est.specialDays.survey, 'days', 'survey', 'data-bind="estimate.specialDays.survey" data-rerender="change" data-int')}
      </div>
      <div class="item-row">
        <span class="item-name">特殊技術対策費（設置工事）${helpBtn('特殊技術対策費', fixedHelp('special', isDetail))}<small class="price">必要な日数</small></span>
        ${qtyStepper('d-install', '設置工事の特殊技術対策費の日数', est.specialDays.install, 'days', 'install', 'data-bind="estimate.specialDays.install" data-rerender="change" data-int')}
      </div>
    </section>

    <section class="card item-group">
      <h2>ランニング</h2>
      <label class="item-row linked">
        <span class="item-name">保守費${helpBtn('保守費', fixedHelp('maintenance', isDetail))}<small class="price">機器合計の${rules(s).maintenancePct}%／年</small></span>
        <span class="linked-ctrl">
          <span class="linked-qty">${est.maintenanceOff ? 'なし' : 'あり'}</span>
          <input type="checkbox" class="switch" ${est.maintenanceOff ? '' : 'checked'} data-action="toggleMaintenance" aria-label="保守費を含める">
        </span>
      </label>
    </section>

    <section class="card summary">
      <div class="summary-head">
        <h2>お見積もり概要${helpBtn('概算と詳細', fixedHelp('display', isDetail))}</h2>
        <div class="segmented small" role="tablist" aria-label="金額表示">
          <button class="${!isDetail ? 'on' : ''}" data-action="setDisplay" data-value="summary">概算</button>
          <button class="${isDetail ? 'on' : ''}" data-action="setDisplay" data-value="detail">詳細</button>
        </div>
      </div>
      ${summaryTable(result, isDetail, s)}
      <p class="fineprint">※ 概算のお見積もりです（税抜）。正式なお見積もりは、現地調査のうえご提示します。</p>
    </section>
  </main>
  ${bottomBar(totalsBar(result, isDetail, s), '<button class="btn primary next" data-action="goStep" data-value="step2">次へ</button>')}`;
}

function priceText(it, isDetail) {
  if (!isDetail) return '';
  const cloud = it.cloudYearly > 0 ? `・クラウド ${formatYen(it.cloudYearly)}/年` : '';
  return `<small class="price">${formatYen(it.price)} / ${esc(it.unit)}${cloud}</small>`;
}

/** 数量の保存先（親機・中継機・Router は役割名、ほかは品目キー） */
function qtyKey(it) {
  return ['parent', 'relay', 'router'].includes(it.role) ? it.role : it.key;
}

function itemRow(it, line, est, isDetail) {
  if (it.role === 'relaySolar' || it.role === 'connectSolar') {
    const on = !est.solarOff[it.key];
    return `
    <label class="item-row linked">
      <span class="item-name">${esc(it.name)}${helpBtn(it.name, roleHelp(it))}${priceText(it, isDetail)}</span>
      <span class="linked-ctrl">
        <span class="linked-qty">${on ? `${line ? line.qty : 0}${esc(it.unit)}` : 'なし'}</span>
        <input type="checkbox" class="switch" ${on ? 'checked' : ''} data-action="toggleSolar" data-key="${esc(it.key)}" aria-label="${esc(it.name)}を含める">
      </span>
    </label>`;
  }
  const key = qtyKey(it);
  const value = est.qty[key] || 0;
  return `
  <div class="item-row">
    <span class="item-name">${esc(it.name)}${helpBtn(it.name, roleHelp(it))}${priceText(it, isDetail)}${it.role === 'router' ? `<small class="price">GeoChat ${rules(settings()).chatsPerRouter}台ごとに1台を自動入力</small>` : ''}</span>
    ${qtyStepper(`q-${key}`, it.name, value, 'qty', key, `data-bind="estimate.qty.${esc(key)}" data-rerender="change" data-int`)}
  </div>`;
}

function optionRows(rows, lineOf, est, isDetail) {
  const vitals = rows.filter((it) => it.role === 'vital');
  let vitalDone = false;
  return rows.map((it) => {
    if (it.role !== 'vital') return itemRow(it, lineOf[it.key], est, isDetail);
    if (vitalDone) return '';
    vitalDone = true;
    const v = est.vital;
    const model = vitals.find((x) => x.key === v.model) || vitals[0];
    return `
    <div class="vital">
      <label class="item-row linked">
        <span class="item-name">GeoVital${helpBtn('GeoVital', fixedHelp('vital', isDetail))}<small class="price">GeoChat と同じ台数を自動入力</small></span>
        <span class="linked-ctrl">
          <span class="linked-qty">${v.on ? 'あり' : 'なし'}</span>
          <input type="checkbox" class="switch" ${v.on ? 'checked' : ''} data-action="toggleVital" aria-label="GeoVital を含める">
        </span>
      </label>
      ${v.on ? `
      <div class="vital-body">
        <div class="model-list" role="radiogroup" aria-label="GeoVital の機種">
          ${vitals.map((x) => `
            <button class="model ${x.key === model.key ? 'on' : ''}" role="radio" aria-checked="${x.key === model.key}" data-action="setVitalModel" data-value="${esc(x.key)}">
              ${esc(x.name.replace(/^GeoVital\s*/, '').replace(/^（(.*)）$/, '$1'))}${isDetail ? `<small>${formatYen(x.price)}</small>` : ''}
            </button>`).join('')}
        </div>
        <div class="item-row">
          <span class="item-name">台数</span>
          ${qtyStepper('q-vital', 'GeoVital', v.qty, 'vitalQty', 'vital', 'data-bind="estimate.vital.qty" data-rerender="change" data-int')}
        </div>
      </div>` : ''}
    </div>`;
  }).join('');
}

/** 下のバーに出す合計（台数を変えながら金額を見られるように） */
function totalsBar(r, isDetail, s) {
  if (!r.equipmentLines.length) return '<div class="bar-totals empty">品目を選ぶと、ここに合計が表示されます</div>';
  const fmt = (v) => (isDetail ? formatYen(v) : formatRange(priceRange(v, s)));
  return `
  <div class="bar-totals" aria-live="polite">
    <div><span>初期費用</span><b>${fmt(r.initialTotal)}</b></div>
    <div><span>ランニング（年額）</span><b>${r.runningYearly > 0 ? fmt(r.runningYearly) : '—'}</b></div>
  </div>`;
}

function summaryTable(r, isDetail, s) {
  if (!r.equipmentLines.length) return '<p class="hint">品目を選ぶと、ここに概要が表示されます。</p>';
  const cols = 2;
  const row = (name, qtyText, price, subtotal, help = '') => isDetail
    ? `<tr><td>${esc(name)}${help}<small class="calc-line">${qtyText}${price ? ` × ${price}` : ''}</small></td><td class="num">${subtotal}</td></tr>`
    : `<tr><td>${esc(name)}${help}</td><td class="num">${qtyText}</td></tr>`;
  const h = (key, title) => helpBtn(title, fixedHelp(key, isDetail));
  const breakdown = (parts) => `
    <tr class="breakdown"><td colspan="${cols}">
      <details><summary>内訳を見る</summary>
        <dl>${parts.map((p) => `<div><dt>${esc(p.label)}<small>${esc(p.calc)}</small></dt><dd>${formatYen(p.amount)}</dd></div>`).join('')}</dl>
      </details>
    </td></tr>`;

  const equipment = r.equipmentLines.map((l) => row(l.name, `${l.qty}${esc(l.unit)}`, formatYen(l.price), formatYen(l.subtotal))).join('');
  const work = r.work.map((w) => {
    const help = h(w.key, w.name);
    if (!isDetail) return row(w.name, '1式', '', '', help);
    if (w.key === 'install' || w.key === 'survey') return row(w.name, '1式', '', formatYen(w.subtotal), help) + breakdown(w.breakdown);
    if (w.key === 'setup') return row(w.name, `${w.qty}台`, formatYen(w.price), formatYen(w.subtotal), help);
    return row(w.name, '1式', formatYen(w.subtotal), formatYen(w.subtotal), help);
  }).join('');
  const running = r.running.map((x) => {
    const help = h(x.key, x.name);
    if (!isDetail) return row(x.name, '1式', '', '', help);
    if (x.key === 'cloud') {
      return row(x.name, '1式', '', formatYen(x.subtotal), help) + breakdown(x.lines.map((l) => ({ label: l.name, calc: `${formatYen(l.cloudYearly)} × ${l.qty}${l.unit}`, amount: l.cloudSubtotal })));
    }
    return row(x.name, '1式', '', formatYen(x.subtotal), help) + `<tr class="breakdown"><td colspan="${cols}"><small class="calc">${esc(x.calc)}</small></td></tr>`;
  }).join('');

  const head = isDetail ? '<tr><th>品目（数量 × 単価）</th><th class="num">金額</th></tr>' : '<tr><th>品目</th><th class="num">数量</th></tr>';
  const totals = isDetail
    ? [['初期費用 合計', formatYen(r.initialTotal)], ['ランニング（年額）', formatYen(r.runningYearly)]]
    : [['初期費用', formatRange(priceRange(r.initialTotal, s))], ['ランニング（年額）', formatRange(priceRange(r.runningYearly, s))]];
  return `
  <div class="table-wrap">
    <table class="lines">
      <thead>${head}</thead>
      <tbody>
        <tr class="sub"><td colspan="${cols}">機器</td></tr>${equipment}
        ${work ? `<tr class="sub"><td colspan="${cols}">工事・設定</td></tr>${work}` : ''}
        ${running ? `<tr class="sub"><td colspan="${cols}">ランニング（年額）</td></tr>${running}` : ''}
      </tbody>
    </table>
  </div>
  <dl class="totals">
    ${totals.map(([k, v], i) => `<div class="${i === 0 ? 'main' : ''}"><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
  </dl>`;
}

// ---------------------------------------------------------------- STEP 2 お客様情報

function viewCustomer() {
  const c = S.draft.customer;
  const unassigned = (S.draft.ocrLines || []).map((l, i) => ({ ...l, i })).filter((l) => !l.field);
  const inputType = { email: 'email', phone1: 'tel', phone2: 'tel', postalCode: 'text' };
  const field = (f) => `
    <label class="field ${invalidClass(f.key)}">
      <span>${esc(f.label)}${reqMark(f.required)}</span>
      <input id="c-${f.key}" type="${inputType[f.key] || 'text'}" ${f.key === 'postalCode' ? 'inputmode="numeric" placeholder="例：100-0001"' : ''} value="${esc(c[f.key])}" data-bind="customer.${f.key}" autocomplete="off">
      ${S.invalid.has(f.key) ? '<small class="err">必須項目です</small>' : ''}
    </label>`;
  const byKey = Object.fromEntries(CARD_FIELDS.map((f) => [f.key, f]));
  return `
  ${header(stepper('step2'))}
  <main class="page with-bottombar">
    <section class="card card-capture">
      <h2>名刺</h2>
      ${S.cardPreview ? `<img class="card-preview" src="${S.cardPreview}" alt="撮影した名刺">` : c.cardFileId ? '<p class="hint">名刺画像は保存済みです</p>' : ''}
      ${S.ocrBusy ? '<p class="ocr-status"><span class="spinner"></span>読み取り中…</p>' : ''}
      <div class="capture-actions">
        <label class="btn primary">名刺を撮影<input type="file" accept="image/*" capture="environment" data-file="card" hidden></label>
        <label class="btn">写真を選ぶ<input type="file" accept="image/*" data-file="card" hidden></label>
      </div>
    </section>

    ${unassigned.length ? `
    <details class="card unassigned">
      <summary>振り分けられなかった文字（${unassigned.length}行）</summary>
      <p class="hint">必要な行をタップすると、項目に入れられます。</p>
      <div class="ocr-lines">
        ${unassigned.map((l) => `<button class="ocr-line" data-action="assignLine" data-index="${l.i}"><span>${esc(l.text)}</span></button>`).join('')}
      </div>
    </details>` : ''}

    <section class="card form">
      <h2>お客様情報</h2>
      ${['company', 'department', 'title', 'name', 'kana', 'email', 'phone1', 'phone2'].map((k) => field(byKey[k])).join('')}
      <fieldset class="address">
        <legend>住所</legend>
        ${['postalCode', 'prefecture', 'city', 'addressLine'].map((k) => field(byKey[k])).join('')}
      </fieldset>
    </section>
  </main>
  ${bottomBar('<button class="btn" data-action="goStep" data-value="step1">戻る</button>', '<button class="btn primary" data-action="goStep" data-value="step3">次へ</button>')}`;
}

// ---------------------------------------------------------------- STEP 3 社内メモ

function viewMemo() {
  const m = S.draft.memo;
  const days = eventDays();
  if (m.visitDate && !days.includes(m.visitDate)) days.unshift(m.visitDate);
  const staff = options('staff');
  const staffIsOther = m.staff && !staff.includes(m.staff);

  const chips = (f) => {
    const opts = options(f.opt);
    const stack = opts.some((o) => o.length > 14);
    const selected = f.multi ? m[f.key] : [m[f.key]];
    return `
    <section class="card q-card ${invalidClass(f.key)}" id="blk-${f.key}">
      <h2 class="q-title">${esc(f.label)}${reqMark(f.required)}${f.multi ? '<small>複数選択可</small>' : ''}</h2>
      <div class="chips ${stack ? 'stack' : ''}">
        ${opts.map((v) => {
          const on = selected.includes(v);
          return `<button class="chip ${on ? 'on' : ''}" data-action="pickOption" data-key="${f.key}" data-value="${esc(v)}" aria-pressed="${on}">${esc(v)}</button>`;
        }).join('')}
      </div>
      ${selected.includes(OTHER) ? `<input id="o-${f.key}" class="other-input" type="text" placeholder="その他の内容" value="${esc(m.other[f.key] || '')}" data-bind="memo.other.${f.key}">` : ''}
      ${S.invalid.has(f.key) ? '<small class="err">必須項目です</small>' : ''}
    </section>`;
  };

  return `
  ${header(stepper('step3'))}
  <main class="page with-bottombar">
    <section class="card q-card ${invalidClass('visitDate')}" id="blk-visitDate">
      <h2 class="q-title">来場日${reqMark(true)}</h2>
      <div class="chips">
        ${days.map((d) => `<button class="chip ${m.visitDate === d ? 'on' : ''}" data-action="pickVisitDate" data-value="${esc(d)}" aria-pressed="${m.visitDate === d}">${esc(d)}</button>`).join('')}
      </div>
      ${S.invalid.has('visitDate') ? '<small class="err">必須項目です</small>' : ''}
    </section>
    <section class="card q-card ${invalidClass('staff')}">
      <h2 class="q-title"><label for="m-staff">対応者</label>${reqMark(true)}</h2>
          <select id="m-staff">
            ${staff.map((n) => `<option value="${esc(n)}" ${n === m.staff ? 'selected' : ''}>${esc(n)}</option>`).join('')}
            <option value="__other__" ${staffIsOther || !m.staff ? 'selected' : ''}>その他</option>
          </select>
      ${staffIsOther || m.staff === '' ? `<input id="m-staff-other" class="other-input" type="text" placeholder="対応者の名前" value="${esc(m.staff)}" data-bind="memo.staff">` : ''}
    </section>
    ${MEMO_FIELDS.map(chips).join('')}
    <section class="card q-card">
      <h2 class="q-title"><label for="m-memo">備考・商談内容</label></h2>
      <label class="field">
        <textarea id="m-memo" rows="6" placeholder="先方の課題、具体的な用途、予算、導入時期、次回対応などを記入してください。" data-bind="memo.memo">${esc(m.memo)}</textarea>
      </label>
    </section>
  </main>
  ${bottomBar('<button class="btn" data-action="goStep" data-value="step2">戻る</button>', `<button class="btn primary" data-action="saveLead">${S.draft.id ? '更新する' : '保存する'}</button>`)}`;
}

// ---------------------------------------------------------------- 一覧

function viewList() {
  return `
  ${header()}
  <main class="page">
    ${pendingBanner()}
    <div class="list-head">
      <h1 class="page-title">登録一覧</h1>
      <button class="btn small" data-action="refreshList">更新</button>
    </div>
    <input id="l-search" class="search" type="search" placeholder="会社名・氏名・メモで検索" value="${esc(S.search)}" data-search>
    <div id="lead-results">${leadResults()}</div>
  </main>`;
}

function priorityBadge(p) {
  if (!p) return '';
  const label = String(p).split('：')[0];
  const cls = { 最優先: 'p1', 優先: 'p2', 通常: 'p3', フォロー対象外: 'p4' }[label] || 'p3';
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function leadResults() {
  if (!S.leadsLoaded) return '<p class="hint center"><span class="spinner"></span>読み込み中…</p>';
  const q = S.search.trim().toLowerCase();
  const leads = S.leads.filter((l) => !q || [l.company, l.name, l.kana, l.email, l.staff, l.memo, l.industry, l.products, l.usages, l.department].join(' ').toLowerCase().includes(q));
  return `
  <p class="hint">${leads.length} 件${q ? `（全 ${S.leads.length} 件中）` : ''}</p>
  <ul class="lead-list">
    ${leads.map((l) => `
      <li>
        <button class="lead-item" data-action="editLead" data-id="${esc(l.id)}">
          <span class="lead-main">
            <b>${esc(l.company || '（ご所属なし）')}</b>
            <span>${esc([l.department, l.name].filter(Boolean).join(' ') || '（お名前なし）')}</span>
          </span>
          <span class="lead-meta">
            ${priorityBadge(l.priority)}
            <small>${esc(l.staff)}・${esc(fmtDate(l.createdAt))}</small>
          </span>
        </button>
      </li>`).join('')}
  </ul>`;
}

function updateLeadResults() {
  const box = document.getElementById('lead-results');
  if (box) box.innerHTML = leadResults();
}

// ---------------------------------------------------------------- 管理者メニュー

function viewAdmin() {
  const a = S.admin;
  const tabs = [['event', '展示会'], ['items', '品目・単価'], ['staff', '担当者']];
  const body = { event: adminEvent, items: adminItems, staff: adminStaff }[a.tab]();
  return `
  ${header()}
  <main class="page with-bottombar">
    <h1 class="page-title">管理者メニュー</h1>
    <div class="segmented" role="tablist">
      ${tabs.map(([k, label]) => `<button role="tab" class="${a.tab === k ? 'on' : ''}" data-action="adminTab" data-value="${k}" aria-selected="${a.tab === k}">${label}</button>`).join('')}
    </div>
    ${body}
  </main>
  ${bottomBar('<button class="btn" data-action="closeAdmin">閉じる</button>', '<button class="btn primary" data-action="adminSave">すべて保存する</button>')}`;
}

function adminEvent() {
  const e = S.admin.event;
  return `
  <section class="card form">
    <label class="field"><span>展示会名</span><input id="a-ev-name" type="text" value="${esc(e.name)}" data-bind="admin.event.name" placeholder="例：FORESTRISE2026 第5回次世代森林産業展"></label>
    <div class="two-col">
      <label class="field"><span>開始日</span><input id="a-ev-start" type="date" value="${esc(e.start)}" data-bind="admin.event.start"></label>
      <label class="field"><span>終了日</span><input id="a-ev-end" type="date" value="${esc(e.end)}" data-bind="admin.event.end"></label>
    </div>
    <p class="hint">会期中の日付が「来場日」の選択肢になります。保存すると全員のアプリに反映されます。</p>
  </section>`;
}

function adminItems() {
  const list = S.admin.items;
  const groups = [];
  for (const g of GROUP_ORDER) {
    if (g === '基地局') {
      for (const b of BASE_TYPES) groups.push({ title: `基地局（${b.label}）`, group: g, filter: (it) => it.group === g && it.baseType === b.key, canAdd: false });
    } else {
      groups.push({ title: g, group: g, filter: (it) => it.group === g, canAdd: true });
    }
  }
  return `
  <p class="hint">単価・クラウド利用料は税抜・円で入力してください。スイッチをオフにすると見積もりに表示されません。</p>
  ${groups.map((g) => `
    <section class="card admin-group">
      <h2>${esc(g.title)}</h2>
      ${list.map((it, i) => (g.filter(it) ? adminItemRow(it, i) : '')).join('')}
      ${g.canAdd ? `<button class="btn small block" data-action="adminAddItem" data-group="${esc(g.group)}">＋ 品目を追加</button>` : ''}
    </section>`).join('')}`;
}

function adminItemRow(it, i) {
  const removable = !it.role && String(it.key).startsWith('custom_');
  const active = String(it.active).toUpperCase() !== 'FALSE' && it.active !== false;
  return `
  <div class="admin-item ${active ? '' : 'off'}">
    <div class="admin-item-head">
      <input id="a-it-${i}-name" class="admin-name" type="text" value="${esc(it.name)}" data-bind="admin.items.${i}.name" aria-label="品目名">
      <input type="checkbox" class="switch" ${active ? 'checked' : ''} data-action="adminToggleItem" data-index="${i}" aria-label="見積もりに表示">
    </div>
    <div class="admin-item-body">
      <label class="field"><span>単価</span><input id="a-it-${i}-price" type="text" inputmode="numeric" value="${esc(it.price)}" data-bind="admin.items.${i}.price"></label>
      <label class="field"><span>クラウド（年）</span><input id="a-it-${i}-cloud" type="text" inputmode="numeric" value="${esc(it.cloudYearly || 0)}" data-bind="admin.items.${i}.cloudYearly"></label>
      <div class="admin-move">
        <button class="icon-btn" data-action="adminMoveItem" data-index="${i}" data-delta="-1" aria-label="上へ">↑</button>
        <button class="icon-btn" data-action="adminMoveItem" data-index="${i}" data-delta="1" aria-label="下へ">↓</button>
        ${removable ? `<button class="icon-btn danger" data-action="adminRemoveItem" data-index="${i}" aria-label="削除">✕</button>` : ''}
      </div>
    </div>
  </div>`;
}

function adminStaff() {
  const list = S.admin.staff;
  return `
  <section class="card">
    <p class="hint">上から順に、担当者を選ぶ画面に並びます（2列）。</p>
    ${list.map((n, i) => `
      <div class="admin-staff">
        <input id="a-st-${i}" type="text" value="${esc(n)}" data-bind="admin.staff.${i}" aria-label="担当者名">
        <button class="icon-btn" data-action="adminMoveStaff" data-index="${i}" data-delta="-1" aria-label="上へ">↑</button>
        <button class="icon-btn" data-action="adminMoveStaff" data-index="${i}" data-delta="1" aria-label="下へ">↓</button>
        <button class="icon-btn danger" data-action="adminRemoveStaff" data-index="${i}" aria-label="削除">✕</button>
      </div>`).join('')}
    <button class="btn small block" data-action="adminAddStaff">＋ 担当者を追加</button>
  </section>`;
}

// ================================================================ 下書き

function newDraft() {
  return {
    id: null,
    estimate: initEstimateState(),
    customer: { ...EMPTY_CUSTOMER },
    memo: {
      visitDate: defaultVisitDate(),
      staff: S.conn.staff,
      industry: '', division: '', usages: [], products: [], materials: [], status: '', priority: '', subsidies: [], timing: '', nextActions: [],
      memo: '',
      other: {},
    },
    ocrLines: [],
  };
}

/** 「その他：〇〇」の記録を、選択肢と自由入力に戻す */
function parseChoice(value, multi, opts) {
  const parts = String(value || '').split('、').map((x) => x.trim()).filter(Boolean);
  if (!multi) {
    const v = parts.join('、');
    if (v && !opts.includes(v)) return { selected: OTHER, other: v.replace(/^その他：?/, '') };
    return { selected: v, other: '' };
  }
  // 選択肢にある値はどこにあっても選択済みにし、それ以外は「その他」の自由記入にまとめる
  const selected = parts.filter((p) => opts.includes(p) && p !== OTHER);
  const rest = parts.filter((p) => !opts.includes(p) || p === OTHER);
  let other = '';
  if (rest.length) {
    selected.push(OTHER);
    other = rest.join('、').replace(/^その他：?/, '');
  }
  selected.sort((a, b) => opts.indexOf(a) - opts.indexOf(b));
  return { selected, other };
}

function formatChoice(selected, other, multi) {
  const fmt = (v) => (v === OTHER && other.trim() ? `その他：${other.trim()}` : v);
  return multi ? selected.map(fmt).join('、') : fmt(selected || '');
}

function draftFromLead(l) {
  const d = newDraft();
  d.id = l.id;
  for (const k of CUSTOMER_KEYS) d.customer[k] = l[k] || '';
  d.memo.visitDate = l.visitDate || '';
  d.memo.staff = l.staff || S.conn.staff;
  d.memo.memo = l.memo || '';
  for (const f of MEMO_FIELDS) {
    const { selected, other } = parseChoice(l[f.key], f.multi, options(f.opt));
    d.memo[f.key] = selected;
    if (other) d.memo.other[f.key] = other;
  }
  try {
    const saved = JSON.parse(l.estimateJson || 'null');
    if (saved?.state) d.estimate = { ...d.estimate, ...saved.state };
    else if (String(l.estimateSkipped).toUpperCase() === 'TRUE') d.estimate.skipped = true;
  } catch {
    /* 壊れた JSON は無視して新しい見積もりにする */
  }
  d.original = Object.fromEntries(Object.keys(leadRecord(d)).map((k) => [k, String(l[k] ?? '')]));
  d.estimateDirty = false;
  return d;
}

// 編集のとき送らない項目：展示会名は登録時のものを保つ。見積もりは触ったときだけ送る
const ESTIMATE_KEYS = ['estimateSkipped', 'estimateMode', 'baseType', 'areaKm2', 'initialTotal', 'runningYearly', 'estimateSummary', 'estimateJson'];

/** 編集で変更した項目だけを取り出す */
function changedFields(d) {
  const lead = leadRecord(d);
  delete lead.event;
  if (!d.estimateDirty) for (const k of ESTIMATE_KEYS) delete lead[k];
  const changes = {};
  const original = {};
  for (const [k, v] of Object.entries(lead)) {
    const before = d.original?.[k] ?? '';
    if (String(v) !== before) {
      changes[k] = v;
      original[k] = before;
    }
  }
  return { changes, original };
}

const FIELD_LABELS = {
  ...Object.fromEntries(CARD_FIELDS.map((f) => [f.key, f.label])),
  ...Object.fromEntries(MEMO_FIELDS.map((f) => [f.key, f.label])),
  visitDate: '来場日', staff: '対応者', memo: '備考・商談内容',
  ...Object.fromEntries(ESTIMATE_KEYS.map((k) => [k, '見積もり'])),
};

/** 見積もりを触ったことを記録する（編集時に見積もりを送るかどうかの判定） */
function markEstimateDirty() {
  if (S.draft) S.draft.estimateDirty = true;
}

function leadRecord(d) {
  const est = d.estimate;
  const result = computeEstimate(items(), est, settings());
  const hasEstimate = !est.skipped && result.equipmentTotal > 0;
  const m = d.memo;
  const memoFields = Object.fromEntries(MEMO_FIELDS.map((f) => [f.key, formatChoice(m[f.key], m.other[f.key] || '', f.multi)]));
  return {
    event: settings().eventName || '',
    visitDate: m.visitDate,
    staff: (m.staff || '').trim(),
    ...Object.fromEntries(CUSTOMER_KEYS.map((k) => [k, (d.customer[k] || '').trim()])),
    ...memoFields,
    memo: m.memo.trim(),
    estimateSkipped: hasEstimate ? 'FALSE' : 'TRUE',
    estimateMode: hasEstimate ? (est.mode === 'area' ? 'エリア整備' : 'スポット利用') : '',
    baseType: hasEstimate ? BASE_TYPES.find((b) => b.key === est.baseType)?.label || '' : '',
    areaKm2: hasEstimate && est.mode === 'area' ? String(est.areaKm2 || '') : '',
    initialTotal: hasEstimate ? String(result.initialTotal) : '',
    runningYearly: hasEstimate ? String(result.runningYearly) : '',
    estimateSummary: hasEstimate ? summarizeEstimate(result) : '',
    estimateJson: hasEstimate ? JSON.stringify({ state: est, initialTotal: result.initialTotal, runningYearly: result.runningYearly }) : '',
  };
}

function missingRequired(d) {
  const lead = leadRecord(d);
  const missing = { customer: [], memo: [] };
  for (const [k, label] of REQUIRED.customer) if (!lead[k]) missing.customer.push([k, label]);
  for (const [k, label] of REQUIRED.memo) if (!lead[k]) missing.memo.push([k, label]);
  return missing;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] ??= {};
  o[keys.at(-1)] = value;
}

/** GeoChat の台数が変わったら、Router と GeoVital を自動で再計算 */
function onChatChanged() {
  const est = S.draft.estimate;
  const chat = normalizeItems(items()).find((it) => it.role === 'chat');
  if (!chat) return;
  const n = Math.max(0, Number(est.qty[chat.key]) || 0);
  est.qty.router = routersFor(n, settings());
  est.vital.qty = n;
}
function isChatKey(key) {
  return normalizeItems(items()).some((it) => it.role === 'chat' && it.key === key);
}

// ================================================================ 画像

async function resizeImage(file, maxSide = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('画像を読み込めませんでした'));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleCardFile(file) {
  if (!file) return;
  let dataUrl;
  try {
    dataUrl = await resizeImage(file);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  S.cardPreview = dataUrl;
  S.ocrBusy = true;
  render();
  try {
    const res = await api('uploadCard', { imageBase64: dataUrl.split(',')[1], mimeType: 'image/jpeg', ocr: true });
    const d = S.draft;
    d.customer.cardFileId = res.fileId || '';
    d.customer.cardUrl = res.url || '';
    if (res.text) {
      const parsed = parseCardText(res.text);
      let filled = 0;
      for (const [k, v] of Object.entries(parsed.fields)) {
        if (!d.customer[k] && v) {
          d.customer[k] = v;
          S.invalid.delete(k);
          filled++;
        }
      }
      d.ocrLines = parsed.lines;
      toast(filled ? `${filled} 項目を読み取りました。内容を確認してください` : '項目に振り分けられませんでした。下の文字から入れてください');
    } else {
      toast(res.ocrError ? '画像は保存しましたが、文字を読み取れませんでした' : '文字を読み取れませんでした。手入力してください', 'error');
    }
    saveDraft();
  } catch (err) {
    handleError(err, '名刺の読み取りに失敗しました');
  } finally {
    S.ocrBusy = false;
    render();
  }
}

// ================================================================ 保存

async function saveLead() {
  const d = S.draft;
  const missing = missingRequired(d);
  if (missing.customer.length || missing.memo.length) {
    S.invalid = new Set([...missing.customer, ...missing.memo].map(([k]) => k));
    const labels = [...missing.customer, ...missing.memo].map(([, l]) => l).join('、');
    S.view = missing.customer.length ? 'step2' : 'step3';
    render();
    const first = document.querySelector('.invalid');
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast(`未入力の必須項目があります：${labels}`, 'error');
    return;
  }
  const lead = leadRecord(d);
  if (!d.id) {
    busy('重複を確認しています…');
    try {
      const { matches } = await api('checkDuplicate', { lead });
      busy(false);
      if (matches.length) {
        openModal(`
          <h2>似たお客様が登録済みです</h2>
          <p class="hint">既存のデータに追記するか、新しく登録するか選んでください。追記すると、空欄だけを埋め、複数選択の項目は合わせ、メモは後ろに足します。</p>
          <ul class="dup-list">
            ${matches.map((m) => `
              <li>
                <div><b>${esc(m.company || '（ご所属なし）')}</b> ${esc(m.name || '')}<br>
                <small>${esc(m.reasons.join('・'))}／${esc(m.staff)}・${esc(fmtDate(m.createdAt))}</small></div>
                <button class="btn small primary" data-action="appendTo" data-id="${esc(m.id)}">ここに追記</button>
              </li>`).join('')}
          </ul>
          <div class="modal-actions">
            <button class="btn" data-action="closeModal">キャンセル</button>
            <button class="btn primary" data-action="saveAsNew">新しく登録</button>
          </div>`);
        return;
      }
    } catch (err) {
      busy(false);
      if (err instanceof NetworkError) {
        queueAndFinish({ kind: 'save', payload: { lead, mode: 'new' } });
        return;
      }
      handleError(err, '重複チェックに失敗しました');
      return;
    }
    await send({ kind: 'save', payload: { lead, mode: 'new' } });
  } else {
    const { changes, original } = changedFields(d);
    if (!Object.keys(changes).length) {
      finishDraft();
      toast('変更はありませんでした', 'success');
      return;
    }
    await send({ kind: 'update', payload: { id: d.id, changes, original } });
  }
}

async function send(job) {
  busy('保存しています…');
  try {
    await runJob(job);
    busy(false);
    finishDraft();
    toast(job.kind === 'update' ? '更新しました' : job.payload.mode === 'append' ? '既存のデータに追記しました' : '保存しました', 'success');
  } catch (err) {
    busy(false);
    if (err instanceof NetworkError) {
      queueAndFinish(job);
      return;
    }
    if (err instanceof ApiError && err.code === 'conflict') {
      showConflict(job, err.data?.fields || []);
      return;
    }
    handleError(err, '保存できませんでした');
  }
}

/** 開いたあとに、ほかの人が同じ項目を先に更新していたとき */
function showConflict(job, fields) {
  const names = [...new Set(fields.map((k) => FIELD_LABELS[k] || k))];
  S.conflictJob = job;
  openModal(`
    <h2>ほかの人が先に更新しています</h2>
    <p class="hint">この登録を開いたあとに、次の項目がほかの人によって変更されました。</p>
    <p class="ocr-pick">${esc(names.join('、'))}</p>
    <p class="hint">最新の内容を開き直すと、あなたの変更は破棄されます。上書きすると、ほかの人の変更が消えます。</p>
    <div class="modal-actions">
      <button class="btn" data-action="reopenLatest">最新の内容を開き直す</button>
      <button class="btn danger-outline" data-action="forceOverwrite">自分の内容で上書き</button>
    </div>`);
}

function runJob(job) {
  return job.kind === 'update' ? api('updateLead', job.payload) : api('saveLead', job.payload);
}

function queueAndFinish(job) {
  S.pending.push({ ...job, label: draftLabel(S.draft), ts: Date.now() });
  savePending();
  finishDraft();
  toast('送信できなかったため、この端末に保存しました。あとで再送信してください', 'error');
}

function finishDraft() {
  S.draft = null;
  saveDraft();
  S.cardPreview = '';
  S.invalid.clear();
  S.leadsLoaded = false;
  closeModal();
  S.view = 'home';
  render();
  window.scrollTo(0, 0);
}

async function retryPending() {
  if (!S.pending.length) return;
  busy('再送信しています…');
  const rest = [];
  let sent = 0;
  for (const job of S.pending) {
    try {
      await runJob(job);
      sent++;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'unauthorized') {
        busy(false);
        lock('パスワードを入力してから再送信してください。');
        return;
      }
      rest.push(job);
    }
  }
  S.pending = rest;
  savePending();
  busy(false);
  S.leadsLoaded = false;
  toast(rest.length ? `${sent} 件送信、${rest.length} 件は送れませんでした` : `${sent} 件すべて送信しました`, rest.length ? 'error' : 'success');
  if (S.view === 'list') loadLeads();
  else render();
}

async function loadLeads() {
  S.leadsLoaded = false;
  render();
  try {
    const res = await api('listLeads');
    S.leads = res.leads || [];
  } catch (err) {
    handleError(err, '一覧を読み込めませんでした');
  } finally {
    S.leadsLoaded = true;
    if (S.view === 'list') updateLeadResults();
  }
}

// ================================================================ 管理者メニューの操作

function openAdminWith(token) {
  const s = settings();
  S.admin = {
    token,
    tab: 'event',
    event: { name: s.eventName || '', start: s.eventStart || '', end: s.eventEnd || '' },
    items: items().map((it) => ({ ...it })),
    staff: [...options('staff')],
  };
  S.view = 'admin';
  render();
  window.scrollTo(0, 0);
}

async function adminLogin(form) {
  const token = form.adminToken.value.trim();
  busy('確認しています…');
  try {
    await api('adminCheck', { adminToken: token });
    busy(false);
    closeModal();
    await refreshConfig({ force: true });
    openAdminWith(token);
  } catch (err) {
    busy(false);
    if (err instanceof ApiError && err.code === 'admin_unauthorized') toast('管理者パスワードが違います', 'error');
    else handleError(err, '確認できませんでした');
  }
}

async function adminSave() {
  const a = S.admin;
  const event = { name: a.event.name.trim(), start: a.event.start, end: a.event.end };
  const itemsPayload = a.items.map((it) => ({ ...it, name: String(it.name || '').trim(), price: toNumber(it.price), cloudYearly: toNumber(it.cloudYearly) }));
  const staff = a.staff.map((n) => String(n || '').trim()).filter(Boolean);
  // 3 つのタブをまとめて確認し、問題があればそのタブを開いて知らせる
  const problems = [];
  if (!event.name) problems.push(['event', '展示会名を入力してください']);
  else if (!event.start || !event.end || event.start > event.end) problems.push(['event', '会期の日付を確認してください']);
  if (itemsPayload.some((it) => !it.name)) problems.push(['items', '品目名が空欄の行があります']);
  if (!staff.length) problems.push(['staff', '担当者を 1 人以上入れてください']);
  if (problems.length) {
    a.tab = problems[0][0];
    render();
    return toast(problems.map((p) => p[1]).join('／'), 'error');
  }
  busy('保存しています…');
  try {
    await adminApi('saveAll', { event, items: itemsPayload, staff });
    await refreshConfig({ force: true });
    busy(false);
    const keep = a.tab;
    openAdminWith(a.token);
    S.admin.tab = keep;
    render();
    toast('展示会・品目・担当者をまとめて保存しました。全員のアプリに反映されます', 'success');
  } catch (err) {
    busy(false);
    handleError(err, '保存できませんでした');
  }
}

function moveWithinGroup(list, i, delta, sameGroup) {
  let j = i + delta;
  while (j >= 0 && j < list.length && !sameGroup(list[i], list[j])) j += delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

// ================================================================ 操作

const actions = {
  goHome() {
    S.view = 'home';
    S.invalid.clear();
    render();
    window.scrollTo(0, 0);
    refreshConfig();
  },
  changeStaff() {
    S.staffOther = false;
    S.view = 'setup';
    render();
  },
  pickStaff(el) {
    S.conn.staff = el.dataset.value;
    S.staffOther = false;
    saveConn();
    if (S.draft && !S.draft.id) S.draft.memo.staff = S.conn.staff;
    S.view = 'home';
    render();
  },
  staffOther() {
    S.staffOther = true;
    render();
    document.getElementById('f-staff-other')?.focus();
  },
  newLead() {
    if (S.draft && !confirm('入力途中のデータを破棄して、新しく始めますか？')) return;
    S.draft = newDraft();
    S.cardPreview = '';
    S.invalid.clear();
    saveDraft();
    actions.goStep({ dataset: { value: 'step1' } });
  },
  resumeDraft() {
    actions.goStep({ dataset: { value: S.draft.id ? 'step2' : 'step1' } });
  },
  discardDraft() {
    if (!confirm('入力途中のデータを破棄しますか？')) return;
    S.draft = null;
    S.cardPreview = '';
    saveDraft();
    render();
  },
  goStep(el) {
    if (!S.draft) return;
    S.view = el.dataset.value;
    render();
    window.scrollTo(0, 0);
  },
  openList() {
    S.view = 'list';
    render();
    if (!S.leadsLoaded) loadLeads();
  },
  refreshList() {
    loadLeads();
  },
  editLead(el) {
    const lead = S.leads.find((l) => l.id === el.dataset.id);
    if (!lead) return;
    if (S.draft && !confirm('入力途中のデータを破棄して、この登録を開きますか？')) return;
    S.draft = draftFromLead(lead);
    S.cardPreview = '';
    S.invalid.clear();
    saveDraft();
    actions.goStep({ dataset: { value: 'step2' } });
  },
  async reloadConfig() {
    busy('最新の設定を取得しています…');
    await refreshConfig({ silent: false, force: true });
    busy(false);
  },
  lockNow() {
    lock('');
  },
  retryPending,

  // 管理者メニュー
  openAdmin() {
    if (S.admin.token) return openAdminWith(S.admin.token);
    openModal(`
      <h2>管理者メニュー</h2>
      <form data-submit="adminLogin">
        <label class="field">
          <span>管理者パスワード</span>
          <input id="f-admin" name="adminToken" type="password" autocomplete="off" required>
          ${S.conn.gasUrl === 'mock' ? '<small>お試しモードの管理者パスワードは <b>admin</b> です。</small>' : ''}
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" data-action="closeModal">キャンセル</button>
          <button class="btn primary" type="submit">開く</button>
        </div>
      </form>`);
  },
  closeAdmin() {
    S.admin = { token: '', tab: 'event', event: null, items: null, staff: null };
    actions.goHome();
  },
  adminTab(el) {
    S.admin.tab = el.dataset.value;
    render();
  },
  adminSave,
  adminToggleItem(el) {
    S.admin.items[Number(el.dataset.index)].active = el.checked;
    render();
  },
  adminMoveItem(el) {
    moveWithinGroup(S.admin.items, Number(el.dataset.index), Number(el.dataset.delta), (a, b) => a.group === b.group && (a.baseType || '') === (b.baseType || ''));
    render();
  },
  adminRemoveItem(el) {
    const it = S.admin.items[Number(el.dataset.index)];
    if (!confirm(`「${it.name}」を削除しますか？（保存するまで確定しません）`)) return;
    S.admin.items.splice(Number(el.dataset.index), 1);
    render();
  },
  adminAddItem(el) {
    const group = el.dataset.group;
    const list = S.admin.items;
    let at = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].group === group) {
        at = i + 1;
        break;
      }
    }
    list.splice(at, 0, { key: `custom_${Date.now().toString(36)}`, name: '', group, baseType: '', role: '', price: 0, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, active: true, note: '' });
    render();
    document.getElementById(`a-it-${at}-name`)?.focus();
  },
  adminMoveStaff(el) {
    moveWithinGroup(S.admin.staff, Number(el.dataset.index), Number(el.dataset.delta), () => true);
    render();
  },
  adminRemoveStaff(el) {
    S.admin.staff.splice(Number(el.dataset.index), 1);
    render();
  },
  adminAddStaff() {
    S.admin.staff.push('');
    render();
    document.getElementById(`a-st-${S.admin.staff.length - 1}`)?.focus();
  },

  // 見積もり
  setMode(el) {
    markEstimateDirty();
    S.draft.estimate.mode = el.dataset.value;
    if (el.dataset.value === 'area') applyAuto();
    saveDraft();
    render();
  },
  setBaseType(el) {
    markEstimateDirty();
    S.draft.estimate.baseType = el.dataset.value;
    saveDraft();
    render();
  },
  resetAuto() {
    markEstimateDirty();
    applyAuto();
    saveDraft();
    render();
  },
  qty(el) {
    markEstimateDirty();
    const q = S.draft.estimate.qty;
    const key = el.dataset.key;
    q[key] = Math.max(0, (Number(q[key]) || 0) + Number(el.dataset.delta));
    if (isChatKey(key)) onChatChanged();
    saveDraft();
    render();
  },
  days(el) {
    markEstimateDirty();
    const d = S.draft.estimate.specialDays;
    const key = el.dataset.key;
    d[key] = Math.max(0, (Number(d[key]) || 0) + Number(el.dataset.delta));
    saveDraft();
    render();
  },
  toggleMaintenance(el) {
    markEstimateDirty();
    S.draft.estimate.maintenanceOff = !el.checked;
    saveDraft();
    render();
  },
  toggleSolar(el) {
    markEstimateDirty();
    S.draft.estimate.solarOff[el.dataset.key] = !el.checked;
    saveDraft();
    render();
  },
  toggleVital(el) {
    markEstimateDirty();
    const est = S.draft.estimate;
    est.vital.on = el.checked;
    if (el.checked) {
      const vitals = normalizeItems(items()).filter((it) => it.role === 'vital');
      if (!vitals.some((v) => v.key === est.vital.model)) est.vital.model = vitals[0]?.key || '';
      const chat = normalizeItems(items()).find((it) => it.role === 'chat');
      est.vital.qty = chat ? Number(est.qty[chat.key]) || 0 : 0;
    }
    saveDraft();
    render();
  },
  setVitalModel(el) {
    markEstimateDirty();
    S.draft.estimate.vital.model = el.dataset.value;
    saveDraft();
    render();
  },
  vitalQty(el) {
    markEstimateDirty();
    const v = S.draft.estimate.vital;
    v.qty = Math.max(0, (Number(v.qty) || 0) + Number(el.dataset.delta));
    saveDraft();
    render();
  },
  setDisplay(el) {
    S.draft.estimate.display = el.dataset.value;
    saveDraft();
    render();
  },
  skipEstimate() {
    markEstimateDirty();
    S.draft.estimate.skipped = true;
    saveDraft();
    actions.goStep({ dataset: { value: 'step2' } });
  },
  unskipEstimate() {
    markEstimateDirty();
    S.draft.estimate.skipped = false;
    saveDraft();
    render();
  },

  // 名刺
  assignLine(el) {
    const i = Number(el.dataset.index);
    const line = S.draft.ocrLines[i];
    openModal(`
      <h2>この行をどの項目に入れますか？</h2>
      <p class="ocr-pick">${esc(line.text)}</p>
      <div class="choice-grid">
        ${CARD_FIELDS.map((f) => `<button class="choice" data-action="assignTo" data-index="${i}" data-field="${f.key}">${esc(f.label)}</button>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn" data-action="assignTo" data-index="${i}" data-field="ignore">使わない</button>
        <button class="btn" data-action="closeModal">キャンセル</button>
      </div>`);
  },
  assignTo(el) {
    const i = Number(el.dataset.index);
    const field = el.dataset.field;
    const d = S.draft;
    const line = d.ocrLines[i];
    line.field = field;
    if (field !== 'ignore') {
      const cur = d.customer[field];
      d.customer[field] = field === 'addressLine' && cur && !cur.includes(line.text) ? `${cur} ${line.text}` : line.text;
      S.invalid.delete(field);
    }
    saveDraft();
    closeModal();
    render();
  },

  // 社内メモ
  pickOption(el) {
    const m = S.draft.memo;
    const key = el.dataset.key;
    const v = el.dataset.value;
    const f = MEMO_FIELDS.find((x) => x.key === key);
    if (f.multi) {
      const list = m[key];
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
      else {
        // 「渡していない」「特になし」はほかの選択と両立しないので、片方を外す
        const exclusive = ['渡していない', '特になし'];
        if (exclusive.includes(v)) list.splice(0, list.length);
        else for (const x of exclusive) if (list.includes(x)) list.splice(list.indexOf(x), 1);
        const opts = options(f.opt);
        list.push(v);
        list.sort((a, b) => opts.indexOf(a) - opts.indexOf(b));
      }
    } else {
      m[key] = m[key] === v ? '' : v;
    }
    S.invalid.delete(key);
    saveDraft();
    render();
    if (v === OTHER) document.getElementById(`o-${key}`)?.focus();
  },
  pickVisitDate(el) {
    S.draft.memo.visitDate = el.dataset.value;
    S.invalid.delete('visitDate');
    saveDraft();
    render();
  },
  saveLead,
  saveAsNew() {
    closeModal();
    send({ kind: 'save', payload: { lead: leadRecord(S.draft), mode: 'new' } });
  },
  appendTo(el) {
    closeModal();
    send({ kind: 'save', payload: { lead: leadRecord(S.draft), mode: 'append', targetId: el.dataset.id } });
  },
  help(el) {
    openModal(`
      <h2>${esc(el.dataset.title)}</h2>
      <p class="help-text">${esc(el.dataset.text)}</p>
      <div class="modal-actions"><button class="btn primary" data-action="closeModal">閉じる</button></div>`);
  },
  async reopenLatest() {
    const id = S.conflictJob?.payload?.id;
    closeModal();
    busy('最新の内容を読み込んでいます…');
    try {
      const res = await api('listLeads');
      S.leads = res.leads || [];
      S.leadsLoaded = true;
      const lead = S.leads.find((l) => l.id === id);
      busy(false);
      if (!lead) return toast('登録が見つかりませんでした', 'error');
      S.draft = draftFromLead(lead);
      saveDraft();
      actions.goStep({ dataset: { value: 'step2' } });
      toast('最新の内容を開きました', 'success');
    } catch (err) {
      busy(false);
      handleError(err, '読み込めませんでした');
    }
  },
  forceOverwrite() {
    const job = S.conflictJob;
    closeModal();
    if (job) send({ ...job, payload: { ...job.payload, force: true } });
  },
  closeModal,
};

function applyAuto() {
  const est = S.draft.estimate;
  const auto = suggestCounts(est.areaKm2, settings());
  if (auto.parent > 0) {
    est.qty.parent = auto.parent;
    est.qty.relay = auto.relay;
  }
}

async function connect(form) {
  const gasUrl = form.gasUrl.value.trim();
  const token = form.token.value.trim();
  busy('接続しています…');
  try {
    const res = await callApi(gasUrl, 'getConfig', {}, token);
    const config = { settings: res.settings || {}, items: res.items || [], options: res.options || {} };
    S.conn = { ...S.conn, gasUrl, token };
    S.config = config;
    S.lockedMessage = '';
    S.lastRefresh = Date.now();
    saveConn();
    store.set(LS.config, config);
    touch();
    S.view = S.conn.staff ? 'home' : 'setup';
    render();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'unauthorized') toast('パスワードが違います', 'error');
    else if (err instanceof NetworkError) toast('接続できませんでした。電波と接続先を確認してください', 'error');
    else toast(`接続できませんでした（${err.message}）`, 'error');
  } finally {
    busy(false);
  }
}

// ================================================================ イベント

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (el.type === 'checkbox') return; // チェックボックスは change で扱う
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
}

function onChange(e) {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-action]')) {
    actions[el.dataset.action]?.(el, e);
    return;
  }
  if (el.matches('input[type=file][data-file]')) {
    const file = el.files?.[0];
    el.value = '';
    handleCardFile(file);
    return;
  }
  if (el.matches('#m-staff')) {
    if (el.value === '__other__') S.draft.memo.staff = '';
    else S.draft.memo.staff = el.value;
    S.invalid.delete('staff');
    saveDraft();
    render();
    if (el.value === '__other__') document.getElementById('m-staff-other')?.focus();
    return;
  }
  if (el.matches('[data-bind][data-rerender=change]')) {
    applyBinding(el);
    render();
  }
}

function applyBinding(el) {
  const path = el.dataset.bind;
  let value = el.value;
  if (el.hasAttribute('data-int')) value = Math.max(0, Math.floor(Number(String(value).normalize('NFKC')) || 0));
  if (path.startsWith('admin.')) {
    setPath(S, path, value);
    return;
  }
  if (!S.draft) return;
  if (path.startsWith('estimate.')) markEstimateDirty();
  if (path === 'estimate.areaKm2') value = String(value).normalize('NFKC').replace(/[^\d.]/g, '');
  setPath(S.draft, path, value);
  if (path === 'estimate.areaKm2') applyAuto();
  if (path.startsWith('estimate.qty.') && isChatKey(path.slice('estimate.qty.'.length))) onChatChanged();
  const key = path.split('.').at(-1);
  if (S.invalid.has(key) && String(value).trim()) {
    S.invalid.delete(key);
    el.closest('.invalid')?.classList.remove('invalid');
  }
  saveDraft();
}

function onInput(e) {
  const el = e.target;
  // 日本語の変換中は何もしない（変換が確定したら compositionend で処理する）
  if (e.isComposing) return;
  if (el.matches('[data-search]')) {
    S.search = el.value;
    updateLeadResults();
    return;
  }
  if (!el.matches('[data-bind]')) return;
  if (el.dataset.rerender === 'change') return; // 数量は確定（change）してから反映
  applyBinding(el);
  if (el.dataset.rerender === 'input') render();
}

function onSubmit(e) {
  const form = e.target.closest('form[data-submit]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.submit;
  if (kind === 'connect') connect(form);
  else if (kind === 'adminLogin') adminLogin(form);
  else if (kind === 'staffOther') {
    const name = form.name.value.trim();
    if (!name) return;
    S.conn.staff = name;
    S.staffOther = false;
    saveConn();
    if (S.draft && !S.draft.id) S.draft.memo.staff = name;
    S.view = 'home';
    render();
  }
}

for (const root of [$app, $modal]) {
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('compositionend', (e) => onInput({ target: e.target, isComposing: false }));
  root.addEventListener('submit', onSubmit);
}

let lastTouch = 0;
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    if (Date.now() - lastTouch > 15_000) {
      checkTimeout();
      touch();
      lastTouch = Date.now();
    }
  }, { capture: true, passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkTimeout();
    refreshConfig();
  }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

checkTimeout();
if (S.conn.token) {
  touch();
  refreshConfig({ force: true });
}
render();
