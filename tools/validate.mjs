#!/usr/bin/env node
// ルールデータ・シナリオ・キャラクターの整合性を点検する。
// 使い方: node tools/validate.mjs [シナリオやキャラクターのJSON ...]
// 引数なしなら data/rules と scenarios/*/scenario.json と docs/examples/*.json を点検する。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDice } from '../engine/dice.mjs';
import { buildRules, validateCharacter, isValidSkillPoints } from '../engine/points.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const ATTRS = ['st', 'dx', 'iq', 'ht', 'will', 'per'];
const TIERS = ['easy', 'average', 'hard'];
const DERIVED = ['hp', 'mp', 'will', 'per', 'speed', 'dodge', 'str_bonus', 'parry', 'block', 'reaction'];
const EFFECTS = ['narrative', 'situational', 'unlock', 'tag', 'skill', 'derived', 'derivedMultiplier',
  'reroll', 'resource', 'chosenSkill', 'urge', 'customSkill', 'growthBonus', 'skillCostTier', 'companion'];
const EQUIP_KINDS = ['weapon', 'armor', 'shield', 'gear', 'consumable'];
const MIN_SKILLS = 50;
const MIN_TRAITS = 50;

let failures = 0;
function report(label, errors, notes = []) {
  const mark = errors.length ? 'NG' : 'OK';
  console.log(`[${mark}] ${label}`);
  for (const n of notes) console.log(`      ${n}`);
  for (const e of errors) console.log(`   ✗ ${e}`);
  failures += errors.length;
}

function diceOk(expr, where, errors) {
  try { parseDice(expr); } catch { errors.push(`${where}: ダイス式 "${expr}" が不正`); }
}

// ---------- ルールデータ ----------
const data = {
  core: readJson(join(ROOT, 'data/rules/core.json')),
  skills: readJson(join(ROOT, 'data/rules/skills.json')),
  traits: readJson(join(ROOT, 'data/rules/traits.json')),
  reincarnation: readJson(join(ROOT, 'data/rules/reincarnation.json')),
  equipment: readJson(join(ROOT, 'data/rules/equipment.json')),
};
const backgrounds = readJson(join(ROOT, 'data/backgrounds.json'));
const bgIds = new Set(backgrounds.backgrounds.map((b) => b.id));
const bandIds = new Set(data.core.combat.rangeBands.map((b) => b.id));

function checkSkills(list, tagSet, traitIds, errors) {
  const ids = new Set();
  for (const s of list) {
    const w = `技能 ${s.id}`;
    if (ids.has(s.id)) errors.push(`${w}: id 重複`);
    ids.add(s.id);
    if (!s.name) errors.push(`${w}: name がない`);
    if (!ATTRS.includes(s.attr)) errors.push(`${w}: attr "${s.attr}" が不正`);
    if (!TIERS.includes(s.difficulty)) errors.push(`${w}: difficulty "${s.difficulty}" が不正`);
    if (typeof s.default !== 'boolean') errors.push(`${w}: default は true/false`);
    if (s.difficulty === 'hard' && s.default) errors.push(`${w}: 難技能は未修得で使えない（default:false にする）`);
    for (const t of s.tags ?? []) if (!tagSet.has(t)) errors.push(`${w}: 未定義のタグ "${t}"`);
    if (s.requires && !traitIds.has(s.requires)) errors.push(`${w}: requires "${s.requires}" が未定義`);
  }
  return ids;
}

