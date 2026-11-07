// 見積もり計算のテスト。値はすべて架空（本番の単価・ルールはリポジトリに置かない）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestCounts, routersFor, computeEstimate, initEstimateState, normalizeItems, workCost, priceRange, formatRange, summarizeEstimate,
} from '../js/estimate.js';
import { DEFAULT_ITEMS } from '../js/defaults.js';

// テスト用の架空ルール
const R = {
  parentAreaKm2: 400, relayAreaKm2: 40, rangeLowPct: -10, rangeHighPct: 20,
  laborPerUnit: 1000, travelPer5Units: 3000, vehiclePerUnit: 100, fuelPerUnit: 10, lodgingPerUnit: 50,
  overheadPct: 10, specialPerDay: 7000, setupFeePerUnit: 3, contractFee: 11, maintenancePct: 25, chatsPerRouter: 6,
};
const line = (r, key) => r.lines.find((l) => l.key === key);
const work = (r, key) => r.work.find((w) => w.key === key);
const price = (key) => DEFAULT_ITEMS.find((it) => it.key === key).price;
const cloud = (key) => DEFAULT_ITEMS.find((it) => it.key === key).cloudYearly;

test('面積から親機・中継機の台数を出す（切り上げ・最低 1 台）', () => {
  assert.deepEqual(suggestCounts(400, R), { parent: 1, relay: 10 });
  assert.deepEqual(suggestCounts(800, R), { parent: 2, relay: 20 }, '割り切れるときに浮動小数の誤差で切り上がらない');
  assert.deepEqual(suggestCounts(801, R), { parent: 3, relay: 21 });
  assert.deepEqual(suggestCounts(1, R), { parent: 1, relay: 1 });
  assert.deepEqual(suggestCounts('', R), { parent: 0, relay: 0 });
});

test('GeoChat Router は chatsPerRouter 台ごとに 1 台（端数切り上げ）', () => {
  assert.equal(routersFor(0, R), 0);
  assert.equal(routersFor(1, R), 1);
  assert.equal(routersFor(12, R), 2);
  assert.equal(routersFor(13, R), 3);
});

test('基地局タブで機種と中継機用ソーラーが切り替わる', () => {
  const s = initEstimateState();
  s.qty.parent = 2;
  s.qty.relay = 20;
  let r = computeEstimate(DEFAULT_ITEMS, s, R);
  assert.equal(line(r, 'multi_parent').subtotal, 2 * price('multi_parent'));
  assert.equal(line(r, 'multi_solar').qty, 20);
  assert.equal(line(r, 'std_parent'), undefined);
  s.baseType = 'std';
  r = computeEstimate(DEFAULT_ITEMS, s, R);
  assert.equal(line(r, 'std_parent').qty, 2);
  assert.equal(line(r, 'std_solar').subtotal, 20 * price('std_solar'));
  assert.equal(line(r, 'multi_parent'), undefined);
  s.solarOff.std_solar = true;
  assert.equal(line(computeEstimate(DEFAULT_ITEMS, s, R), 'std_solar').qty, 0);
});

test('GeoConnect 用ソーラーは GeoConnect と同数', () => {
  const s = initEstimateState();
  s.qty.geoconnect = 3;
  assert.equal(line(computeEstimate(DEFAULT_ITEMS, s, R), 'connect_solar').qty, 3);
});

test('GeoVital は選んだ機種だけ計上', () => {
  const s = initEstimateState();
  s.vital = { on: true, model: 'geovital_verity', qty: 10 };
  const r = computeEstimate(DEFAULT_ITEMS, s, R);
  assert.equal(line(r, 'geovital_verity').subtotal, 10 * price('geovital_verity'));
  assert.equal(line(r, 'geovital_ms200').qty, 0);
  s.vital.on = false;
  assert.equal(line(computeEstimate(DEFAULT_ITEMS, s, R), 'geovital_verity').qty, 0);
});

test('現地調査・設置工事の計算', () => {
  const w = workCost(10, 0, R);
  const base = 10 * 1000 + 2 * 3000 + 10 * 100 + 10 * 10 + 9 * 50;
  assert.equal(w.total, base + Math.round(base * 0.1));
  assert.deepEqual(w.breakdown.map((b) => b.label), ['人件費', '往復交通費', '車両費', '燃料費', '宿泊費', '諸経費']);
});

test('往復交通費は 5 台ごと、特殊技術対策費は諸経費の対象外', () => {
  const amount = (n, d, label) => workCost(n, d, R).breakdown.find((b) => b.label === label)?.amount;
  assert.equal(amount(5, 0, '往復交通費'), 3000);
  assert.equal(amount(6, 0, '往復交通費'), 6000);
  assert.equal(amount(11, 0, '往復交通費'), 9000);
  assert.equal(amount(1, 0, '宿泊費'), undefined, '1 台なら宿泊なし');
  assert.equal(workCost(1, 2, R).total, Math.round((1000 + 3000 + 100 + 10) * 1.1) + 2 * 7000);
  assert.equal(workCost(0, 0, R).total, 0);
});

