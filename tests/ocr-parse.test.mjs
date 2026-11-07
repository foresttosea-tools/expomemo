import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCardText, extractPhones, splitAddress } from '../js/ocr-parse.js';

test('一般的な横書き名刺', () => {
  const text = [
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
  ].join('\n');
  const { fields } = parseCardText(text);
  assert.equal(fields.company, '株式会社サンプル電機');
  assert.equal(fields.department, '営業本部 第一営業部');
  assert.equal(fields.title, '部長');
  assert.equal(fields.name, '山田 太郎');
  assert.equal(fields.kana, 'やまだ たろう');
  assert.equal(fields.postalCode, '100-0001');
  assert.equal(fields.prefecture, '東京都');
  assert.equal(fields.city, '千代田区');
  assert.equal(fields.addressLine, '千代田1-1-1 サンプルビル5F');
  assert.equal(fields.phone1, '03-1234-5678');
  assert.equal(fields.phone2, '090-1111-2222', 'ラベルは付けず番号だけ');
  assert.equal(fields.email, 't.yamada@sample.co.jp');
});

test('自治体の名刺（全角数字・全角記号）', () => {
  const text = [
    '山梨県北杜市',
    '産業観光部 農政課',
    '主査',
    '鈴木　花子',
    '〒４０８－０１８８　山梨県北杜市須玉町大豆生田９６１－１',
    '電話　０５５１－４２－１１１１',
    'hanako-suzuki@city.hokuto.lg.jp',
  ].join('\n');
  const { fields } = parseCardText(text);
  assert.equal(fields.company, '山梨県北杜市');
  assert.equal(fields.department, '産業観光部 農政課');
  assert.equal(fields.title, '主査');
  assert.equal(fields.name, '鈴木 花子');
  assert.equal(fields.postalCode, '408-0188');
  assert.equal(fields.prefecture, '山梨県');
  assert.equal(fields.city, '北杜市');
  assert.equal(fields.addressLine, '須玉町大豆生田961-1');
  assert.equal(fields.phone1, '0551-42-1111');
  assert.equal(fields.phone2, undefined);
});

test('住所の分割', () => {
  assert.deepEqual(splitAddress('〒231-0017 神奈川県横浜市中区港町1-1'), { postalCode: '231-0017', prefecture: '神奈川県', city: '横浜市中区', addressLine: '港町1-1' });
  assert.deepEqual(splitAddress('北海道虻田郡ニセコ町字富士見47'), { postalCode: '', prefecture: '北海道', city: '虻田郡ニセコ町', addressLine: '字富士見47' });
  assert.deepEqual(splitAddress('長野県市川市1-2'), { postalCode: '', prefecture: '長野県', city: '市川市', addressLine: '1-2' });
});

test('電話番号は 3 つ目以降と FAX を入れない', () => {
  const { fields } = parseCardText('TEL 03-1111-2222 FAX 03-1111-2223\n携帯 090-1111-2222\n直通 03-9999-8888');
  assert.equal(fields.phone1, '03-1111-2222');
  assert.equal(fields.phone2, '090-1111-2222');
});

test('メールの @ の前後に OCR がスペースを入れても拾える', () => {
  const { fields } = parseCardText('info @ example.com');
  assert.equal(fields.email, 'info@example.com');
});

test('FAX 番号の判定', () => {
  assert.deepEqual(extractPhones('FAX 03-1234-5679'), [{ number: '03-1234-5679', kind: 'fax' }]);
  assert.deepEqual(extractPhones('T 03-1234-5678 F 03-1234-5679').map((p) => p.kind), ['main', 'fax']);
});

test('判定できない行は未割り当てで残す', () => {
  const { lines } = parseCardText('株式会社テスト\nGEO-WAVE で山をつなぐ\n田中 一郎');
  assert.equal(lines.find((l) => l.text.startsWith('GEO-WAVE')).field, null);
});
