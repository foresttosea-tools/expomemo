// gas/Code.gs を、スプレッドシートを真似た簡易フェイクの上で動かすテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ITEMS, DEFAULT_OPTIONS } from '../js/defaults.js';

function makeSheet(name) {
  const data = [];
  const width = () => Math.max(0, ...data.map((r) => r.length));
  const range = (r, c, nr = 1, nc = 1) => ({
    setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => { (data[r - 1 + i] ??= [])[c - 1 + j] = v; })); return this; },
    setValue(v) { (data[r - 1] ??= [])[c - 1] = v; return this; },
    getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => data[r - 1 + i]?.[c - 1 + j] ?? '')); },
    clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = ''; return this; },
    setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }, setNumberFormat() { return this; },
  });
  const lastRow = () => {
    for (let i = data.length - 1; i >= 0; i--) if ((data[i] || []).some((v) => v !== '' && v !== undefined)) return i + 1;
    return 0;
  };
  return {
    name, data,
    getLastRow: lastRow,
    getLastColumn: () => width(),
    getMaxRows: () => Math.max(1000, data.length),
    getRange: range,
    getDataRange: () => range(1, 1, lastRow(), width()),
    appendRow: (row) => { data.splice(lastRow(), 0, [...row]); },
    insertRowBefore: (r) => { data.splice(r - 1, 0, []); },
    setFrozenRows() {},
  };
}

function loadGas(seedSource = '') {
  const sheets = {};
  const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };
  const file = { getId: () => 'file1', getUrl: () => 'https://drive/file1' };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Utilities: {
      getUuid: () => randomUUID(),
      formatDate: (d) => d.toISOString().replace(/\D/g, '').slice(2, 14),
      base64Decode: (s) => Buffer.from(s, 'base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name, getContentType: () => type }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    ContentService: { createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    DriveApp: { createFolder: () => ({ getId: () => 'folder1', createFile: () => file }), getFolderById: () => ({ createFile: () => file }) },
    MimeType: { GOOGLE_DOCS: 'application/vnd.google-apps.document' },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), ctx);
  if (seedSource) vm.runInContext(seedSource, ctx);
  ctx.setup();
  const setting = (k) => sheets.settings.data.find((r) => r[0] === k)[1];
  const token = setting('token');
  const adminToken = setting('adminToken');
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token, ...body }) } }).text);
  return { sheets, token, adminToken, post };
}

test('setup でシートと 2 種類のパスワードができ、パスワードは返さない', () => {
  const { post, sheets, token, adminToken } = loadGas();
  assert.ok(token.length >= 8 && adminToken.length >= 8 && token !== adminToken);
  for (const n of ['leads', 'settings', 'items', 'options']) assert.ok(sheets[n], n);
  assert.equal(sheets.quotes, undefined, 'QR 用シートは作らない');
  assert.equal(post({ action: 'getConfig', token: 'wrong' }).error, 'unauthorized');
  const cfg = post({ action: 'getConfig' });
  assert.equal(cfg.settings.token, undefined);
  assert.equal(cfg.settings.adminToken, undefined);
  assert.equal(cfg.settings.laborPerUnit, 100000, 'Seed.gs がなければダミー値');
});

test('GAS の初期データはアプリの初期データ（js/defaults.js）と同じ', () => {
  const { post } = loadGas();
  const cfg = post({ action: 'getConfig' });
  const pick = (it) => [it.key, it.name, it.group, it.baseType, it.role, Number(it.price), Number(it.cloudYearly), Boolean(it.countSetup), Boolean(it.countInstall)];
  assert.deepEqual(cfg.items.map(pick), DEFAULT_ITEMS.map(pick));
  assert.deepEqual(cfg.options, DEFAULT_OPTIONS);
});

test('保存・一覧・更新（電話番号や数式も文字のまま）', () => {
  const { post } = loadGas();
  const saved = post({ action: 'saveLead', mode: 'new', lead: { company: '株式会社テスト', name: '田中 一郎', phone1: '03-1111-2222', postalCode: '100-0001', memo: '=1+1' } });
  assert.equal(saved.ok, true);
  let [l] = post({ action: 'listLeads' }).leads;
  assert.equal(l.phone1, '03-1111-2222');
  assert.equal(l.postalCode, '100-0001');
  assert.equal(l.memo, '=1+1');
  post({ action: 'updateLead', id: saved.id, changes: { priority: '優先：関心・課題が明確で、継続フォローが必要' }, original: { priority: '' } });
  [l] = post({ action: 'listLeads' }).leads;
  assert.match(l.priority, /^優先/);
  assert.equal(l.company, '株式会社テスト');
});

