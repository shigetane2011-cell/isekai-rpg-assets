/* 決定論の検証。index.html からエンジン部だけを抜き出して実行する。
   使い方: node tools/verify.mjs                                            */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const S = '/* ==ENGINE START== */', T = '/* ==ENGINE END== */';
const i = html.indexOf(S), j = html.indexOf(T);
if (i < 0 || j < 0) { console.error('エンジン区間が見つかりません'); process.exit(1); }
const src = html.slice(i + S.length, j);

let pass = 0, fail = 0;
const ok  = (c, m) => { c ? (pass++, console.log('  \x1b[32m✓\x1b[0m ' + m))
                          : (fail++, console.log('  \x1b[31m✗\x1b[0m ' + m)); };
const head = m => console.log('\n\x1b[1m' + m + '\x1b[0m');

/* --- 1. 非決定的APIの混入検査 ------------------------------------------- */
head('1. 非決定的APIが混入していないか');
// コメントと文字列リテラルを除いた「実際に動くコード」だけを見る
const code = html
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
for (const bad of ['Math.random', 'Date.now', 'new Date(', 'performance.now', 'crypto.getRandomValues']) {
  ok(!code.includes(bad), `${bad} を使用していない`);
}

/* --- エンジン読み込み ---------------------------------------------------- */
await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
const E = globalThis.ENGINE;

/* テスト自身も決定論的に動かすための PRNG */
const trnd = E.mulberry32(0xC0FFEE);
const pick = arr => arr[Math.floor(trnd() * arr.length)];

function autoPlay(seed, rnd) {
  let st = E.createState(seed);
  const actions = [];
  while (!st.finished) {
    const m = E.meetingList(st);
    const slots = m.intro ? [...m.normal, m.intro] : m.normal;
    const charId = slots[Math.floor(rnd() * slots.length)];
    const c = E.CHAR_BY_ID.get(charId);
    const ownF = c.factions[Math.floor(rnd() * c.factions.length)];
    const stance = rnd() < 0.6 ? 'support' : 'convert';
    const others = [0, 1, 2, 3, 4].filter(f => f !== ownF);
    const argueF = stance === 'support' ? ownF : others[Math.floor(rnd() * others.length)];
    const opts = E.cardOptions(st, charId, argueF);
    const cards = opts.map((o, k) => rnd() < 0.55 ? c.correct[k] : o[Math.floor(rnd() * 4)].motive);
    const a = { charId, stance, ownF, argueF, cards };
    actions.push(a);
    st = E.resolve(st, a).next;
  }
  return { st, actions };
}

/* --- 2. 完全リプレイ性 --------------------------------------------------- */
head('2. 同じ seed + 同じ選択列 → 常に同じ盤面');
let replayOk = true, endingSeen = new Map();
for (let s = 1; s <= 300; s++) {
  const { st, actions } = autoPlay(s, E.mulberry32(s * 7919));
  const again = E.replay(s, actions).state;
  if (E.hashState(st) !== E.hashState(again)) { replayOk = false; console.log('    seed', s, '不一致'); break; }
  const third = E.replay(s, actions).state;
  if (E.hashState(st) !== E.hashState(third)) { replayOk = false; break; }
  const e = E.evaluateEnding(st);
  endingSeen.set(e.t, (endingSeen.get(e.t) || 0) + 1);
}
ok(replayOk, '300 seed × 3回実行で state hash が完全一致');

/* --- 3. セーブコードの往復 ----------------------------------------------- */
head('3. 保存コードの往復');
let saveOk = true;
for (let s = 1; s <= 60; s++) {
  const { st } = autoPlay(s, E.mulberry32(s * 31337));
  const dec = E.decodeSave(E.encodeSave(st));
  if (E.hashState(E.replay(dec.seed, dec.actions).state) !== E.hashState(st)) { saveOk = false; break; }
}
ok(saveOk, '60局を encode → decode → replay して一致');

