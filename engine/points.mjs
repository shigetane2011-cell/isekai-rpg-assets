// ポイント計算とキャラクター検証。ルールデータ（data/rules/*.json）を受け取り、
// コストと技能値を計算する。AIはここで決まった数値を変えられない。

const TIERS = ['easy', 'average', 'hard'];

/**
 * ルールデータを索引化する。scenarioExt はシナリオが追加する技能・特徴など（任意）。
 * @param {{core, skills, traits, reincarnation, equipment}} data 各JSONの中身
 */
export function buildRules(data, scenarioExt = {}) {
  const skills = [...data.skills.skills, ...(scenarioExt.skills ?? [])];
  const traits = [...data.traits.traits, ...(scenarioExt.traits ?? [])];
  const reinc = [...data.reincarnation.reincarnation, ...(scenarioExt.reincarnation ?? [])];
  const equipment = [...data.equipment.equipment, ...(scenarioExt.equipment ?? [])];
  return {
    core: data.core,
    skills: new Map(skills.map((s) => [s.id, s])),
    traits: new Map(traits.map((t) => [t.id, t])),
    reincarnation: new Map(reinc.map((t) => [t.id, t])),
    equipment: new Map(equipment.map((e) => [e.id, e])),
  };
}

/** 特徴1つのコスト。options / cost + costPerLevel * level のどちらか。 */
export function traitCost(def, entry) {
  if (def.options) {
    const opt = def.options.find((o) => o.id === entry.option);
    if (!opt) throw new Error(`${def.name}: 選択肢 "${entry.option}" がありません`);
    return opt.cost;
  }
  const level = entry.level ?? (def.costPerLevel ? def.minLevel ?? 1 : 0);
  return (def.cost ?? 0) + (def.costPerLevel ?? 0) * level;
}

/** 技能に使えるポイント値か（1, 2, 4, 8, 12, ...）。 */
export function isValidSkillPoints(p) {
  return p === 1 || p === 2 || (p >= 4 && p % 4 === 0);
}

/** ポイントと難度から、基準能力値への修正を出す。 */
export function skillOffset(points, difficulty, core) {
  const o = core.skillCost.offsetAtOnePoint[difficulty];
  if (points === 1) return o;
  if (points === 2) return o + 1;
  return o + 2 + (points - 4) / 4;
}

function levelOf(def, entry) {
  return entry.level ?? (def.costPerLevel ? def.minLevel ?? 1 : 0);
}

/** キャラクターが持つ特徴・転生技能を {def, entry, level} の列にする。 */
function ownedEffects(rules, ch) {
  const out = [];
  for (const e of ch.traits ?? []) {
    const def = rules.traits.get(e.id);
    if (def) out.push({ def, entry: e, level: levelOf(def, e) });
  }
  for (const e of ch.reincarnation ?? []) {
    const def = rules.reincarnation.get(e.id);
    if (def) out.push({ def, entry: e, level: levelOf(def, e) });
  }
  return out;
}

function effectValue(eff, level, entry) {
  if (eff.valueByOption) return eff.valueByOption[entry.option] ?? 0;
  const v = eff.value ?? 0;
  return eff.perLevel ? v * Math.max(level, 0) : v;
}

/** 技能定義（シナリオ固有・前世の知識による独自技能を含む）を引く。 */
export function skillDef(rules, ch, id) {
  return rules.skills.get(id) ?? (ch.customSkills ?? []).find((s) => s.id === id);
}

/** 天賦の才などで難度を軽くした結果。 */
export function effectiveDifficulty(rules, ch, def) {
  let idx = TIERS.indexOf(def.difficulty);
  for (const { def: t, entry } of ownedEffects(rules, ch)) {
    for (const eff of t.effects ?? []) {
      if (eff.type === 'skillCostTier' && (def.tags ?? []).includes(entry.detail)) {
        idx = Math.max(0, idx + eff.shift);
      }
    }
  }
  return TIERS[idx];
}