test('重複チェックと追記（複数選択の項目は合わせる）', () => {
  const { post } = loadGas();
  const { id } = post({ action: 'saveLead', mode: 'new', lead: { company: '株式会社テスト', name: '田中 一郎', products: 'GeoChat', usages: '獣害対策', memo: '初日', status: '情報収集・将来の検討' } });
  const dup = post({ action: 'checkDuplicate', lead: { company: '(株)テスト', name: '田中一郎' } });
  assert.deepEqual(dup.matches[0].reasons, ['会社名と氏名が一致']);
  assert.equal(post({ action: 'checkDuplicate', lead: { company: '別の会社' } }).matches.length, 0);
  post({ action: 'saveLead', mode: 'append', targetId: id, lead: { email: 'a@b.jp', products: 'GeoCam、GeoChat', usages: 'その他：雪対策', memo: '2日目', staff: '担当者C', status: '具体的な用途があり導入を前向きに検討' } });
  const [l] = post({ action: 'listLeads' }).leads;
  assert.equal(l.email, 'a@b.jp');
  assert.equal(l.products, 'GeoChat、GeoCam');
  assert.equal(l.usages, '獣害対策、その他：雪対策');
  assert.equal(l.status, '具体的な用途があり導入を前向きに検討');
  assert.match(l.memo, /^初日\n\n\[.+担当者C\] 2日目$/);
});

test('管理者の操作は管理者パスワードが必要', () => {
  const { post, adminToken } = loadGas();
  assert.equal(post({ action: 'adminCheck' }).error, 'admin_unauthorized');
  assert.equal(post({ action: 'saveAll', adminToken: 'wrong' }).error, 'admin_unauthorized');
  assert.equal(post({ action: 'adminCheck', adminToken }).ok, true);
  assert.equal(post({ action: 'saveEvent', adminToken }).error, 'unknown_action', '個別保存は廃止');
});

function adminState(post) {
  const cfg = post({ action: 'getConfig' });
  return { event: { name: 'FORESTRISE2026', start: '2026-09-16', end: '2026-09-18' }, items: cfg.items, staff: cfg.options.staff };
}

test('展示会・品目・担当者をまとめて保存', () => {
  const { post, adminToken } = loadGas();
  const st = adminState(post);
  st.items[0].price = '1,234,567';
  st.items[7].active = false;
  st.items.push({ key: 'custom_x', name: '積雪計', group: 'センサー', price: 300000, cloudYearly: 0 });
  st.staff = ['担当者A', ' 担当者B ', '', '新人'];
  assert.equal(post({ action: 'saveAll', adminToken, ...st }).ok, true);
  const cfg = post({ action: 'getConfig' });
  assert.equal(cfg.settings.eventName, 'FORESTRISE2026');
  assert.equal(cfg.settings.eventStart, '2026-09-16');
  assert.equal(cfg.settings.eventEnd, '2026-09-18');
  assert.equal(cfg.items.length, DEFAULT_ITEMS.length + 1);
  assert.equal(cfg.items[0].price, 1234567);
  assert.equal(cfg.items[7].active, false);
  assert.deepEqual(cfg.options.staff, ['担当者A', '担当者B', '新人']);
  assert.deepEqual(cfg.options.industry, DEFAULT_OPTIONS.industry, 'ほかの選択肢は消えない');
});

test('1 つでも問題があれば何も保存しない', () => {
  const { post, adminToken } = loadGas();
  const cases = [
    (st) => { st.event.end = '2026-09-01'; },
    (st) => { st.event.name = ' '; },
    (st) => { st.items[0].name = ''; },
    (st) => { st.items.push({ key: 'x', name: 'X', group: '謎' }); },
    (st) => { st.staff = []; },
  ];
  for (const breakIt of cases) {
    const st = adminState(post);
    st.items[1].price = 1;
    st.staff = ['変更した人'];
    breakIt(st);
    const res = post({ action: 'saveAll', adminToken, ...st });
    assert.equal(res.ok, false);
    const cfg = post({ action: 'getConfig' });
    assert.equal(cfg.settings.eventName, '');
    assert.notEqual(cfg.items[1].price, 1);
    assert.deepEqual(cfg.options.staff, DEFAULT_OPTIONS.staff);
  }
});

