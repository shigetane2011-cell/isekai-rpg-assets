// 保存先の境界（Store）。画面とエンジンは Artifact の db を直接呼ばず、必ずここを通す。
// 将来サーバーへ移行するときは、同じ形の createServerStore() を足して差し替える。
//
// Store の形:
//   kind            'account' | 'device'   保存先の種類（画面の表示に使う）
//   identity        { id, source }         source: 'account'（claude.aiの識別子）| 'device'（端末で作った識別子）
//   characters.list()              → Promise<Character[]>
//   characters.watch(onChange, onState) → unsubscribe   onState({ loading, stale, error })
//   characters.save(character)     → Promise<Character>  id がなければ採番する
//   characters.remove(id)          → Promise<void>
//
// セッション用（後の段階で実装）:
//   sessions.create / watch / appendLog / acquireTurn / seal / reveal

const DEVICE_ID_KEY = 'isekai-trpg.device-id';
const DEVICE_LIBRARY_KEY = 'isekai-trpg.characters';

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function newId(prefix) {
  const rnd = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, '');
  return `${prefix}_${rnd.slice(0, 12)}`;
}

/** 端末ごとの識別子。claude.ai の識別子が得られない参加者（組織外の編集者など）向け。 */
export function deviceIdentity() {
  let id = safeGet(DEVICE_ID_KEY);
  if (!id) {
    id = newId('dev');
    safeSet(DEVICE_ID_KEY, id);
  }
  return { id, source: 'device' };
}

/** この端末のブラウザにだけ保存する Store。db が使えないときの代替。 */
export function createDeviceStore() {
  const listeners = new Set();
  const read = () => {
    try { return JSON.parse(safeGet(DEVICE_LIBRARY_KEY) ?? '{}'); } catch { return {}; }
  };
  const write = (lib) => {
    if (!safeSet(DEVICE_LIBRARY_KEY, JSON.stringify(lib))) {
      throw { code: 'storage_unavailable', message: 'この端末では保存できません（ブラウザの保存領域が使えません）' };
    }
    const list = Object.values(lib).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    for (const fn of listeners) fn(list);
  };
  const list = async () => Object.values(read()).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return {
    kind: 'device',
    identity: deviceIdentity(),
    characters: {
      list,
      watch(onChange, onState) {
        listeners.add(onChange);
        list().then((l) => { onChange(l); onState?.({ loading: false, stale: false, error: null }); });
        return () => listeners.delete(onChange);
      },
      async save(ch) {
        const lib = read();
        const saved = { ...ch, id: ch.id || newId('char'), updatedAt: new Date().toISOString() };
        lib[saved.id] = saved;
        write(lib);
        return saved;
      },
      async remove(id) {
        const lib = read();
        delete lib[id];
        write(lib);
      },
    },
  };
}

/**
 * Artifact の db に保存する Store。本人専用の data/users/<id>/ 以下に置くので、他の参加者からは読めない。
 * claude.ai の識別子がない閲覧者には null を返す（呼び出し側は createDeviceStore に切り替える）。
 */
export async function createArtifactStore() {
  const use = globalThis.claude?.use;
  if (typeof use !== 'function') return null;
  const [db, user] = await Promise.all([use('db'), use('user')]);
  if (!db || !user) return null;
  const id = await user.id();
  if (!id) return null;

  const col = db.doc(`data/users/${id}/library`).collection('characters');
  const toChar = (snap) => ({ ...snap.data(), id: snap.id });
  return {
    kind: 'account',
    identity: { id, source: 'account' },
    characters: {
      async list() {
        const snap = await col.orderBy('updatedAt', 'desc').get();
        return snap.docs.map(toChar);
      },
      watch(onChange, onState) {
        onState?.({ loading: true, stale: false, error: null });
        const timer = setTimeout(() => onState?.({ loading: false, stale: true, error: null }), 10000);
        const unsub = col.orderBy('updatedAt', 'desc').onSnapshot(
          (snap) => {
            if (!snap.metadata.fromCache) clearTimeout(timer);
            onChange(snap.docs.map(toChar));
            onState?.({ loading: false, stale: snap.metadata.fromCache, error: null });
          },
          (e) => { clearTimeout(timer); onState?.({ loading: false, stale: false, error: e }); },
        );
        return () => { clearTimeout(timer); unsub(); };
      },
      async save(ch) {
        const ref = ch.id ? col.doc(ch.id) : col.doc();
        const { id: _drop, ...body } = ch;
        const saved = { ...body, updatedAt: new Date().toISOString() };
        await ref.set(JSON.parse(JSON.stringify(saved)));
        return { ...saved, id: ref.id };
      },
      async remove(cid) {
        await col.doc(cid).delete();
      },
    },
  };
}

/** 使える中で最も良い Store を返す。 */
export async function createStore() {
  try {
    const s = await createArtifactStore();
    if (s) return s;
  } catch { /* 代替に切り替える */ }
  return createDeviceStore();
}