test('工事の台数は親機＋中継機＋GeoConnect（センサー・Router は含めない）', () => {
  const s = initEstimateState();
  s.qty.parent = 1;
  s.qty.relay = 4;
  s.qty.geoconnect = 5;
  s.qty.sensor_rain = 3;
  s.qty.router = 2;
  s.specialDays = { install: 1, survey: 0 };
  const r = computeEstimate(DEFAULT_ITEMS, s, R);
  assert.equal(r.installUnits, 10);
  assert.equal(work(r, 'install').subtotal, workCost(10, 0, R).total + 7000);
  assert.equal(work(r, 'survey').subtotal, workCost(10, 0, R).total);
  assert.deepEqual(r.work.map((w) => w.key).slice(0, 2), ['survey', 'install'], '現地調査が先');
});

test('初期設定費：ソーラーと GeoFlash は数えない、センサーと Router は数える', () => {
  const s = initEstimateState();
  s.qty.parent = 1;
  s.qty.relay = 2; // ソーラー 2 台は対象外
  s.qty.geochat = 10;
  s.qty.router = 2;
  s.qty.geoflash = 3;
  s.qty.sensor_water = 1;
  const r = computeEstimate(DEFAULT_ITEMS, s, R);
  assert.equal(r.setupCount, 1 + 2 + 10 + 2 + 1);
  assert.equal(work(r, 'setup').subtotal, 16 * 3);
});

test('契約事務手数料は機器があるときだけ', () => {
  const s = initEstimateState();
  assert.equal(work(computeEstimate(DEFAULT_ITEMS, s, R), 'contract'), undefined);
  s.qty.geochat = 1;
  assert.equal(work(computeEstimate(DEFAULT_ITEMS, s, R), 'contract').subtotal, 11);
});

test('ランニング（年額）：クラウド利用料と保守費', () => {
  const s = initEstimateState();
  s.maintenanceOff = false;
  s.qty.parent = 1;
  s.qty.relay = 1;
  s.qty.geochat = 10;
  s.qty.sensor_rain = 1;
  const r = computeEstimate(DEFAULT_ITEMS, s, R);
  assert.equal(r.equipmentTotal, price('multi_parent') + price('multi_relay') + price('multi_solar') + 10 * price('geochat') + price('sensor_rain'));
  assert.equal(r.cloudYearly, cloud('multi_parent') + cloud('multi_relay') + 10 * cloud('geochat'));
  assert.equal(r.maintenanceYearly, Math.round(r.equipmentTotal * 0.25));
  assert.equal(r.runningYearly, r.cloudYearly + r.maintenanceYearly);
  assert.equal(r.initialTotal, r.equipmentTotal + r.work.reduce((a, w) => a + w.subtotal, 0));
  assert.match(summarizeEstimate(r), /^GeoBase Multi（親機）×1、/);
});

test('保守費は初期状態で「なし」、オンにすると計上', () => {
  const s = initEstimateState();
  s.qty.geochat = 10;
  assert.equal(computeEstimate(DEFAULT_ITEMS, s, R).maintenanceYearly, 0);
  s.maintenanceOff = false;
  assert.equal(computeEstimate(DEFAULT_ITEMS, s, R).maintenanceYearly, Math.round(10 * price('geochat') * 0.25));
});

test('整形済みの品目を渡しても同じ結果', () => {
  const s = initEstimateState();
  s.qty.parent = 2;
  s.qty.relay = 20;
  assert.equal(computeEstimate(normalizeItems(DEFAULT_ITEMS), s, R).initialTotal, computeEstimate(DEFAULT_ITEMS, s, R).initialTotal);
});

test('active=FALSE の品目と、単価のカンマ表記', () => {
  const items = [{ key: 'a', name: 'A', group: '子機', price: '1,200円' }, { key: 'b', name: 'B', group: '子機', price: 100, active: 'FALSE' }];
  const s = initEstimateState();
  s.qty.a = 2;
  s.qty.b = 1;
  const r = computeEstimate(items, s, R);
  assert.equal(r.equipmentTotal, 2400);
  assert.equal(r.lines.length, 1);
});

test('概算の幅は −10%〜＋20%', () => {
  assert.equal(formatRange(priceRange(12_345_678, R)), '約1,111万円〜1,482万円');
  assert.deepEqual(priceRange(0, R), { low: 0, high: 0 });
});
