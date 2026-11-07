/**
 * ExpoMemo バックエンド（Google Apps Script）
 *
 * 使い方は README.md の「本番のセットアップ」を参照。
 * 1. スプレッドシートの「拡張機能 > Apps Script」にこのファイルと appsscript.json を貼り付ける
 * 2. 本番の単価・計算ルール・担当者を入れる場合は、別途渡す Seed.gs も同じプロジェクトに追加する
 * 3. setup() を 1 回実行する（シート作成・パスワードの発行）
 * 4. 「デプロイ > 新しいデプロイ > ウェブアプリ」で公開する
 *    実行ユーザー：自分 / アクセスできるユーザー：全員
 */

var SHEET = {
  LEADS: 'leads',
  SETTINGS: 'settings',
  ITEMS: 'items',
  OPTIONS: 'options',
};

var LEAD_COLUMNS = [
  ['id', 'ID'],
  ['createdAt', '登録日時'],
  ['updatedAt', '更新日時'],
  ['event', '展示会'],
  ['visitDate', '来場日'],
  ['staff', '対応者'],
  ['company', 'ご所属'],
  ['department', '部署'],
  ['title', '役職'],
  ['name', 'お名前'],
  ['kana', 'ふりがな'],
  ['email', 'メール'],
  ['phone1', '電話番号①'],
  ['phone2', '電話番号②'],
  ['postalCode', '郵便番号'],
  ['prefecture', '都道府県'],
  ['city', '市区町村'],
  ['addressLine', '住所（それ以降）'],
  ['cardFileId', '名刺画像ID'],
  ['cardUrl', '名刺画像URL'],
  ['industry', '業種・所属区分'],
  ['division', '部署・担当分野'],
  ['usages', '関心のある用途'],
  ['products', '関心のある製品・サービス'],
  ['materials', '資料をお渡ししたか'],
  ['status', '検討状況'],
  ['priority', '優先フォロー度'],
  ['subsidies', '検討している補助金・財源'],
  ['timing', '想定している導入時期'],
  ['nextActions', '次回アクション'],
  ['memo', '備考・商談内容'],
  ['estimateSkipped', '見積もりスキップ'],
  ['estimateMode', '見積もりモード'],
  ['baseType', '基地局の種類'],
  ['areaKm2', '面積(km2)'],
  ['initialTotal', '初期費用合計'],
  ['runningYearly', 'ランニング年額'],
  ['estimateSummary', '見積もり内容'],
  ['estimateJson', '見積もりデータ(JSON)'],
];
var LEAD_HEADERS = LEAD_COLUMNS.map(function (c) { return c[0]; });
var EDITABLE_FIELDS = LEAD_HEADERS.filter(function (h) { return ['id', 'createdAt', 'updatedAt'].indexOf(h) < 0; });
var LIST_FIELDS = ['usages', 'products', 'materials', 'subsidies', 'nextActions'];
var CUSTOMER_FIELDS = ['company', 'department', 'title', 'name', 'kana', 'email', 'phone1', 'phone2', 'postalCode', 'prefecture', 'city', 'addressLine', 'cardFileId', 'cardUrl'];
var ESTIMATE_FIELDS = ['estimateSkipped', 'estimateMode', 'baseType', 'areaKm2', 'initialTotal', 'runningYearly', 'estimateSummary', 'estimateJson'];

var ITEM_HEADERS = ['key', 'name', 'group', 'baseType', 'role', 'price', 'cloudYearly', 'unit', 'countSetup', 'countInstall', 'sort', 'active', 'note'];
var ITEM_GROUPS = ['基地局', '子機', 'オプション', 'センサー'];

// ---------------------------------------------------------------- 入口

