// お試しモード：GAS と同じ応答を端末内（localStorage）だけで返す。
// 利用者パスワードは "demo"、管理者パスワードは "admin"。データはこのブラウザにしか残らない。
import { DEFAULT_ITEMS, DEFAULT_OPTIONS, DEFAULT_SETTINGS } from './defaults.js';

const KEY = 'expomemo.mock.v2';
const TOKEN = 'demo';
const ADMIN_TOKEN = 'admin';

const SAMPLE_CARD = [
  '株式会社サンプル電機',
  '営業本部 第一営業部 部長',
  '山田 太郎',
  'やまだ たろう',
  '〒100-0001',
  '東京都千代田区千代田1-1-1 サンプルビル5F',
  'TEL 03-1234-5678 FAX 03-1234-5679',
  '携帯 090-1111-2222',
  'E-mail: t.yamada@sample.co.jp',
  'https://www.sample.co.jp',
  'GEO-WAVE で山をつなぐ',
].join('\n');

const CUSTOMER_FIELDS = ['company', 'department', 'title', 'name', 'kana', 'email', 'phone1', 'phone2', 'postalCode', 'prefecture', 'city', 'addressLine', 'cardFileId', 'cardUrl'];
const LIST_FIELDS = ['usages', 'products', 'materials', 'subsidies', 'nextActions'];
const ESTIMATE_FIELDS = ['estimateSkipped', 'estimateMode', 'baseType', 'areaKm2', 'initialTotal', 'runningYearly', 'estimateSummary', 'estimateJson'];

function isoDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function freshDb() {
  return {
    leads: [],
    settings: { ...DEFAULT_SETTINGS, eventName: 'サンプル展示会（お試し）', eventStart: isoDate(-1), eventEnd: isoDate(1) },
    items: DEFAULT_ITEMS.map((it) => ({ ...it, active: true })),
    options: JSON.parse(JSON.stringify(DEFAULT_OPTIONS)),
  };
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || freshDb();
  } catch {
    return freshDb();
  }
}
function save(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();
const normCompany = (s) => norm(s).replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|一般社団法人|一般財団法人|公益社団法人|公益財団法人/g, '');
const union = (a, b) => {
  const all = [...new Set([...(a || '').split('、'), ...(b || '').split('、')].map((s) => s.trim()).filter(Boolean))];
  return [...all.filter((s) => !s.startsWith('その他')), ...all.filter((s) => s.startsWith('その他'))].join('、');
};

export async function mockCall(action, req) {
  await wait(200);
  if (req.token !== TOKEN) return { ok: false, error: 'unauthorized' };
  const db = load();
  const now = new Date().toISOString();

  if (['adminCheck', 'saveAll'].includes(action) && req.adminToken !== ADMIN_TOKEN) {
    return { ok: false, error: 'admin_unauthorized' };
  }

  switch (action) {
    case 'getConfig':
      return { ok: true, settings: db.settings, items: db.items, options: db.options };

    case 'listLeads':
      return { ok: true, leads: [...db.leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };

    case 'checkDuplicate': {
      const l = req.lead || {};
      const matches = db.leads
        .map((x) => {
          const reasons = [];
          if (l.email && norm(x.email) === norm(l.email)) reasons.push('メールが一致');
          if (l.company && normCompany(x.company) === normCompany(l.company)) reasons.push(l.name && norm(x.name) === norm(l.name) ? '会社名と氏名が一致' : '会社名が一致');
          if (!l.company && l.name && norm(x.name) === norm(l.name)) reasons.push('氏名が一致');
          return reasons.length ? { id: x.id, company: x.company, name: x.name, staff: x.staff, event: x.event, createdAt: x.createdAt, reasons } : null;
        })
        .filter(Boolean);
      return { ok: true, matches };
    }

    case 'saveLead': {
      const lead = req.lead || {};
      if (req.mode === 'append' && req.targetId) {
        const cur = db.leads.find((x) => x.id === req.targetId);
        if (!cur) return { ok: false, error: 'not_found' };
        for (const k of [...CUSTOMER_FIELDS, 'industry', 'division', 'timing']) if (!cur[k] && lead[k]) cur[k] = lead[k];
        for (const k of ['status', 'priority', 'event', 'visitDate']) if (lead[k]) cur[k] = lead[k];
        for (const k of LIST_FIELDS) cur[k] = union(cur[k], lead[k]);
        if (lead.memo) {
          const d = new Date();
          const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${lead.staff || ''}`.trim();
          cur.memo = `${cur.memo ? `${cur.memo}\n\n` : ''}[${stamp}] ${lead.memo}`;
        }
        if (lead.estimateJson && lead.estimateSkipped !== 'TRUE') for (const k of ESTIMATE_FIELDS) cur[k] = lead[k];
        cur.updatedAt = now;
        save(db);
        return { ok: true, id: cur.id };
      }
      const id = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      db.leads.push({ ...lead, id, createdAt: now, updatedAt: now });
      save(db);
      return { ok: true, id };
    }

    case 'updateLead': {
      const cur = db.leads.find((x) => x.id === req.id);
      if (!cur) return { ok: false, error: 'not_found' };
      // GAS と同じ：変更した項目だけを反映し、開いたあとに同じ項目が変わっていたら conflict
      const changes = req.changes || req.lead || {};
      const keys = Object.keys(changes).filter((k) => !['id', 'createdAt', 'updatedAt'].includes(k));
      if (req.original && !req.force) {
        const fields = keys.filter((k) => String(cur[k] ?? '') !== String(req.original[k] ?? ''));
        if (fields.length) return { ok: false, error: 'conflict', fields };
      }
      for (const k of keys) cur[k] = changes[k];
      cur.updatedAt = now;
      save(db);
      return { ok: true, id: cur.id };
    }

    case 'uploadCard':
      await wait(700);
      return { ok: true, fileId: `mock-${Date.now()}`, url: '', text: req.ocr ? SAMPLE_CARD : '' };

    case 'adminCheck':
      return { ok: true };

    case 'saveAll': {
      // 先に全部チェックし、1 つでも問題があれば何も保存しない（GAS と同じ）
      const ev = req.event || {};
      if (!String(ev.name || '').trim()) return { ok: false, error: 'invalid', message: '展示会名を入力してください' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.start) || !/^\d{4}-\d{2}-\d{2}$/.test(ev.end) || ev.start > ev.end) return { ok: false, error: 'invalid', message: '会期の日付を確認してください' };
      const items = req.items || [];
      if (!items.length || items.some((it) => !String(it.name || '').trim())) return { ok: false, error: 'invalid', message: '品目名が空欄の行があります' };
      if (new Set(items.map((it) => it.key)).size !== items.length) return { ok: false, error: 'invalid', message: '品目の識別子が重複しています' };
      const names = [...new Set((req.staff || []).map((n) => String(n || '').trim()).filter(Boolean))];
      if (!names.length) return { ok: false, error: 'invalid', message: '担当者を 1 人以上入れてください' };
      Object.assign(db.settings, { eventName: ev.name.trim(), eventStart: ev.start, eventEnd: ev.end });
      db.items = items.map((it, i) => ({ ...it, name: String(it.name).trim(), price: Math.max(0, Number(it.price) || 0), cloudYearly: Math.max(0, Number(it.cloudYearly) || 0), sort: (i + 1) * 10 }));
      db.options.staff = names;
      save(db);
      return { ok: true };
    }

    default:
      return { ok: false, error: 'unknown_action' };
  }
}