function checkTraitList(list, kinds, ctx, errors) {
  for (const t of list) {
    const w = `${t.kind === 'reincarnation' ? '転生技能' : '特徴'} ${t.id}`;
    if (ctx.traitIds.has(t.id)) errors.push(`${w}: id 重複`);
    ctx.traitIds.add(t.id);
    if (!kinds.includes(t.kind)) errors.push(`${w}: kind "${t.kind}" が不正`);
    if (!t.name || !t.description) errors.push(`${w}: name / description がない`);
    const hasOpt = Array.isArray(t.options);
    const hasCost = t.cost !== undefined || t.costPerLevel !== undefined;
    if (hasOpt === hasCost) errors.push(`${w}: options か cost/costPerLevel のどちらか一方だけを持つこと`);
    const sign = t.kind === 'disadvantage' ? -1 : 1;
    const costs = hasOpt ? t.options.map((o) => o.cost) : [t.cost ?? 0, t.costPerLevel ?? 0];
    if (costs.some((c) => c * sign < 0)) errors.push(`${w}: コストの符号が kind と合わない`);
    if (t.costPerLevel !== undefined && !(Number.isInteger(t.maxLevel) && (t.minLevel ?? 1) <= t.maxLevel)) {
      errors.push(`${w}: minLevel/maxLevel が不正`);
    }
    for (const e of t.effects ?? []) {
      if (!EFFECTS.includes(e.type)) { errors.push(`${w}: 効果種別 "${e.type}" が未定義`); continue; }
      if (e.type === 'skill' && !ctx.skillIds.has(e.target)) errors.push(`${w}: 効果の対象技能 "${e.target}" が未定義`);
      if (e.type === 'tag' && !ctx.tagSet.has(e.target)) errors.push(`${w}: 効果の対象タグ "${e.target}" が未定義`);
      if ((e.type === 'derived' || e.type === 'derivedMultiplier') && !DERIVED.includes(e.target)) errors.push(`${w}: 派生値 "${e.target}" が未定義`);
      if (e.type === 'chosenSkill' && !ctx.tagSet.has(e.tag)) errors.push(`${w}: タグ "${e.tag}" が未定義`);
      if (e.type === 'urge' && !ATTRS.includes(e.check)) errors.push(`${w}: urge の判定 "${e.check}" が不正`);
      if (e.type === 'situational' && !e.applies) errors.push(`${w}: situational には applies（適用条件）が必要`);
      if (e.valueByOption && hasOpt) {
        for (const o of t.options) if (!(o.id in e.valueByOption)) errors.push(`${w}: valueByOption に "${o.id}" がない`);
      }
    }
  }
}

function checkEquipment(list, skillIds, ids, errors) {
  for (const e of list) {
    const w = `装備 ${e.id}`;
    if (ids.has(e.id)) errors.push(`${w}: id 重複`);
    ids.add(e.id);
    if (!EQUIP_KINDS.includes(e.kind)) errors.push(`${w}: kind "${e.kind}" が不正`);
    if (e.skill && !skillIds.has(e.skill)) errors.push(`${w}: 技能 "${e.skill}" が未定義`);
    if (e.throwSkill && !skillIds.has(e.throwSkill)) errors.push(`${w}: 技能 "${e.throwSkill}" が未定義`);
    if (e.kind === 'weapon') {
      diceOk(e.damage, w, errors);
      for (const b of e.reach ?? []) if (!bandIds.has(b)) errors.push(`${w}: 距離帯 "${b}" が未定義`);
    }
    if (e.kind === 'armor' && !Number.isInteger(e.dr)) errors.push(`${w}: dr が必要`);
  }
}

const tagSet = new Set(Object.keys(data.skills.tags));
const ctx = { tagSet, traitIds: new Set(), skillIds: null };
{
  const errors = [];
  // requires の参照先を先に集めるため、特徴idを仮に集める
  const preTraitIds = new Set([...data.traits.traits, ...data.reincarnation.reincarnation].map((t) => t.id));
  ctx.skillIds = checkSkills(data.skills.skills, tagSet, preTraitIds, errors);
  checkTraitList(data.traits.traits, ['advantage', 'disadvantage'], ctx, errors);
  checkTraitList(data.reincarnation.reincarnation, ['reincarnation'], ctx, errors);
  ctx.equipIds = new Set();
  checkEquipment(data.equipment.equipment, ctx.skillIds, ctx.equipIds, errors);

  const adv = data.traits.traits.filter((t) => t.kind === 'advantage').length;
  const dis = data.traits.traits.filter((t) => t.kind === 'disadvantage').length;
  const nSkills = data.skills.skills.length;
  if (nSkills < MIN_SKILLS) errors.push(`技能が ${nSkills} 個しかない（最低 ${MIN_SKILLS}）`);
  if (adv + dis < MIN_TRAITS) errors.push(`特徴が ${adv + dis} 個しかない（最低 ${MIN_TRAITS}）`);
  const byTag = {};
  for (const s of data.skills.skills) for (const t of s.tags) byTag[t] = (byTag[t] ?? 0) + 1;
  report('ルールデータ', errors, [
    `技能 ${nSkills} 個（${Object.entries(byTag).map(([t, n]) => `${data.skills.tags[t]}${n}`).join(' / ')}）`,
    `特徴 ${adv + dis} 個（有利 ${adv} / 欠点 ${dis}）、転生技能 ${data.reincarnation.reincarnation.length} 個、装備 ${data.equipment.equipment.length} 個`,
  ]);
}

// ---------- シナリオ ----------
function condFlags(c, out = []) {
  if (!c) return out;
  if (c.flag) out.push(c.flag);
  for (const k of ['all', 'any']) for (const x of c[k] ?? []) condFlags(x, out);
  if (c.not) condFlags(c.not, out);
  return out;
}