/** 能力値・派生値の現在値。 */
export function derivedValues(rules, ch) {
  const a = ch.attributes;
  const b = ch.derivedBought ?? {};
  const v = {
    st: a.st, dx: a.dx, iq: a.iq, ht: a.ht,
    hp: Math.ceil((a.st + a.ht) / 2) + (b.hp ?? 0),
    mp: a.iq + (b.mp ?? 0),
    will: a.iq + (b.will ?? 0),
    per: a.iq + (b.per ?? 0),
    speed: (a.dx + a.ht) / 4,
    dodge: Math.floor(a.dx / 2) + 3,
    str_bonus: Math.floor((a.st - 10) / 2),
    parry: 0, block: 0, reaction: 0,
  };
  for (const { def, entry, level } of ownedEffects(rules, ch)) {
    for (const eff of def.effects ?? []) {
      if (eff.type === 'derived') v[eff.target] += effectValue(eff, level, entry);
      if (eff.type === 'derivedMultiplier') v[eff.target] *= eff.value;
    }
  }
  return v;
}

/** 技能値（常時有効な特徴の修正込み）。未修得なら既定値、使えなければ null。 */
export function skillValue(rules, ch, id, derived = derivedValues(rules, ch)) {
  const def = skillDef(rules, ch, id);
  if (!def) return null;
  const owned = ownedEffects(rules, ch);
  if (def.requires && !owned.some((o) => o.def.id === def.requires)) return null;
  const points = (ch.skills ?? {})[id] ?? 0;
  const base = derived[def.attr];
  let value;
  if (points > 0) value = base + skillOffset(points, effectiveDifficulty(rules, ch, def), rules.core);
  else if (def.default) value = base + rules.core.skillCost.untrainedPenalty;
  else return null;

  for (const { def: t, entry, level } of owned) {
    for (const eff of t.effects ?? []) {
      if (eff.type === 'skill' && eff.target === id) value += effectValue(eff, level, entry);
      if (eff.type === 'tag' && (def.tags ?? []).includes(eff.target)) value += effectValue(eff, level, entry);
      if (eff.type === 'chosenSkill' && entry.detail === id) value += effectValue(eff, level, entry);
    }
  }
  return value;
}

/** ポイント内訳。前世の知識の無償ポイントは技能コストから差し引く。 */
export function pointBreakdown(rules, ch) {
  const core = rules.core;
  const attrs = core.attributes.reduce((s, at) => s + (ch.attributes[at.id] - at.base) * at.costPerLevel, 0);
  const derived = core.derived.reduce((s, d) => s + ((ch.derivedBought ?? {})[d.id] ?? 0) * d.costPerLevel, 0);

  let skills = Object.values(ch.skills ?? {}).reduce((s, p) => s + p, 0);
  for (const e of ch.reincarnation ?? []) {
    const def = rules.reincarnation.get(e.id);
    for (const eff of def?.effects ?? []) {
      if (eff.type === 'customSkill' && e.customSkillId) {
        const spent = (ch.skills ?? {})[e.customSkillId] ?? 0;
        skills -= Math.min(spent, eff.freePoints);
      }
    }
  }

  let advantages = 0, disadvantages = 0, reincarnation = 0;
  for (const e of ch.traits ?? []) {
    const def = rules.traits.get(e.id);
    if (!def) continue;
    const c = traitCost(def, e);
    if (c < 0) disadvantages += c; else advantages += c;
  }
  for (const e of ch.reincarnation ?? []) {
    const def = rules.reincarnation.get(e.id);
    if (def) reincarnation += traitCost(def, e);
  }
  const spent = attrs + derived + skills + advantages + disadvantages + reincarnation;
  return { attrs, derived, skills, advantages, disadvantages, reincarnation, spent,
           total: ch.pointsTotal, unspent: ch.pointsTotal - spent };
}

/**
 * キャラクターを検証する。phase: "creation"（作成時の上限を適用）か "play"。
 * previous を渡すと、成長時に転生技能を新規取得していないかも確かめる。
 */