function doGet() {
  return json_({ ok: true, app: 'ExpoMemo' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  if (!checkSetting_('token', req.token)) return json_({ ok: false, error: 'unauthorized' });

  return json_(safe_(function () {
    switch (req.action) {
      case 'getConfig': return getConfig_();
      case 'listLeads': return listLeads_();
      case 'checkDuplicate': return checkDuplicate_(req.lead || {});
      case 'saveLead': return withLock_(function () { return saveLead_(req.lead || {}, req.mode, req.targetId); });
      case 'updateLead': return withLock_(function () { return updateLead_(req); });
      case 'uploadCard': return uploadCard_(req);
      // 管理者メニュー（管理者パスワードが必要）
      case 'adminCheck':
      case 'saveAll':
        if (!checkSetting_('adminToken', req.adminToken)) return { ok: false, error: 'admin_unauthorized' };
        if (req.action === 'adminCheck') return { ok: true };
        return withLock_(function () { return saveAll_(req); });
      default: return { ok: false, error: 'unknown_action' };
    }
  }));
}

// ---------------------------------------------------------------- 初期セットアップ

/** 初回に 1 回だけ手動で実行する。既存のシートや値は上書きしない。 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var leads = ensureSheet_(ss, SHEET.LEADS, LEAD_HEADERS);
  if (leads.getLastRow() === 1) {
    leads.insertRowBefore(1);
    var labels = LEAD_COLUMNS.map(function (c) { return c[1]; });
    leads.getRange(1, 1, 1, labels.length).setValues([labels]).setFontWeight('bold').setBackground('#e8f1ee');
    leads.getRange(2, 1, 1, LEAD_HEADERS.length).setFontColor('#999999');
    leads.setFrozenRows(2);
  }
  // 電話番号の先頭 0 が消えないよう、全列を書式なしテキストにする
  leads.getRange(1, 1, leads.getMaxRows(), LEAD_HEADERS.length).setNumberFormat('@');

  var settings = ensureSheet_(ss, SHEET.SETTINGS, ['key', 'value', 'note']);
  var seed = seed_();
  var rules = [
    ['companyName', '株式会社フォレストシー', '見積もり画面に表示する会社名'],
    ['parentAreaKm2', 200, '親機 1 台あたりの面積(km2)'],
    ['relayAreaKm2', 20, '中継機 1 台あたりの面積(km2)'],
    ['rangeLowPct', -10, '概算表示の下限（%）'],
    ['rangeHighPct', 20, '概算表示の上限（%）'],
    ['laborPerUnit', 100000, '現地調査・設置工事：人件費（1 台あたり）'],
    ['travelPer5Units', 100000, '現地調査・設置工事：往復交通費（5 台ごと）'],
    ['vehiclePerUnit', 10000, '現地調査・設置工事：車両費（1 台あたり）'],
    ['fuelPerUnit', 1000, '現地調査・設置工事：燃料費（1 台あたり）'],
    ['lodgingPerUnit', 10000, '現地調査・設置工事：宿泊費（（台数−1）あたり）'],
    ['overheadPct', 10, '現地調査・設置工事：諸経費（%）'],
    ['specialPerDay', 100000, '特殊技術対策費（1 日あたり）'],
    ['setupFeePerUnit', 1000, '初期設定費（1 台あたり）'],
    ['contractFee', 1000, '契約事務手数料'],
    ['maintenancePct', 10, '保守費（機器合計に対する % / 年）'],
    ['chatsPerRouter', 4, 'GeoChat 何台ごとに GeoChat Router 1 台'],
  ].map(function (r) {
    return seed.settings && seed.settings[r[0]] !== undefined ? [r[0], seed.settings[r[0]], r[2]] : r;
  });
  appendMissingKeys_(settings, [
    ['token', randomToken_(), '利用者パスワード（12 文字以上推奨）。アプリの初回設定で入力する。変更すると全員の再入力が必要'],
    ['adminToken', randomToken_(), '管理者パスワード（12 文字以上推奨）。アプリの「管理者メニュー」を開くときに入力する'],
    ['eventName', '', '展示会名（アプリの管理者メニューから変更できる）'],
    ['eventStart', '', '会期の開始日 yyyy-mm-dd（管理者メニューから変更できる）'],
    ['eventEnd', '', '会期の終了日 yyyy-mm-dd（管理者メニューから変更できる）'],
  ].concat(rules).concat([
    ['sessionTimeoutMin', 120, '操作がないときパスワードを再入力させるまでの分数'],
    ['cardFolderId', '', '名刺画像の保存先フォルダ ID（空なら自動作成）'],
  ]));

  var items = ensureSheet_(ss, SHEET.ITEMS, ITEM_HEADERS);
  if (items.getLastRow() === 1) {
    var rows = (seed.items && seed.items.length ? seed.items : DEFAULT_ITEMS_()).map(function (it) {
      return ITEM_HEADERS.map(function (h) { return it[h] === undefined ? (h === 'active' ? true : '') : it[h]; });
    });
    items.getRange(2, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
  }

  var options = ensureSheet_(ss, SHEET.OPTIONS, ['type', 'value', 'sort']);
  if (options.getLastRow() === 1) {
    var opt = [];
    var defs = DEFAULT_OPTIONS_();
    if (seed.staff && seed.staff.length) defs.staff = seed.staff;
    Object.keys(defs).forEach(function (type) {
      defs[type].forEach(function (v, i) { opt.push([type, v, (i + 1) * 10]); });
    });
    options.getRange(2, 1, opt.length, 3).setValues(opt);
  }

  getCardFolder_();
  var s = readSettings_(true);
  Logger.log((seed.items ? 'Seed.gs の値で' : 'ダミーの値で（Seed.gs がありません）') + 'セットアップ完了。利用者パスワード: ' + s.token + ' / 管理者パスワード: ' + s.adminToken);
  return s.token;
}

// ---------------------------------------------------------------- 各アクション

function getConfig_() {
  return {
    ok: true,
    settings: readSettings_(false),
    items: readTable_(SHEET.ITEMS),
    options: readOptions_(),
  };
}

function listLeads_() {
  var leads = readLeads_().map(function (r) { return r.lead; });
  leads.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { ok: true, leads: leads };
}

function checkDuplicate_(lead) {
  var email = normEmail_(lead.email);
  var company = normCompany_(lead.company);
  var name = normText_(lead.name);
  var matches = [];
  readLeads_().forEach(function (r) {
    var l = r.lead;
    var reasons = [];
    if (email && normEmail_(l.email) === email) reasons.push('メールが一致');
    if (company && normCompany_(l.company) === company) reasons.push(name && normText_(l.name) === name ? '会社名と氏名が一致' : '会社名が一致');
    if (!company && name && normText_(l.name) === name) reasons.push('氏名が一致');
    if (reasons.length) {
      matches.push({ id: l.id, company: l.company, name: l.name, staff: l.staff, event: l.event, createdAt: l.createdAt, reasons: reasons });
    }
  });
  return { ok: true, matches: matches };
}

function saveLead_(lead, mode, targetId) {
  if (mode === 'append' && targetId) return appendToLead_(targetId, lead);
  var sheet = sheet_(SHEET.LEADS);
  var now = nowIso_();
  var row = {};
  EDITABLE_FIELDS.forEach(function (k) { row[k] = lead[k] === undefined ? '' : lead[k]; });
  row.id = 'L' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyMMddHHmmss') + Math.random().toString(36).slice(2, 6);
  row.createdAt = now;
  row.updatedAt = now;
  var headers = leadHeaders_(sheet);
  sheet.appendRow(headers.map(function (h) { return cell_(row[h]); }));
  return { ok: true, id: row.id };
}

/**
 * 編集の保存。アプリは変更した項目（changes）と、開いた時点の値（original）を送る。
 * 開いたあとに同じ項目がほかの人に変更されていたら conflict を返す（force のときは上書き）。
 * 変更していない項目には触れないので、ほかの人の追記は消えない。
 */
function updateLead_(req) {
  var found = findLead_(req.id);
  if (!found) return { ok: false, error: 'not_found' };
  var cur = found.lead;
  var changes = req.changes || req.lead || {};
  var original = req.original;
  var keys = EDITABLE_FIELDS.filter(function (k) { return changes[k] !== undefined; });
  if (original && !req.force) {
    var conflicts = keys.filter(function (k) { return String(cur[k] === undefined ? '' : cur[k]) !== String(original[k] === undefined ? '' : original[k]); });
    if (conflicts.length) return { ok: false, error: 'conflict', fields: conflicts };
  }
  keys.forEach(function (k) { cur[k] = changes[k]; });
  cur.updatedAt = nowIso_();
  writeLeadRow_(found, cur);
  return { ok: true, id: req.id };
}

/** 重複時の「既存に追記」：空欄は埋め、複数選択は合わせ、メモは追記、1 つ選ぶ項目は新しい値で上書き */
function appendToLead_(id, lead) {
  var found = findLead_(id);
  if (!found) return { ok: false, error: 'not_found' };
  var cur = found.lead;
  CUSTOMER_FIELDS.concat(['industry', 'division', 'timing']).forEach(function (k) { if (!cur[k] && lead[k]) cur[k] = lead[k]; });
  ['status', 'priority', 'event', 'visitDate'].forEach(function (k) { if (lead[k]) cur[k] = lead[k]; });
  LIST_FIELDS.forEach(function (k) { cur[k] = unionList_(cur[k], lead[k]); });
  if (lead.memo) {
    var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d HH:mm') + ' ' + (lead.staff || '');
    cur.memo = (cur.memo ? cur.memo + '\n\n' : '') + '[' + stamp.trim() + '] ' + lead.memo;
  }
  if (lead.estimateJson && String(lead.estimateSkipped).toUpperCase() !== 'TRUE') {
    ESTIMATE_FIELDS.forEach(function (k) { cur[k] = lead[k]; });
  }
  cur.updatedAt = nowIso_();
  writeLeadRow_(found, cur);
  return { ok: true, id: id };
}

function uploadCard_(req) {
  if (!req.imageBase64) return { ok: false, error: 'no_image' };
  var bytes = Utilities.base64Decode(req.imageBase64);
  var name = 'card_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.jpg';
  var blob = Utilities.newBlob(bytes, req.mimeType || 'image/jpeg', name);
  var file = getCardFolder_().createFile(blob);
  var result = { ok: true, fileId: file.getId(), url: file.getUrl(), text: '' };
  if (req.ocr) {
    try {
      result.text = ocrBlob_(blob);
    } catch (err) {
      result.ocrError = String(err && err.message || err);
    }
  }
  return result;
}

/** Drive の OCR：画像を Google ドキュメントに変換して本文を取り出し、変換したドキュメントは削除する */
function ocrBlob_(blob) {
  var docId;
  if (Drive.Files.create) {
    // Drive API v3
    var created = Drive.Files.create({ name: 'expomemo_ocr_tmp', mimeType: MimeType.GOOGLE_DOCS }, blob, { ocrLanguage: 'ja', fields: 'id' });
    docId = created.id;
  } else {
    // Drive API v2
    var inserted = Drive.Files.insert({ title: 'expomemo_ocr_tmp', mimeType: blob.getContentType() }, blob, { ocr: true, ocrLanguage: 'ja' });
    docId = inserted.id;
  }
  try {
    return DocumentApp.openById(docId).getBody().getText();
  } finally {
    DriveApp.getFileById(docId).setTrashed(true);
  }
}

// ---------------------------------------------------------------- 管理者メニュー

/** 展示会・品目・担当者をまとめて保存する。先に全部チェックし、1 つでも問題があれば何も書き込まない */
function saveAll_(req) {
  var ev = checkEvent_(req.event || {});
  if (ev.error) return ev.error;
  var items = checkItems_(req.items || []);
  if (items.error) return items.error;
  var staff = checkStaff_(req.staff || []);
  if (staff.error) return staff.error;
  writeEvent_(ev.value);
  writeItems_(items.value);
  writeStaff_(staff.value);
  return { ok: true };
}

function invalid_(message) {
  return { error: { ok: false, error: 'invalid', message: message } };
}

function checkEvent_(ev) {
  var name = String(ev.name || '').trim();
  var start = String(ev.start || '').trim();
  var end = String(ev.end || '').trim();
  var dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!name) return invalid_('展示会名を入力してください');
  if (!dateRe.test(start) || !dateRe.test(end) || start > end) return invalid_('会期の日付を確認してください');
  return { value: { name: name, start: start, end: end } };
}

function writeEvent_(ev) {
  setSetting_('eventName', ev.name);
  setSetting_('eventStart', ev.start);
  setSetting_('eventEnd', ev.end);
}

function checkItems_(items) {
  if (!items.length) return invalid_('品目がありません');
  var seen = {};
  var rows = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var key = String(it.key || '').trim();
    var name = String(it.name || '').trim();
    if (!key || seen[key]) return invalid_('品目の識別子が重複しています');
    if (!name) return invalid_('品目名が空欄の行があります');
    if (ITEM_GROUPS.indexOf(String(it.group)) < 0) return invalid_('品目の分類が正しくありません');
    seen[key] = true;
    var row = {
      key: key, name: name, group: String(it.group), baseType: String(it.baseType || ''), role: String(it.role || ''),
      price: num_(it.price), cloudYearly: num_(it.cloudYearly),
      unit: String(it.unit || '台'), countSetup: bool_(it.countSetup, true), countInstall: bool_(it.countInstall, false),
      sort: (i + 1) * 10, active: bool_(it.active, true), note: String(it.note || ''),
    };
    rows.push(ITEM_HEADERS.map(function (h) { return row[h]; }));
  }
  return { value: rows };
}

