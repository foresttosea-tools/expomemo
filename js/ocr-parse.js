// 名刺 OCR テキストの項目振り分け（DOM に依存しない純粋関数）

export const CARD_FIELDS = [
  { key: 'company', label: 'ご所属（会社名・団体名）', required: true },
  { key: 'department', label: '部署' },
  { key: 'title', label: '役職' },
  { key: 'name', label: 'お名前', required: true },
  { key: 'kana', label: 'ふりがな' },
  { key: 'email', label: 'メール' },
  { key: 'phone1', label: '電話番号①' },
  { key: 'phone2', label: '電話番号②' },
  { key: 'postalCode', label: '郵便番号' },
  { key: 'prefecture', label: '都道府県' },
  { key: 'city', label: '市区町村' },
  { key: 'addressLine', label: '住所（それ以降）' },
];

const ADDRESS_KEYS = ['postalCode', 'prefecture', 'city', 'addressLine'];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const URL_RE = /(https?:\/\/\S+|www\.\S+|\S+\.(?:co\.jp|or\.jp|go\.jp|lg\.jp|ac\.jp|ne\.jp|jp|com|net|org)(?:\/\S*)?$)/i;
const PHONE_RE = /(?:\+81[-\s]?\(?0?\)?|0)\d{1,4}[-\s()]{0,2}\d{1,4}[-\s()]{0,2}\d{3,4}/g;
const POSTAL_RE = /〒?\s?\d{3}-\d{4}/;
const PREF_RE = /(北海道|東京都|大阪府|京都府|(?:青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県)/;
const ADDRESS_CONT_RE = /(\d+[-ー－]\d+|丁目|番地?|号|ビル|階|\dF\b)/;
const COMPANY_RE = /(株式会社|有限会社|合同会社|合資会社|\(株\)|\(有\)|一般社団法人|公益社団法人|一般財団法人|公益財団法人|社団法人|財団法人|NPO法人|特定非営利活動法人|独立行政法人|国立研究開発法人|協同組合|組合|協会|大学|役場|役所|県庁|都庁|府庁|道庁|省$|庁$|\bCo\.|\bInc\.?|\bLtd\.?|\bLLC\b|Corporation|\bCorp\.?)/i;
const MUNICIPALITY_RE = /^\S{1,12}(市|町|村|区|県|都|府)$/;
const TITLE_RE = /(代表取締役|取締役|執行役員|会長|副社長|社長|専務|常務|部長|次長|課長補佐|課長|係長|主任|主査|主事|主幹|参事|技師|室長|所長|センター長|局長|班長|リーダー|マネージャー|マネジャー|Manager|Director|CEO|CTO|COO|President|Engineer)/i;
const DEPT_RE = /(本部|事業部|部|課|室|係|班|グループ|チーム|センター|支店|支社|営業所|局|Division|Department|Dept)/i;
const KANA_RE = /^[ぁ-ゟ゠-ヿ\s・ー]+$/;
const NAME_RE = /^[㐀-鿿ぁ-ゟ゠-ヿ々〆ヶ]{1,6}(?:\s+[㐀-鿿ぁ-ゟ゠-ヿ々〆ヶ]{1,6})?$/;
const FAX_LABEL_RE = /(FAX|Fax|fax|ファックス|ファクス|F\s*[:.]?\s*$)/;
const MOBILE_LABEL_RE = /(携帯|Mobile|MOBILE|Cell|M\s*[:.]?\s*$)/;

/** OCR 結果を行に分け、正規化する */
export function splitLines(text) {
  return String(text || '')
    .normalize('NFKC')
    .split(/\r?\n/)
    .map((l) => l.replace(/[‐−–—ー―](?=\d)|(?<=\d)[‐−–—ー―]/g, '-').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

/**
 * 名刺テキストを項目に振り分ける
 * @returns {{ fields: Record<string,string>, lines: {text:string, field:string|null}[] }}
 */
export function parseCardText(text) {
  const lines = splitLines(text).map((t) => ({ text: t, field: null }));
  const fields = {};
  const set = (key, value) => {
    if (!value) return;
    if (!fields[key]) fields[key] = value;
  };

  // 1. メール・URL・電話・住所（パターンで確実に取れるもの）
  for (const line of lines) {
    const compact = line.text.replace(/\s*@\s*/g, '@');
    const email = compact.match(EMAIL_RE);
    if (email) {
      set('email', email[0].toLowerCase());
      line.field = 'email';
      continue;
    }
    const phones = extractPhones(line.text).filter((p) => p.kind !== 'fax');
    if (phones.length || extractPhones(line.text).length) {
      let first = null;
      for (const p of phones) {
        const slot = !fields.phone1 ? 'phone1' : !fields.phone2 ? 'phone2' : null;
        if (!slot) break;
        fields[slot] = p.number;
        first ??= slot;
      }
      line.field = first || 'ignore';
      continue;
    }
    if (URL_RE.test(line.text) && !/[㐀-鿿]/.test(line.text)) {
      line.field = 'ignore';
      continue;
    }
  }

  // 住所：郵便番号の行を最優先、なければ番地（数字）を含む都道府県の行を起点に、続きの行もまとめる
  // 「山梨県北杜市」のように数字のない自治体名だけの行は、住所ではなく団体名として残す
  const isAddressStart = (t) => POSTAL_RE.test(t) || (PREF_RE.test(t) && /\d/.test(t));
  const addressOrder = [...lines.keys()].sort((a, b) => Number(POSTAL_RE.test(lines[b].text)) - Number(POSTAL_RE.test(lines[a].text)));
  for (const i of addressOrder) {
    const line = lines[i];
    if (line.field) continue;
    if (isAddressStart(line.text)) {
      const parts = [line.text];
      line.field = 'addressLine';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.field) break;
        if (ADDRESS_CONT_RE.test(next.text) && !COMPANY_RE.test(next.text) && !TITLE_RE.test(next.text)) {
          parts.push(next.text);
          next.field = 'addressLine';
        } else break;
      }
      // 郵便番号だけの行の直後に住所が来るパターン
      if (/^〒?\s?\d{3}-\d{4}$/.test(line.text) && i + 1 < lines.length && !lines[i + 1].field) {
        parts.push(lines[i + 1].text);
        lines[i + 1].field = 'addressLine';
      }
      const addr = splitAddress(parts.join(' '));
      for (const k of ADDRESS_KEYS) set(k, addr[k]);
      break;
    }
  }

  // 2. 会社名
  for (const line of lines) {
    if (line.field) continue;
    if (COMPANY_RE.test(line.text) || MUNICIPALITY_RE.test(line.text)) {
      set('company', line.text);
      line.field = 'company';
      break;
    }
  }

  // 3. 部署・役職
  for (const line of lines) {
    if (line.field) continue;
    const hasTitle = TITLE_RE.test(line.text);
    const hasDept = DEPT_RE.test(line.text);
    if (!hasTitle && !hasDept) continue;
    if (NAME_RE.test(line.text) && !hasTitle && line.text.replace(/\s/g, '').length <= 4 && !/(部|課|室|係|局)$/.test(line.text)) continue;
    const tokens = line.text.split(' ');
    const titleTokens = tokens.filter((t) => TITLE_RE.test(t) && !/(部|課|室|係|局|センター|グループ)$/.test(t.replace(TITLE_RE, '')) );
    const deptTokens = tokens.filter((t) => !titleTokens.includes(t));
    if (titleTokens.length) set('title', titleTokens.join(' '));
    if (deptTokens.length && hasDept) set('department', deptTokens.join(' '));
    line.field = hasDept ? 'department' : 'title';
  }

  // 4. ふりがな（かなだけの行）
  for (const line of lines) {
    if (line.field) continue;
    if (KANA_RE.test(line.text) && line.text.replace(/\s/g, '').length >= 3) {
      set('kana', line.text);
      line.field = 'kana';
      break;
    }
  }

  // 5. 氏名（漢字主体の短い行。姓名の間にスペースがあるものを優先）
  let best = null;
  for (const line of lines) {
    if (line.field) continue;
    if (!NAME_RE.test(line.text)) continue;
    if (/\d/.test(line.text)) continue;
    const len = line.text.replace(/\s/g, '').length;
    if (len < 2 || len > 8) continue;
    let score = 0;
    if (/\s/.test(line.text)) score += 2;
    if (/[㐀-鿿]/.test(line.text)) score += 1;
    if (len >= 3 && len <= 5) score += 1;
    if (!best || score > best.score) best = { line, score };
  }
  if (best) {
    set('name', best.line.text);
    best.line.field = 'name';
  }

  return { fields, lines };
}

/** 住所の文字列を 郵便番号 / 都道府県 / 市区町村 / それ以降 に分ける */
export function splitAddress(text) {
  let rest = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const out = { postalCode: '', prefecture: '', city: '', addressLine: '' };
  const postal = rest.match(/〒?\s?(\d{3})-?(\d{4})/);
  if (postal && rest.indexOf(postal[0]) <= 2) {
    out.postalCode = `${postal[1]}-${postal[2]}`;
    rest = rest.replace(postal[0], '').trim();
  }
  const pref = rest.match(PREF_RE);
  if (pref && rest.indexOf(pref[0]) <= 1) {
    out.prefecture = pref[0];
    rest = rest.slice(rest.indexOf(pref[0]) + pref[0].length).trim();
  }
  // 郡＋町村 → 政令市＋区 → 市区町村 の順に試す
  const city = rest.match(/^(\S+?郡\S+?[町村]|\S+?市\S+?区|\S+?[市区町村])/);
  if (city) {
    out.city = city[0];
    rest = rest.slice(city[0].length).trim();
  }
  out.addressLine = rest;
  return out;
}

/** 1 行から電話番号と種別（main / mobile / fax）を取り出す */
export function extractPhones(text) {
  const out = [];
  const s = String(text);
  PHONE_RE.lastIndex = 0;
  let m;
  while ((m = PHONE_RE.exec(s))) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) continue;
    const before = s.slice(0, m.index);
    const lastLabel = before.split(/\d/).pop();
    let kind = 'main';
    if (FAX_LABEL_RE.test(lastLabel)) kind = 'fax';
    else if (MOBILE_LABEL_RE.test(lastLabel) || /^(?:\+?81)?0?[789]0/.test(digits.replace(/^81/, '0'))) kind = 'mobile';
    out.push({ number: formatPhone(m[0]), kind });
  }
  return out;
}

function formatPhone(raw) {
  return raw.replace(/[()\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