export function validateCharacter(rules, ch, { phase = 'creation', previous = null } = {}) {
  const errors = [];
  const warn = [];
  const core = rules.core;
  const cr = core.creation;

  for (const at of core.attributes) {
    const v = ch.attributes?.[at.id];
    if (!Number.isInteger(v)) { errors.push(`${at.name}が未設定です`); continue; }
    if (phase === 'creation' && (v < cr.attributeMin || v > cr.attributeMax)) {
      errors.push(`${at.name} ${v} は作成時の範囲 ${cr.attributeMin}〜${cr.attributeMax} の外です`);
    }
  }
  for (const d of core.derived) {
    const v = (ch.derivedBought ?? {})[d.id] ?? 0;
    if (v < d.minBought || v > d.maxBought) errors.push(`${d.name}の購入数 ${v} は ${d.minBought}〜${d.maxBought} の外です`);
  }

  const owned = new Set([...(ch.traits ?? []), ...(ch.reincarnation ?? [])].map((e) => e.id));
  const seen = new Set();
  const checkEntry = (e, def, label) => {
    if (!def) { errors.push(`${label} "${e.id}" は定義されていません`); return; }
    if (seen.has(e.id)) errors.push(`${def.name}が重複しています`);
    seen.add(e.id);
    if (def.options && !def.options.some((o) => o.id === e.option)) errors.push(`${def.name}: 選択肢を選んでください`);
    if (def.costPerLevel) {
      const lv = e.level ?? def.minLevel ?? 1;
      if (lv < (def.minLevel ?? 1) || lv > def.maxLevel) errors.push(`${def.name}: レベル ${lv} は ${def.minLevel ?? 1}〜${def.maxLevel} の外です`);
    }
    if (def.requiresDetail && !e.detail) errors.push(`${def.name}: 内容（detail）を記入してください`);
    if (def.requiresTrait && !owned.has(def.requiresTrait)) errors.push(`${def.name}には「${rules.traits.get(def.requiresTrait)?.name ?? def.requiresTrait}」が必要です`);
  };
  for (const e of ch.traits ?? []) checkEntry(e, rules.traits.get(e.id), '特徴');
  for (const e of ch.reincarnation ?? []) checkEntry(e, rules.reincarnation.get(e.id), '転生技能');

  if (previous) {
    const before = new Set((previous.reincarnation ?? []).map((e) => e.id));
    for (const e of ch.reincarnation ?? []) {
      if (!before.has(e.id)) errors.push(`転生技能「${rules.reincarnation.get(e.id)?.name ?? e.id}」は作成時にしか取得できません`);
    }
    const beforeTraits = new Set((previous.traits ?? []).map((e) => e.id));
    for (const e of ch.traits ?? []) {
      const def = rules.traits.get(e.id);
      if (def?.kind === 'disadvantage' && !beforeTraits.has(e.id)) {
        errors.push(`欠点「${def.name}」は成長の場面では新しく取れません`);
      }
    }
  }

  for (const [id, p] of Object.entries(ch.skills ?? {})) {
    const def = skillDef(rules, ch, id);
    if (!def) { errors.push(`技能 "${id}" は定義されていません`); continue; }
    if (!isValidSkillPoints(p)) errors.push(`${def.name}: ${p}pt は使えません（1, 2, 4, 8, 12...）`);
    if (def.requires && !owned.has(def.requires)) errors.push(`${def.name}には「${rules.traits.get(def.requires)?.name}」が必要です`);
  }

  const bd = pointBreakdown(rules, ch);
  if (phase === 'creation') {
    if (bd.disadvantages < cr.disadvantageLimit) errors.push(`欠点の合計 ${bd.disadvantages} が上限 ${cr.disadvantageLimit} を超えています`);
    if (bd.reincarnation > cr.reincarnationLimit) errors.push(`転生技能の合計 ${bd.reincarnation}pt が上限 ${cr.reincarnationLimit}pt を超えています`);
  }
  if (bd.unspent < 0) errors.push(`ポイントが ${-bd.unspent} 足りません（使用 ${bd.spent} / ${bd.total}）`);
  if (bd.unspent > 0) warn.push(`未使用ポイントが ${bd.unspent} あります`);

  const derived = derivedValues(rules, ch);
  const skillValues = {};
  for (const id of Object.keys(ch.skills ?? {})) {
    const v = skillValue(rules, ch, id, derived);
    skillValues[id] = v;
    if (phase === 'creation' && v !== null && v > cr.skillValueCap) {
      errors.push(`${skillDef(rules, ch, id).name} ${v} が作成時の上限 ${cr.skillValueCap} を超えています`);
    }
  }
  return { ok: errors.length === 0, errors, warnings: warn, breakdown: bd, derived, skillValues };
}