function validateScenario(path) {
  const errors = [];
  const sc = readJson(path);
  const need = ['formatVersion', 'id', 'version', 'title', 'rulesVersion', 'players', 'pvp', 'start', 'locations'];
  for (const k of need) if (sc[k] === undefined) errors.push(`必須項目 ${k} がない`);
  if (!/^[a-z][a-z0-9_]*$/.test(sc.id ?? '')) errors.push(`id "${sc.id}" は英小文字・数字・_ のみ`);
  if (!data.core.pvp.modes.includes(sc.pvp?.mode)) errors.push(`pvp.mode "${sc.pvp?.mode}" が不正`);

  // 拡張ルール：x_ 接頭辞で、本体と衝突しないこと
  const ext = sc.ruleExtensions ?? {};
  for (const kind of ['skills', 'traits', 'reincarnation', 'equipment']) {
    for (const x of ext[kind] ?? []) {
      if (!x.id?.startsWith('x_')) errors.push(`拡張 ${kind} "${x.id}" は x_ で始めること`);
    }
  }
  const extCtx = { tagSet, traitIds: new Set(ctx.traitIds), skillIds: new Set(ctx.skillIds) };
  const extSkillIds = checkSkills(ext.skills ?? [], tagSet, new Set([...ctx.traitIds, ...(ext.traits ?? []).map((t) => t.id)]), errors);
  for (const id of extSkillIds) { if (ctx.skillIds.has(id)) errors.push(`拡張技能 ${id} が本体と衝突`); extCtx.skillIds.add(id); }
  checkTraitList(ext.traits ?? [], ['advantage', 'disadvantage'], extCtx, errors);
  checkTraitList(ext.reincarnation ?? [], ['reincarnation'], extCtx, errors);
  const equipIds = new Set(ctx.equipIds);
  checkEquipment(ext.equipment ?? [], extCtx.skillIds, equipIds, errors);
  const itemIds = new Set([...equipIds, ...(sc.items ?? []).map((i) => i.id)]);

  const flagIds = new Set((sc.flags ?? []).map((f) => f.id));
  const locIds = new Set();
  for (const l of sc.locations ?? []) { if (locIds.has(l.id)) errors.push(`場所 ${l.id}: id 重複`); locIds.add(l.id); }
  const npcIds = new Set();
  for (const n of sc.npcs ?? []) { if (npcIds.has(n.id)) errors.push(`NPC ${n.id}: id 重複`); npcIds.add(n.id); }

  const checkCond = (c, w) => { for (const f of condFlags(c)) if (!flagIds.has(f)) errors.push(`${w}: 未定義のフラグ "${f}"`); };
  const checkEffects = (effs, w) => {
    for (const e of effs ?? []) {
      if ('setFlag' in e && !flagIds.has(e.setFlag)) errors.push(`${w}: 未定義のフラグ "${e.setFlag}"`);
      if ('moveParty' in e && !locIds.has(e.moveParty)) errors.push(`${w}: 未定義の場所 "${e.moveParty}"`);
      if ('giveItem' in e && !itemIds.has(e.giveItem)) errors.push(`${w}: 未定義のアイテム "${e.giveItem}"`);
      if ('spawnNpc' in e && !npcIds.has(e.spawnNpc)) errors.push(`${w}: 未定義のNPC "${e.spawnNpc}"`);
      if ('damage' in e) diceOk(e.damage, w, errors);
    }
  };
  const checkSkillRef = (s, w) => { if (s && !extCtx.skillIds.has(s) && !ATTRS.includes(s)) errors.push(`${w}: 技能 "${s}" が未定義`); };

  if (!locIds.has(sc.start?.locationId)) errors.push(`start.locationId "${sc.start?.locationId}" が未定義`);
  for (const l of sc.locations ?? []) {
    const w = `場所 ${l.id}`;
    if (!l.name || !l.public) errors.push(`${w}: name / public がない`);
    if (l.background && !bgIds.has(l.background)) errors.push(`${w}: 背景 "${l.background}" が data/backgrounds.json にない`);
    for (const n of l.npcs ?? []) if (!npcIds.has(n)) errors.push(`${w}: NPC "${n}" が未定義`);
    for (const c of l.clues ?? []) checkSkillRef(c.discover?.skill, `${w} 手がかり ${c.id}`);
    for (const h of l.hazards ?? []) { checkSkillRef(h.check?.skill, `${w} 危険 ${h.id}`); checkEffects(h.onFail, `${w} 危険 ${h.id}`); }
    for (const x of l.exits ?? []) {
      if (!locIds.has(x.to)) errors.push(`${w}: 出口の行き先 "${x.to}" が未定義`);
      checkCond(x.condition, `${w} 出口→${x.to}`);
    }
  }
  const rules = buildRules(data, ext);
  for (const n of sc.npcs ?? []) {
    const w = `NPC ${n.id}`;
    if (!['npc', 'monster'].includes(n.kind)) errors.push(`${w}: kind は npc / monster`);
    for (const it of n.inventory ?? []) if (!itemIds.has(it)) errors.push(`${w}: 所持品 "${it}" が未定義`);
    if (n.statblock) {
      const sb = n.statblock;
      for (const k of ['hp', 'dodge', 'will', 'per']) if (!Number.isInteger(sb[k])) errors.push(`${w}: statblock.${k} が必要`);
      for (const a of sb.attacks ?? []) {
        diceOk(a.damage, `${w} 攻撃 ${a.name}`, errors);
        for (const b of a.reach ?? []) if (!bandIds.has(b)) errors.push(`${w}: 距離帯 "${b}" が未定義`);
      }
      for (const s of Object.keys(sb.skills ?? {})) checkSkillRef(s, w);
    } else if (n.sheet) {
      const r = validateCharacter(rules, n.sheet, { phase: 'play' });
      for (const e of r.errors) errors.push(`${w}: ${e}`);
    }
  }
  for (const ev of sc.events ?? []) {
    const w = `出来事 ${ev.id}`;
    const t = ev.trigger ?? {};
    if (t.type === 'enterLocation' && !locIds.has(t.location)) errors.push(`${w}: 場所 "${t.location}" が未定義`);
    else if (t.type === 'npcDefeated' && !npcIds.has(t.npc)) errors.push(`${w}: NPC "${t.npc}" が未定義`);
    else if (t.type === 'flag') checkCond(t.condition, w);
    else if (!['enterLocation', 'npcDefeated', 'flag', 'time', 'round'].includes(t.type)) errors.push(`${w}: trigger.type "${t.type}" が不正`);
    checkEffects(ev.effects, w);
  }
  if (!(sc.endings ?? []).length) errors.push('結末（endings）が1つもない');
  for (const en of sc.endings ?? []) checkCond(en.condition, `結末 ${en.id}`);
  if (sc.pvp?.mode === 'zones') {
    for (const z of sc.pvp.zones ?? []) if (!locIds.has(z)) errors.push(`pvp.zones: 場所 "${z}" が未定義`);
  }
  report(`シナリオ ${path.replace(ROOT + '/', '')}`, errors, [
    `場所 ${locIds.size} / NPC ${npcIds.size} / フラグ ${flagIds.size} / 出来事 ${(sc.events ?? []).length} / 結末 ${(sc.endings ?? []).length}`,
  ]);
}

