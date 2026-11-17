// 判定エンジン：ダイス、3d6下方判定、対抗判定、反応判定。
// ブラウザ・Node 両対応の純粋なES module。乱数源 rng は差し替え可能（PVPの共同乱数用）。

/** [0,1) を返す関数。既定は Math.random。 */
export const defaultRng = Math.random;

/**
 * 32bit 整数の配列（共同乱数の種）から決定的な乱数源を作る。
 * PVPでは双方が提出した salt を連結したハッシュを種にし、どちらも出目を操作できないようにする。
 */
export function seededRng(seedWords) {
  let a = 0x9e3779b9;
  for (const w of seedWords) a = Math.imul(a ^ (w >>> 0), 0x85ebca6b) >>> 0;
  return function mulberry32() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rollDie(sides, rng = defaultRng) {
  return 1 + Math.floor(rng() * sides);
}

/** "2d6+1" "1d3" "1d6-2" を {count, sides, mod} に。 */
export function parseDice(expr) {
  const m = /^\s*(\d+)d(\d+)\s*([+-]\s*\d+)?\s*$/.exec(String(expr));
  if (!m) throw new Error(`ダイス式が不正です: ${expr}`);
  return { count: +m[1], sides: +m[2], mod: m[3] ? +m[3].replace(/\s/g, '') : 0 };
}

export function rollDice(expr, rng = defaultRng) {
  const { count, sides, mod } = parseDice(expr);
  const rolls = Array.from({ length: count }, () => rollDie(sides, rng));
  return { expr, rolls, mod, total: rolls.reduce((s, r) => s + r, 0) + mod };
}

const DEFAULT_CHECK = {
  autoSuccess: [3, 4],
  autoFailure: [17, 18],
  criticalSuccessMargin: 10,
  criticalFailureMargin: -10,
  criticalFailure17MaxEffective: 15,
};

/** 出目と実効値から判定結果を決める（乱数を使わない部分）。 */
export function resolveCheck(total, effective, rules = DEFAULT_CHECK) {
  const margin = effective - total;
  let success;
  if (rules.autoSuccess.includes(total)) success = true;
  else if (rules.autoFailure.includes(total)) success = false;
  else success = total <= effective;

  let critical = null;
  if (success && (rules.autoSuccess.includes(total) || margin >= rules.criticalSuccessMargin)) {
    critical = 'success';
  } else if (!success) {
    if (total === 18 || (total === 17 && effective <= rules.criticalFailure17MaxEffective) ||
        margin <= rules.criticalFailureMargin) {
      critical = 'failure';
    }
  }
  return { total, effective, margin, success, critical };
}

/** 3d6 下方判定。effective = 技能値 + 全修正。 */
export function check(effective, rules = DEFAULT_CHECK, rng = defaultRng) {
  const dice = [rollDie(6, rng), rollDie(6, rng), rollDie(6, rng)];
  const total = dice[0] + dice[1] + dice[2];
  return { dice, ...resolveCheck(total, effective, rules) };
}

/**
 * 対抗判定。a が仕掛けた側、b が受ける側。
 * 片方だけ成功→その側。両方成功→成功度が大きい側。同値・両方失敗→受ける側（現状維持）。
 */
export function contest(effA, effB, rules = DEFAULT_CHECK, rng = defaultRng) {
  const a = check(effA, rules, rng);
  const b = check(effB, rules, rng);
  let winner;
  if (a.success && !b.success) winner = 'a';
  else if (!a.success && b.success) winner = 'b';
  else if (a.success && b.success) winner = a.margin > b.margin ? 'a' : 'b';
  else winner = 'none';
  return { a, b, winner };
}

/** 反応判定（上方）：3d6 + 修正を表に当てる。 */
export function reaction(modifier, table, rng = defaultRng) {
  const dice = [rollDie(6, rng), rollDie(6, rng), rollDie(6, rng)];
  const total = dice[0] + dice[1] + dice[2] + modifier;
  const row = table.find((r) => total <= r.max) ?? table[table.length - 1];
  return { dice, modifier, total, result: row.result, label: row.label };
}

/** 実効値ごとの成功確率（自動成功・自動失敗込み）を厳密に数える。 */
export function successProbability(effective, rules = DEFAULT_CHECK) {
  let ok = 0;
  for (let i = 1; i <= 6; i++) for (let j = 1; j <= 6; j++) for (let k = 1; k <= 6; k++) {
    if (resolveCheck(i + j + k, effective, rules).success) ok++;
  }
  return ok / 216;
}