function writeItems_(rows) {
  var sheet = sheet_(SHEET.ITEMS);
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, Math.max(sheet.getLastColumn(), ITEM_HEADERS.length)).clearContent();
  sheet.getRange(1, 1, 1, ITEM_HEADERS.length).setValues([ITEM_HEADERS]);
  sheet.getRange(2, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
}

function checkStaff_(staff) {
  var names = [];
  staff.forEach(function (n) {
    n = String(n || '').trim();
    if (n && names.indexOf(n) < 0) names.push(n);
  });
  if (!names.length) return invalid_('担当者を 1 人以上入れてください');
  return { value: names };
}

function writeStaff_(names) {
  var sheet = sheet_(SHEET.OPTIONS);
  var values = sheet.getDataRange().getValues();
  var keep = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) !== 'staff' && values[i].join('') !== '') keep.push([values[i][0], values[i][1], values[i][2]]);
  }
  names.forEach(function (n, i) { keep.push(['staff', n, (i + 1) * 10]); });
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 3).clearContent();
  sheet.getRange(2, 1, keep.length, 3).setValues(keep);
}

// ---------------------------------------------------------------- 補助

function checkSetting_(key, value) {
  var expected = readSettings_(true)[key];
  return !!expected && String(value || '') === String(expected);
}