function validateCharacterFile(path) {
  const ch = readJson(path);
  const rules = buildRules(data);
  const errors = [];
  for (const [id, p] of Object.entries(ch.skills ?? {})) if (!isValidSkillPoints(p)) errors.push(`技能 ${id}: ${p}pt`);
  const r = validateCharacter(rules, ch, { phase: 'creation' });
  const b = r.breakdown;
  report(`キャラクター ${path.replace(ROOT + '/', '')}（${ch.name}）`, [...errors, ...r.errors], [
    `能力値 ${b.attrs} / 派生 ${b.derived} / 技能 ${b.skills} / 有利 ${b.advantages} / 欠点 ${b.disadvantages} / 転生 ${b.reincarnation} → ${b.spent}/${b.total}`,
    `HP ${r.derived.hp} MP ${r.derived.mp} 意志 ${r.derived.will} 知覚 ${r.derived.per} 速度 ${r.derived.speed} 回避 ${r.derived.dodge}`,
    ...r.warnings,
  ]);
}

// ---------- 対象の決定 ----------
let targets = process.argv.slice(2).map((p) => resolve(p));
if (!targets.length) {
  const scDir = join(ROOT, 'scenarios');
  if (existsSync(scDir)) {
    for (const d of readdirSync(scDir, { withFileTypes: true })) {
      const p = join(scDir, d.name, 'scenario.json');
      if (d.isDirectory() && existsSync(p)) targets.push(p);
    }
  }
  const exDir = join(ROOT, 'docs/examples');
  for (const f of readdirSync(exDir)) if (f.endsWith('.json')) targets.push(join(exDir, f));
}
for (const t of targets) {
  const j = readJson(t);
  if (j.locations) validateScenario(t);
  else if (j.attributes) validateCharacterFile(t);
  else report(t, ['シナリオでもキャラクターでもない JSON']);
}

console.log(failures ? `\n${failures} 件の問題があります` : '\nすべて問題ありません');
process.exit(failures ? 1 : 0);
