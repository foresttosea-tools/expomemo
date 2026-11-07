// 初期データ（ダミー）。お試しモードと、Seed.gs を使わずに setup() したときに使う。
// 単価・計算ルール・担当者名はすべて架空の値。本番の値は、リポジトリに置かない gas/Seed.gs（README 参照）で入れる。

// role：連動ルールのある品目の役割
//   parent / relay = 親機 / 中継機（面積から自動算出）
//   relaySolar = 中継機と同数のソーラー、connectSolar = GeoConnect と同数のソーラー
//   chat = GeoChat、connect = GeoConnect、router = GeoChat Router（GeoChat 5 台ごとに 1 台）、vital = GeoVital（機種選択）
// countSetup：初期設定費（台数 × 5,000 円）の対象か
// countInstall：設置工事・現地調査の台数に数えるか
export const DEFAULT_ITEMS = [
  { key: 'multi_parent', name: 'GeoBase Multi（親機）', group: '基地局', baseType: 'multi', role: 'parent', price: 1000000, cloudYearly: 100000, unit: '台', countSetup: true, countInstall: true, sort: 10 },
  { key: 'multi_relay', name: 'GeoBase Multi Repeater（中継機）', group: '基地局', baseType: 'multi', role: 'relay', price: 500000, cloudYearly: 50000, unit: '台', countSetup: true, countInstall: true, sort: 20 },
  { key: 'multi_solar', name: '分離型ソーラーバッテリー', group: '基地局', baseType: 'multi', role: 'relaySolar', price: 200000, cloudYearly: 0, unit: '台', countSetup: false, countInstall: false, sort: 30 },
  { key: 'std_parent', name: 'GeoBase（親機）', group: '基地局', baseType: 'std', role: 'parent', price: 800000, cloudYearly: 80000, unit: '台', countSetup: true, countInstall: true, sort: 40 },
  { key: 'std_relay', name: 'GeoBase Repeater（中継機）', group: '基地局', baseType: 'std', role: 'relay', price: 400000, cloudYearly: 40000, unit: '台', countSetup: true, countInstall: true, sort: 50 },
  { key: 'std_solar', name: '一体型ソーラーバッテリー', group: '基地局', baseType: 'std', role: 'relaySolar', price: 100000, cloudYearly: 0, unit: '台', countSetup: false, countInstall: false, sort: 60 },
  { key: 'geochat', name: 'GeoChat', group: '子機', baseType: '', role: 'chat', price: 50000, cloudYearly: 1000, unit: '台', countSetup: true, countInstall: false, sort: 110 },
  { key: 'geowana', name: 'GeoWana', group: '子機', baseType: '', role: '', price: 50000, cloudYearly: 1000, unit: '台', countSetup: true, countInstall: false, sort: 120 },
  { key: 'geoconnect', name: 'GeoConnect', group: '子機', baseType: '', role: 'connect', price: 200000, cloudYearly: 2000, unit: '台', countSetup: true, countInstall: true, sort: 130 },
  { key: 'connect_solar', name: 'ソーラーバッテリー（GeoConnect用）', group: '子機', baseType: '', role: 'connectSolar', price: 100000, cloudYearly: 0, unit: '台', countSetup: false, countInstall: false, sort: 140 },
  { key: 'geocam', name: 'GeoCam', group: '子機', baseType: '', role: '', price: 200000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 150 },
  { key: 'geochat_router', name: 'GeoChat Router', group: 'オプション', baseType: '', role: 'router', price: 50000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 210 },
  { key: 'geovital_ms200', name: 'GeoVital（MULiSiTEN MS200）', group: 'オプション', baseType: '', role: 'vital', price: 30000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 220 },
  { key: 'geovital_verity', name: 'GeoVital（Verity Sense）', group: 'オプション', baseType: '', role: 'vital', price: 10000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 230 },
  { key: 'geoflash', name: 'GeoFlash', group: 'オプション', baseType: '', role: '', price: 100000, cloudYearly: 0, unit: '台', countSetup: false, countInstall: false, sort: 240 },
  { key: 'sensor_rain', name: '雨量計', group: 'センサー', baseType: '', role: '', price: 100000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 310 },
  { key: 'sensor_water', name: '水位計', group: 'センサー', baseType: '', role: '', price: 100000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 320 },
  { key: 'sensor_temp', name: '温度・湿度センサー', group: 'センサー', baseType: '', role: '', price: 100000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 330 },
  { key: 'sensor_contact', name: '接点入力', group: 'センサー', baseType: '', role: '', price: 100000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 340 },
  { key: 'sensor_other', name: 'その他センサー', group: 'センサー', baseType: '', role: '', price: 100000, cloudYearly: 0, unit: '台', countSetup: true, countInstall: false, sort: 350 },
];