function readSettings_(includeSecrets) {
  var values = sheet_(SHEET.SETTINGS).getDataRange().getValues();
  var out = {};
  for (var i = 1; i < values.length; i++) {
    var key = String(values[i][0]).trim();
    if (!key) continue;
    if (!includeSecrets && (key === 'token' || key === 'adminToken' || key === 'cardFolderId')) continue;
    var v = values[i][1];
    out[key] = v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd') : v;
  }
  return out;
}

function setSetting_(key, value) {
  var sheet = sheet_(SHEET.SETTINGS);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setNumberFormat('@').setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value, '']);
}

function readTable_(name) {
  var values = sheet_(name).getDataRange().getValues();
  var headers = values[0].map(String);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].join('') === '') continue;
    var o = {};
    headers.forEach(function (h, j) { o[h] = values[i][j]; });
    rows.push(o);
  }
  return rows;
}

function readOptions_() {
  var out = {};
  readTable_(SHEET.OPTIONS)
    .sort(function (a, b) { return (Number(a.sort) || 0) - (Number(b.sort) || 0); })
    .forEach(function (r) {
      var t = String(r.type).trim();
      if (!t || r.value === '') return;
      (out[t] = out[t] || []).push(String(r.value));
    });
  return out;
}

/** leads シートは 1 行目が日本語の見出し、2 行目がキー。キーの行を探して使う */
function leadHeaders_(sheet) {
  var top = sheet.getRange(1, 1, Math.min(2, sheet.getLastRow()), sheet.getLastColumn()).getValues();
  for (var r = 0; r < top.length; r++) {
    if (String(top[r][0]) === 'id') return top[r].map(String);
  }
  return LEAD_HEADERS;
}