/* --- 4. ルール不変条件 --------------------------------------------------- */
head('4. ルールの不変条件');
let inv = { range: true, dup: true, rank: true, intro: true, turns: true, correct: true, len: true };
for (let s = 1; s <= 200; s++) {
  let st = E.createState(s);
  const rnd = E.mulberry32(s * 104729);
  let n = 0;
  while (!st.finished) {
    n++;
    const era = E.eraOf(st), m = E.meetingList(st);
    if (new Set(m.normal).size !== 3) inv.dup = false;
    for (const id of m.normal) {
      if (E.rankOfId(id) > era) inv.rank = false;                    // 通常枠はランク補正で必ず解禁済み
      if (st.contacts.includes(id) || st.banned.includes(id)) inv.dup = false;
    }
    if (st.contacts.length === 0 && m.intro !== null) inv.intro = false;   // 人脈が空なら紹介枠なし
    if (m.intro !== null && m.normal.includes(m.intro)) inv.dup = false;

    const slots = m.intro ? [...m.normal, m.intro] : m.normal;
    const charId = slots[Math.floor(rnd() * slots.length)];
    const c = E.CHAR_BY_ID.get(charId);
    const ownF = c.factions[Math.floor(rnd() * c.factions.length)];
    const stance = rnd() < 0.5 ? 'support' : 'convert';
    const others = [0, 1, 2, 3, 4].filter(f => f !== ownF);
    const argueF = stance === 'support' ? ownF : others[Math.floor(rnd() * others.length)];
    const opts = E.cardOptions(st, charId, argueF);
    for (let k = 0; k < 3; k++) {                                    // 正解は必ず1枚だけ含まれる
      const hit = opts[k].filter(o => o.motive === c.correct[k]).length;
      if (hit !== 1 || new Set(opts[k].map(o => o.motive)).size !== 4) inv.correct = false;
    }
    const cards = opts.map(o => o[Math.floor(rnd() * 4)].motive);
    const r = E.resolve(st, { charId, stance, ownF, argueF, cards });
    if (r.report.len <= 0) inv.len = false;
    st = r.next;
    if (st.currents.some(v => v < 0 || v > E.CAP)) inv.range = false;
    if (n > E.MAX_TURN) inv.turns = false;
  }
}
ok(inv.range,   '時勢値が常に 0〜40 の範囲に収まる');
ok(inv.dup,     '面会リストに重複・既獲得・決裂済みが出ない');
ok(inv.rank,    '通常枠に未解禁ランクが出ない（強制変換が効いている）');
ok(inv.intro,   '人脈が空のとき紹介枠は必ず出ない');
ok(inv.turns,   'ゲームは必ず10ターン以内に終わる');
ok(inv.correct, '各カテゴリの提示4枚に正解がちょうど1枚含まれる');
ok(inv.len,     '論証文の文字数が必ず正の値になる');

/* --- 5. 判定表の一致 ----------------------------------------------------- */
head('5. 判定表どおりの増減になっているか');
function probe(seed, charId, stance, argueF, score) {
  const st = E.createState(seed);
  const c = E.CHAR_BY_ID.get(charId);
  const cards = c.correct.slice();
  const wrong = k => [0,1,2,3,4,5].find(m => m !== c.correct[k]);
  for (let k = score; k < 3; k++) cards[k] = wrong(k);
  return E.resolve(st, { charId, stance, ownF: c.factions[0], argueF, cards }).report;
}
ok(probe(1, 1, 'support', 0, 3).gain === 4, '初級・大成功 → +4');
ok(probe(1, 1, 'support', 0, 2).gain === 2, '初級・成功 → +2');
ok(probe(1, 1, 'support', 0, 1).gain === 0, '初級・失敗 → 変動なし');
ok(probe(1, 1, 'support', 0, 0).gain === 0 && probe(1, 1, 'support', 0, 0).bannedNow, '初級・決裂 → 出現停止');
const pre = probe(1, 100, 'support', 1, 3);
ok(pre.premature && pre.gain === 4, '初級期に伝説級 → 時期尚早でボーナス無効（+4のまま）');
const cv3 = atEra(8, 1, 3, 'convert', 4), cv2 = atEra(8, 1, 2, 'convert', 4);
ok(cv3.delta[4] === 4 && cv3.delta[0] === -2, '転向・大成功 → 主張属性+4 / 相手属性-2');
ok(cv2.delta[4] === 2 && cv2.delta[0] === -1, '転向・成功 → 主張属性+2 / 相手属性-1');
const floorTest = E.resolve(Object.assign(E.createState(1), { currents: [0,0,0,0,0] }),
  { charId: 1, stance: 'convert', ownF: 0, argueF: 4, cards: E.CHAR_BY_ID.get(1).correct });
ok(floorTest.next.currents[0] === 0, '相手属性が0のとき転向で減らしてもマイナスにならない');

/* ランク補正は時代が追いついている場合のみ */
function atEra(total, charId, score, stance = 'support', argueF = null) {
  const st = E.createState(1);
  st.currents = [total, 0, 0, 0, 0];
  const c = E.CHAR_BY_ID.get(charId);
  const cards = c.correct.slice();
  for (let k = score; k < 3; k++) cards[k] = [0,1,2,3,4,5].find(m => m !== c.correct[k]);
  return E.resolve(st, { charId, stance, ownF: c.factions[0], argueF: argueF ?? c.factions[0], cards }).report;
}
ok(atEra(12, 47, 3).gain === 5, '中級期に中級級・大成功 → +5（+1補正）');
ok(atEra(12, 47, 2).gain === 3, '中級期に中級級・成功 → +3（+1補正）');
ok(atEra(26, 83, 3).gain === 6, '上級期に上級級・大成功 → +6（+2補正）');
ok(atEra(26, 83, 1).penalty === 1, '上級期に上級級・失敗 → 時勢-1');
ok(atEra(40, 99, 3).gain === 8, '伝説期に伝説級・大成功 → +8（2倍）');
ok(atEra(40, 99, 1).penalty === 3, '伝説期に伝説級・失敗 → 時勢-3');
ok(atEra(12, 99, 1).penalty === 0, '時期尚早なら失敗ペナルティも無効');

