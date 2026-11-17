// AI呼び出しの境界（Gm）。画面とエンジンは sample を直接呼ばず、必ずここを通す。
// 今は閲覧者の claude.ai アカウントで動く sample を使う。
// 将来サーバーへ移行するときは、同じ形の createServerGm()（サーバー側でAPIを呼ぶ）を足して差し替える。
//
// Gm の形:
//   available         boolean
//   json(prompt, { tier, fresh, signal, onText }) → Promise<any>     失敗時は GmError を投げる
//   text(prompt, { tier, fresh, signal, onText }) → Promise<string>
//
// GmError: { code, message, permanent }  permanent=true なら、この画面ではAI機能を隠す。

const PERMANENT = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed']);

const MESSAGES = {
  not_granted: 'このページでのClaudeの利用が許可されていません。',
  sampling_disabled: 'このアカウントではClaudeを呼び出せません。',
  rate_limited: '呼び出しが多すぎるか、利用上限に達しました。しばらく待ってからもう一度試してください。',
  session_expired: 'claude.ai にもう一度サインインしてください。',
  refused: 'この内容には回答できませんでした。設定の書き方を変えて試してください。',
  invalid_json: '回答を読み取れませんでした。もう一度試してください。',
  empty_completion: '回答が空でした。設定を短くして試してください。',
  prompt_too_large: '送る内容が長すぎます。',
  upstream_error: '通信に失敗しました。もう一度試してください。',
  cancelled: '中止しました。',
};

function toGmError(e) {
  const code = typeof e?.code === 'string' ? e.code : 'upstream_error';
  return { code, message: MESSAGES[code] ?? MESSAGES.upstream_error, permanent: PERMANENT.has(code), partial: e?.text };
}

const unavailable = {
  available: false,
  async json() { throw { code: 'unavailable', message: 'このページではAIを呼び出せません（claude.ai の外で開いています）。', permanent: true }; },
  async text() { throw { code: 'unavailable', message: 'このページではAIを呼び出せません（claude.ai の外で開いています）。', permanent: true }; },
};

export async function createArtifactGm() {
  const use = globalThis.claude?.use;
  if (typeof use !== 'function') return unavailable;
  const sample = await use('sample');
  if (!sample) return unavailable;

  const opts = ({ tier = 'default', fresh = false, signal, onText } = {}) => {
    const o = { modelTier: tier };
    if (fresh) o.cache = false;
    if (signal) o.signal = signal;
    if (onText) o.onText = onText;
    return o;
  };
  return {
    available: true,
    async json(prompt, o) {
      try { return await sample.json(prompt, opts(o)); } catch (e) { throw toGmError(e); }
    },
    async text(prompt, o) {
      try { return (await sample(prompt, opts(o))).text; } catch (e) { throw toGmError(e); }
    },
  };
}

export async function createGm() {
  try { return await createArtifactGm(); } catch { return unavailable; }
}