function leadHeaderRow_(sheet) {
  var top = sheet.getRange(1, 1, Math.min(2, sheet.getLastRow()), 1).getValues();
  for (var r = 0; r < top.length; r++) if (String(top[r][0]) === 'id') return r + 1;
  return 1;
}

function readLeads_() {
  var sheet = sheet_(SHEET.LEADS);
  var headerRow = leadHeaderRow_(sheet);
  var headers = leadHeaders_(sheet);
  var last = sheet.getLastRow();
  if (last <= headerRow) return [];
  var values = sheet.getRange(headerRow + 1, 1, last - headerRow, headers.length).getValues();
  var out = [];
  values.forEach(function (v, i) {
    if (!v[0]) return;
    var lead = {};
    headers.forEach(function (h, j) { lead[h] = v[j] instanceof Date ? v[j].toISOString() : String(v[j]).replace(/^'(?==)/, ''); });
    out.push({ row: headerRow + 1 + i, headers: headers, lead: lead });
  });
  return out;
}

function findLead_(id) {
  var all = readLeads_();
  for (var i = 0; i < all.length; i++) if (all[i].lead.id === String(id)) return all[i];
  return null;
}

function writeLeadRow_(found, lead) {
  var sheet = sheet_(SHEET.LEADS);
  sheet.getRange(found.row, 1, 1, found.headers.length).setValues([found.headers.map(function (h) { return cell_(lead[h]); })]);
}

/** 数式として解釈されないようにする（列はテキスト書式だが、念のため = で始まる値の先頭に ' を付ける） */
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  var s = String(v);
  return /^=/.test(s) ? "'" + s : s;
}

function num_(v) {
  var n = Number(String(v === undefined || v === null ? '' : v).replace(/[,，円¥￥\s]/g, ''));
  return isFinite(n) && n > 0 ? n : 0;
}

function bool_(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no)$/i.test(String(v).trim());
}

/** 複数選択の値を合わせる。「その他：〇〇」は最後に置く */
function unionList_(a, b) {
  var seen = {};
  var out = [];
  var others = [];
  String(a || '').split('、').concat(String(b || '').split('、')).forEach(function (s) {
    s = s.trim();
    if (!s || seen[s]) return;
    seen[s] = true;
    (s.indexOf('その他') === 0 ? others : out).push(s);
  });
  return out.concat(others).join('、');
}

function normText_(s) { return String(s || '').replace(/[\s　]/g, '').toLowerCase(); }
function normEmail_(s) { return String(s || '').trim().toLowerCase(); }
function normCompany_(s) {
  return normText_(String(s || '').normalize('NFKC'))
    .replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|一般社団法人|一般財団法人|公益社団法人|公益財団法人/g, '');
}