/* --- 6. エンディング分岐 ------------------------------------------------- */
head('6. エンディング分岐');
const mk = cur => E.evaluateEnding({ currents: cur });
ok(mk([30,0,0,0,0]).t === '王政の千年王国', '公武30 → 王政の千年王国');
ok(mk([0,0,31,0,0]).t === '徳川の再臨', '佐幕31 → 徳川の再臨');
ok(mk([0,0,0,33,0]).t === '諸侯の連邦', '雄藩33 → 諸侯の連邦');
ok(mk([0,35,0,0,0]).t === '東洋の貿易都市', '開国35 → 東洋の貿易都市');
ok(mk([0,0,0,0,30]).t === '修羅の国', '抗戦30 → 修羅の国');
ok(mk([20,0,15,0,0]).t === '立憲君主幕府', '公武20+佐幕15 → 立憲君主幕府');
ok(mk([0,18,0,14,0]).t === '明治維新（史実改）', '開国18+雄藩14 → 明治維新（史実改）');
ok(mk([0,16,0,0,16]).t === '武装共和国', '開国16+抗戦16 → 武装共和国');
ok(mk([16,0,0,0,15]).t === '野合の衆', '公武16+抗戦15 → 野合の衆');
ok(mk([9,8,5,4,3]).t === '歴史の藻屑', '合計は多いが上位2つが30未満 → 歴史の藻屑');
ok(mk([31,0,32,0,0]).t === '徳川の再臨', '複数が30超 → 最大値の単独覇権が優先');

/* --- 7. データ整合性 ----------------------------------------------------- */
head('7. データ整合性');
ok(E.CHARACTERS.length === 100, '登場人物がちょうど100名');
ok(new Set(E.CHARACTERS.map(c => c.id)).size === 100, 'IDに重複がない');
ok(E.CHARACTERS.every(c => c.id >= 1 && c.id <= 100), 'IDが1〜100に収まる');
ok(E.CHARACTERS.every(c => c.correct.every(v => v >= 0 && v <= 5)), '正解の動機型が0〜5に収まる');
ok(E.CHARACTERS.every(c => c.factions.every(f => f >= 0 && f <= 4)), '勢力が0〜4に収まる');
ok(E.CHARACTERS.every(c => c.name && c.nick && c.desc), '全員に名・二つ名・情勢描写がある');
ok(E.CARDS.length === 5 && E.CARDS.every(f => f.length === 3 && f.every(cat => cat.length === 6)),
   'カードプールが 5勢力 × 3カテゴリ × 6型 = 90枚');
ok(new Set(E.CARDS.flat(2)).size === 90, 'カード本文に重複がない');
ok(Object.keys(E.TIES).every(k => (E.TIES[k] || []).every(v => E.CHAR_BY_ID.has(+v) && +v !== +k)),
   '史実の結びつきが実在IDを指し、自己参照がない');

/* --- 8. 熟練プレイでの到達可能性 ------------------------------------------ */
head('8. 全エンディングに到達できるか（正解を引き当て続ける熟練プレイ）');
/* 目標勢力へ寄せ続ける戦略。相手が既に目標勢力なら支持、違えば転向させる。 */
function strategist(seed, targets) {
  let st = E.createState(seed), t = 0;
  while (!st.finished) {
    const m = E.meetingList(st);
    const slots = m.intro ? [...m.normal, m.intro] : m.normal;
    const target = targets[t++ % targets.length];
    /* 目標勢力の人物がいればその人を優先（支持のほうが相手を削らない） */
    let charId = slots.find(id => E.CHAR_BY_ID.get(id).factions.includes(target)) ?? slots[0];
    const c = E.CHAR_BY_ID.get(charId);
    const isTarget = c.factions.includes(target);
    const ownF = isTarget ? target : c.factions[0];
    const stance = isTarget ? 'support' : 'convert';
    st = E.resolve(st, { charId, stance, ownF, argueF: target, cards: c.correct.slice() }).next;
  }
  return st;
}
const reached = new Map();
for (let seed = 1; seed <= 40; seed++) {
  for (const targets of [[0],[1],[2],[3],[4],[0,2],[1,3],[1,4],[0,4],[2,3],[0,1,2,3,4]]) {
    const e = E.evaluateEnding(strategist(seed, targets));
    if (!reached.has(e.t)) reached.set(e.t, `seed ${seed} / 目標 ${targets.map(f => E.FACTIONS[f].name).join('+')}`);
  }
}
const allEndings = [...Object.values(E.ENDINGS.solo), ...Object.values(E.ENDINGS.combo), E.ENDINGS.chaos];
for (const e of allEndings) ok(reached.has(e.t), `『${e.t}』に到達できる${reached.has(e.t) ? `（${reached.get(e.t)}）` : ''}`);

head('9. 無作為プレイ300局の到達分布（下手に打つと何も成せないことの確認）');
for (const [k, v] of [...endingSeen].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)} 局  ${k}`);

console.log(`\n\x1b[1m結果: ${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