export const DEFAULT_STAFF = ['担当者A', '担当者B', '担当者C', '担当者D'];

// 社内メモの選択肢（FORESTRISE2026 来場者受付・商談記録フォームより）
// 「その他」を選ぶと自由入力欄が出る
export const DEFAULT_OPTIONS = {
  industry: [
    '国・都道府県・市区町村などの行政機関',
    '森林組合・林業事業体（その他木材関連含む）',
    '建設・土木・測量・コンサルティング',
    '大学・研究機関',
    '防災・インフラ関連',
    '通信・IoT・センサー関連',
    'ドローン・衛星・測量関連',
    'エネルギー・電源・バッテリー関連',
    '農業・水産・地域産業関連',
    '商社・販売代理店',
    'その他',
  ],
  division: [
    '林業・森林整備',
    '農林水産',
    '防災・危機管理',
    '地域振興・地方創生',
    'DX・ICT・情報システム',
    'インフラ・施設管理',
    '総務・経営企画',
    '新規事業・研究開発',
    '安全衛生・労務管理',
    'その他',
  ],
  usage: [
    '林業作業者・現場作業員の安全見守り',
    '林業現場の位置情報・作業状況把握',
    '獣害対策',
    '森林・林道・作業道の監視',
    '気象・雨量・温湿度の観測',
    '河川・ため池・水位の監視',
    '積雪・雪崩・融雪の監視',
    '山間部・僻地の通信確保',
    '災害時の安否確認・情報共有',
    '地域インフラ・エネルギー設備の見守り',
    '登山・川下りなどアウトドア利用者の見守り',
    'スマート林業・森林DX',
    'その他',
  ],
  product: ['GeoChat', 'GeoWana', 'GeoConnect', 'GeoWeather', 'GeoVital', 'GeoFlash', 'GeoCam', '衛星通信', 'ハイクカム', 'センサー・IoT監視システム', 'その他'],
  material: ['会社案内', 'GeoChatパンフレット', '会社紹介スライド', 'GeoVitalチラシ', '農林中金カタログ抜粋資料', '日吉町森林組合様 わかばプロジェクト資料', '渡していない'],
  status: [
    '具体的な用途があり導入を前向きに検討',
    '情報収集・将来の検討',
    '協業・販売代理店を検討',
    '関心はあるが現時点では導入予定なし',
    '挨拶・既存顧客対応',
    '関心なし',
  ],
  priority: [
    '最優先：導入・協業の可能性が高く、早期フォローが必要',
    '優先：関心・課題が明確で、継続フォローが必要',
    '通常：情報提供・将来に向けたフォロー',
    'フォロー対象外：導入意欲・関連性が薄い',
  ],
  subsidy: [
    '【総務省】地域DX推進パッケージ',
    '【内閣府】新しい地方経済・生活環境創生交付金（旧デジタル田園都市国家構想交付金）',
    '【農水省】農山漁村振興交付金',
    '【林野庁】林業労働安全確保対策事業',
    '【農林中金】林業労働安全性向上対策事業',
    '森林環境譲与税',
    '県・市町村の自主財源',
    '補助金・財源は未定',
    'その他',
  ],
  timing: ['1年以内', '1～3年以内', '時期未定', '導入予定なし'],
  nextAction: ['資料・見積書を送付', 'オンラインまたは訪問で商談', 'デモ・製品説明', 'テスト導入・実証実験の相談', '補助金・導入事例の情報提供', '販売代理店・協業の相談', '特になし'],
  staff: DEFAULT_STAFF,
};

export const DEFAULT_SETTINGS = {
  eventName: '',
  eventStart: '',
  eventEnd: '',
  companyName: '株式会社フォレストシー',
  sessionTimeoutMin: 120,
};
