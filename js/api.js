// GAS との通信。GAS の URL に "mock" を指定すると、端末内だけで動くお試しモードになる。
import { mockCall } from './mock-backend.js';

export class NetworkError extends Error {}
export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export async function callApi(gasUrl, action, payload = {}, token = '') {
  if (!gasUrl) throw new ApiError('no_url', '接続先が設定されていません');
  let data;
  if (gasUrl === 'mock') {
    data = await mockCall(action, { ...payload, token });
  } else {
    let res;
    try {
      // text/plain で送るとプリフライトが発生せず、GAS でもそのまま受け取れる
      res = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token, ...payload }),
        redirect: 'follow',
      });
    } catch (err) {
      throw new NetworkError('通信できませんでした');
    }
    if (!res.ok) throw new NetworkError(`通信エラー（${res.status}）`);
    try {
      data = await res.json();
    } catch (err) {
      throw new ApiError('bad_response', '接続先から想定外の応答が返りました。デプロイ設定を確認してください');
    }
  }
  if (!data || !data.ok) {
    const err = new ApiError(data?.error || 'unknown', data?.message);
    err.data = data;
    throw err;
  }
  return data;
}