/** 非公開の Seed.gs で定義する SEED（なければ空） */
function seed_() {
  return typeof SEED === 'object' && SEED ? SEED : {};
}

function randomToken_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendMissingKeys_(sheet, rows) {
  var existing = {};
  sheet.getDataRange().getValues().forEach(function (r) { existing[String(r[0])] = true; });
  rows.forEach(function (r) { if (!existing[r[0]]) sheet.appendRow(r); });
}

function getCardFolder_() {
  var settings = sheet_(SHEET.SETTINGS);
  var values = settings.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === 'cardFolderId') {
      var id = String(values[i][1] || '');
      if (id) {
        try { return DriveApp.getFolderById(id); } catch (err) { /* 作り直す */ }
      }
      var folder = DriveApp.createFolder('ExpoMemo 名刺画像');
      settings.getRange(i + 1, 2).setValue(folder.getId());
      return folder;
    }
  }
  return DriveApp.createFolder('ExpoMemo 名刺画像');
}

function sheet_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('シート「' + name + '」がありません。setup() を実行してください');
  return sheet;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function safe_(fn) {
  try { return fn(); } catch (err) { return { ok: false, error: 'server_error', message: String(err && err.message || err) }; }
}

function nowIso_() { return new Date().toISOString(); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- 初期データ（ダミー。js/defaults.js と同じ内容）
// 本番の単価・計算ルール・担当者は、リポジトリに置かない Seed.gs の SEED で入れる（README 参照）

function DEFAULT_ITEMS_() {
  var t = true;
  var f = false;
  var item = function (key, name, group, baseType, role, price, cloudYearly, countSetup, countInstall, note) {
    return { key: key, name: name, group: group, baseType: baseType, role: role, price: price, cloudYearly: cloudYearly, unit: '台', countSetup: countSetup, countInstall: countInstall, active: true, note: note || '' };
  };
  var rows = [
    item('multi_parent', 'GeoBase Multi（親機）', '基地局', 'multi', 'parent', 1000000, 100000, t, t),
    item('multi_relay', 'GeoBase Multi Repeater（中継機）', '基地局', 'multi', 'relay', 500000, 50000, t, t),
    item('multi_solar', '分離型ソーラーバッテリー', '基地局', 'multi', 'relaySolar', 200000, 0, f, f, '中継機と同数を自動計上'),
    item('std_parent', 'GeoBase（親機）', '基地局', 'std', 'parent', 800000, 80000, t, t),
    item('std_relay', 'GeoBase Repeater（中継機）', '基地局', 'std', 'relay', 400000, 40000, t, t),
    item('std_solar', '一体型ソーラーバッテリー', '基地局', 'std', 'relaySolar', 100000, 0, f, f, '中継機と同数を自動計上'),
    item('geochat', 'GeoChat', '子機', '', 'chat', 50000, 1000, t, f),
    item('geowana', 'GeoWana', '子機', '', '', 50000, 1000, t, f),
    item('geoconnect', 'GeoConnect', '子機', '', 'connect', 200000, 2000, t, t, ''),
    item('connect_solar', 'ソーラーバッテリー（GeoConnect用）', '子機', '', 'connectSolar', 100000, 0, f, f, 'GeoConnect と同数を自動計上'),
    item('geocam', 'GeoCam', '子機', '', '', 200000, 0, t, f, ''),
    item('geochat_router', 'GeoChat Router', 'オプション', '', 'router', 50000, 0, t, f, 'GeoChat の台数から自動計上'),
    item('geovital_ms200', 'GeoVital（MULiSiTEN MS200）', 'オプション', '', 'vital', 30000, 0, t, f),
    item('geovital_verity', 'GeoVital（Verity Sense）', 'オプション', '', 'vital', 10000, 0, t, f),
    item('geoflash', 'GeoFlash', 'オプション', '', '', 100000, 0, f, f, ''),
    item('sensor_rain', '雨量計', 'センサー', '', '', 100000, 0, t, f, ''),
    item('sensor_water', '水位計', 'センサー', '', '', 100000, 0, t, f, ''),
    item('sensor_temp', '温度・湿度センサー', 'センサー', '', '', 100000, 0, t, f, ''),
    item('sensor_contact', '接点入力', 'センサー', '', '', 100000, 0, t, f, ''),
    item('sensor_other', 'その他センサー', 'センサー', '', '', 100000, 0, t, f, ''),
  ];
  rows.forEach(function (r, i) { r.sort = (i + 1) * 10; });
  return rows;
}

function DEFAULT_OPTIONS_() {
  return {
    industry: ['国・都道府県・市区町村などの行政機関', '森林組合・林業事業体（その他木材関連含む）', '建設・土木・測量・コンサルティング', '大学・研究機関', '防災・インフラ関連', '通信・IoT・センサー関連', 'ドローン・衛星・測量関連', 'エネルギー・電源・バッテリー関連', '農業・水産・地域産業関連', '商社・販売代理店', 'その他'],
    division: ['林業・森林整備', '農林水産', '防災・危機管理', '地域振興・地方創生', 'DX・ICT・情報システム', 'インフラ・施設管理', '総務・経営企画', '新規事業・研究開発', '安全衛生・労務管理', 'その他'],
    usage: ['林業作業者・現場作業員の安全見守り', '林業現場の位置情報・作業状況把握', '獣害対策', '森林・林道・作業道の監視', '気象・雨量・温湿度の観測', '河川・ため池・水位の監視', '積雪・雪崩・融雪の監視', '山間部・僻地の通信確保', '災害時の安否確認・情報共有', '地域インフラ・エネルギー設備の見守り', '登山・川下りなどアウトドア利用者の見守り', 'スマート林業・森林DX', 'その他'],
    product: ['GeoChat', 'GeoWana', 'GeoConnect', 'GeoWeather', 'GeoVital', 'GeoFlash', 'GeoCam', '衛星通信', 'ハイクカム', 'センサー・IoT監視システム', 'その他'],
    material: ['会社案内', 'GeoChatパンフレット', '会社紹介スライド', 'GeoVitalチラシ', '農林中金カタログ抜粋資料', '日吉町森林組合様 わかばプロジェクト資料', '渡していない'],
    status: ['具体的な用途があり導入を前向きに検討', '情報収集・将来の検討', '協業・販売代理店を検討', '関心はあるが現時点では導入予定なし', '挨拶・既存顧客対応', '関心なし'],
    priority: ['最優先：導入・協業の可能性が高く、早期フォローが必要', '優先：関心・課題が明確で、継続フォローが必要', '通常：情報提供・将来に向けたフォロー', 'フォロー対象外：導入意欲・関連性が薄い'],
    subsidy: ['【総務省】地域DX推進パッケージ', '【内閣府】新しい地方経済・生活環境創生交付金（旧デジタル田園都市国家構想交付金）', '【農水省】農山漁村振興交付金', '【林野庁】林業労働安全確保対策事業', '【農林中金】林業労働安全性向上対策事業', '森林環境譲与税', '県・市町村の自主財源', '補助金・財源は未定', 'その他'],
    timing: ['1年以内', '1～3年以内', '時期未定', '導入予定なし'],
    nextAction: ['資料・見積書を送付', 'オンラインまたは訪問で商談', 'デモ・製品説明', 'テスト導入・実証実験の相談', '補助金・導入事例の情報提供', '販売代理店・協業の相談', '特になし'],
    staff: ['担当者A', '担当者B', '担当者C', '担当者D'],
  };
}