test('Seed.gs（SEED）があれば、その値でセットアップする', () => {
  const seed = `var SEED = {
    settings: { laborPerUnit: 4321, chatsPerRouter: 9, companyName: 'テスト社' },
    staff: ['山田', '佐藤'],
    items: [{ key: 'x1', name: 'テスト親機', group: '基地局', baseType: 'multi', role: 'parent', price: 99, cloudYearly: 1, unit: '台', countSetup: true, countInstall: true, active: true, note: '' }],
  };`;
  const { post } = loadGas(seed);
  const cfg = post({ action: 'getConfig' });
  assert.equal(cfg.settings.laborPerUnit, 4321);
  assert.equal(cfg.settings.chatsPerRouter, 9);
  assert.equal(cfg.settings.companyName, 'テスト社');
  assert.equal(cfg.settings.vehiclePerUnit, 10000, 'SEED にない項目はダミー値');
  assert.deepEqual(cfg.options.staff, ['山田', '佐藤']);
  assert.deepEqual(cfg.options.industry, DEFAULT_OPTIONS.industry);
  assert.deepEqual(cfg.items.map((it) => [it.key, it.price]), [['x1', 99]]);
});

test('非公開の Seed.gs はリポジトリに含めない', () => {
  assert.match(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'), /^gas\/Seed\.gs$/m);
});

test('編集：変えた項目だけ更新し、ほかの人の追記は消さない', () => {
  const { post } = loadGas();
  const { id } = post({ action: 'saveLead', mode: 'new', lead: { company: '株式会社テスト', name: '田中', event: '展示会A', memo: '初日', phone1: '' } });
  // A さんが開く → B さんが追記 → A さんが電話番号だけ直して保存
  const opened = post({ action: 'listLeads' }).leads[0];
  post({ action: 'saveLead', mode: 'append', targetId: id, lead: { memo: '2日目', staff: 'B', products: 'GeoCam' } });
  const res = post({ action: 'updateLead', id, changes: { phone1: '03-1111-2222' }, original: { phone1: opened.phone1 } });
  assert.equal(res.ok, true);
  const l = post({ action: 'listLeads' }).leads[0];
  assert.equal(l.phone1, '03-1111-2222');
  assert.match(l.memo, /初日[\s\S]*2日目/, 'B さんの追記が残る');
  assert.equal(l.products, 'GeoCam');
  assert.equal(l.event, '展示会A', '展示会名は変わらない');
});

test('編集：同じ項目がほかの人に変更されていたら conflict、force なら上書き', () => {
  const { post } = loadGas();
  const { id } = post({ action: 'saveLead', mode: 'new', lead: { company: 'テスト', name: '田中', memo: '初日' } });
  post({ action: 'saveLead', mode: 'append', targetId: id, lead: { memo: '2日目', staff: 'B' } });
  const res = post({ action: 'updateLead', id, changes: { memo: '初日（修正）' }, original: { memo: '初日' } });
  assert.equal(res.error, 'conflict');
  assert.deepEqual(res.fields, ['memo']);
  assert.match(post({ action: 'listLeads' }).leads[0].memo, /2日目/, 'conflict のときは何も書き込まない');
  assert.equal(post({ action: 'updateLead', id, changes: { memo: '初日（修正）' }, original: { memo: '初日' }, force: true }).ok, true);
  assert.equal(post({ action: 'listLeads' }).leads[0].memo, '初日（修正）');
});

test('追記：「その他：〇〇」は最後に並ぶ', () => {
  const { post } = loadGas();
  const { id } = post({ action: 'saveLead', mode: 'new', lead: { company: 'テスト', usages: '獣害対策、その他：雪対策' } });
  post({ action: 'saveLead', mode: 'append', targetId: id, lead: { usages: 'スマート林業・森林DX' } });
  assert.equal(post({ action: 'listLeads' }).leads[0].usages, '獣害対策、スマート林業・森林DX、その他：雪対策');
});
