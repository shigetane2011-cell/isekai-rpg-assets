// 転生者登録票（キャラクター作成画面）。
// 数値はすべて engine/points.mjs で計算し、保存とAI呼び出しは app/adapters を通す。
import { validateCharacter, skillValue, derivedValues, skillDef, traitCost } from '../../engine/points.mjs';
import { loadRules } from '../rules-loader.mjs';
import { createStore } from '../adapters/store.mjs';
import { createGm } from '../adapters/gm.mjs';
import { buildSuggestPrompt, sanitizeProposal, costLabel, makePastKnowledgeSkill, PAST_KNOWLEDGE_SKILL_ID } from './suggest.mjs';

const DRAFT_KEY = 'isekai-trpg.draft';
const SAMPLE_URL = new URL('../../docs/examples/character-sample.json', import.meta.url);
const POINT_STEPS = [0, 1, 2, 4, 8, 12, 16, 20, 24];
const ATTR_NAME = { st: '筋力', dx: '敏捷', iq: '知力', ht: '体力', will: '意志', per: '知覚' };
const DIFF_NAME = { easy: '易', average: '普', hard: '難' };
const KIND_NAME = { weapon: '武器', armor: '鎧・兜', shield: '盾', gear: '道具', consumable: '消耗品' };

const $ = (sel) => document.querySelector(sel);

/** 安全にDOMを組み立てる小さな関数。文字列の子は textContent になる。 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const state = {
  data: null,
  rules: null,
  store: null,
  gm: null,
  ch: null,
  isSample: false,
  tab: 'attrs',
  skillTag: 'all',
  skillQuery: '',
  ownedOnly: false,
  traitKind: 'advantage',
  traitQuery: '',
  library: [],
  ai: { busy: false, ctl: null, result: null, error: null },
  armed: null, // 二段階確認中のボタン
};

// ---------- キャラクターの雛形と補助 ----------

function blankCharacter() {
  const core = state.data.core;
  return {
    id: null,
    name: '',
    concept: '',
    rulesVersion: core.rulesVersion,
    pointsTotal: core.creation.startingPoints,
    attributes: Object.fromEntries(core.attributes.map((a) => [a.id, a.base])),
    derivedBought: { hp: 0, mp: 0, will: 0, per: 0 },
    skills: {},
    customSkills: [],
    traits: [],
    reincarnation: [],
    equipment: [{ id: 'clothes', qty: 1, equipped: true }],
    money: core.creation.startingMoney,
    state: { hp: null, mp: null, conditions: [] },
  };
}

function normalize(ch) {
  const base = blankCharacter();
  return {
    ...base, ...ch,
    attributes: { ...base.attributes, ...(ch.attributes ?? {}) },
    derivedBought: { ...base.derivedBought, ...(ch.derivedBought ?? {}) },
    skills: { ...(ch.skills ?? {}) },
    customSkills: [...(ch.customSkills ?? [])],
    traits: [...(ch.traits ?? [])],
    reincarnation: [...(ch.reincarnation ?? [])],
    equipment: [...(ch.equipment ?? base.equipment)],
  };
}

function moneyBudget(ch) {
  const start = state.data.core.creation.startingMoney;
  const wealth = ch.traits.find((t) => t.id === 'wealth');
  const def = state.rules.traits.get('wealth');
  const mult = wealth ? def.effects[0].multiplierByOption[wealth.option] ?? 1 : 1;
  return start * mult;
}
function moneySpent(ch) {
  return ch.equipment.reduce((s, e) => s + (state.rules.equipment.get(e.id)?.price ?? 0) * (e.qty ?? 1), 0);
}

function evaluate() {
  const ch = state.ch;
  ch.money = moneyBudget(ch) - moneySpent(ch);
  const result = validateCharacter(state.rules, ch, { phase: 'creation' });
  if (ch.money < 0) result.errors.push(`装備の代金が所持金を ${-ch.money} 銀貨超えています`);
  for (const e of ch.equipment) {
    const def = state.rules.equipment.get(e.id);
    if (def?.minSt && e.equipped && ch.attributes.st < def.minSt) {
      result.warnings.push(`${def.name}は筋力${def.minSt}以上が必要です（現在${ch.attributes.st}）`);
    }
  }
  if (!ch.name.trim()) result.warnings.push('名前が未記入です');
  result.ok = result.errors.length === 0;
  return result;
}

let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ch: state.ch, isSample: state.isSample })); } catch { /* 下書きは任意 */ }
  }, 400);
}

/** 状態を変えたら必ずこれを呼ぶ。集計と現在のタブを描き直す。 */
function commit({ panel = true } = {}) {
  saveDraft();
  renderSummary();
  if (panel) renderPanel();
  renderBadges();
  syncJson();
}

function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/** 押すと「本当に〜」に変わり、4秒以内にもう一度押すと実行するボタン。 */
function twoStep(key, btn, label, confirmLabel, action) {
  if (state.armed?.key === key) {
    clearTimeout(state.armed.timer);
    state.armed = null;
    action();
    return;
  }
  if (state.armed) { clearTimeout(state.armed.timer); state.armed.reset(); }
  btn.textContent = confirmLabel;
  btn.classList.add('danger');
  const reset = () => { btn.textContent = label; btn.classList.remove('danger'); };
  state.armed = { key, reset, timer: setTimeout(() => { reset(); state.armed = null; }, 4000) };
}

// ---------- 集計欄 ----------

function renderSummary() {
  const r = evaluate();
  const b = r.breakdown;
  const d = r.derived;
  const c = state.data.core.creation;
  const pct = Math.min(100, Math.round((b.spent / Math.max(1, b.total)) * 100));
  const over = b.unspent < 0;

  const top = Object.entries(r.skillValues)
    .filter(([, v]) => v !== null)
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, 6)
    .map(([id, v]) => h('li', {}, h('span', {}, skillDef(state.rules, state.ch, id)?.name ?? id), h('span', { class: 'num' }, v)));

  const issues = [
    ...r.errors.map((e) => h('li', { class: 'error' }, e)),
    ...r.warnings.map((w) => h('li', { class: 'warn' }, w)),
  ];
  if (!issues.length) issues.push(h('li', { class: 'ok' }, '作成ルール上の問題はありません'));

  const row = (label, n, note) => h('tr', {}, h('td', {}, label, note ? h('span', { class: 'meta' }, ` ${note}`) : null), h('td', { class: 'n' }, n));
  const aside = $('#summary');
  aside.replaceChildren(
    h('div', { class: 'sec' },
      h('div', { class: 'meter' },
        h('div', { class: 'big' }, h('span', {}, '残りポイント'), h('strong', { class: over ? 'over num' : 'num' }, b.unspent)),
        h('div', { class: 'bar' }, h('span', { class: over ? 'over' : '', style: `width:${pct}%` })),
        h('div', { class: 'points-total' },
          h('label', { for: 'f-total' }, '初期ポイント'),
          h('input', { id: 'f-total', type: 'number', min: 50, max: 500, step: 5, value: state.ch.pointsTotal, class: 'num' }),
        ),
      ),
      h('table', { class: 'bd' },
        h('tbody', {},
          row('能力値', b.attrs),
          row('派生値', b.derived),
          row('技能', b.skills),
          row('有利な特徴', b.advantages),
          row('欠点', b.disadvantages, `（上限 ${c.disadvantageLimit}）`),
          row('転生技能', b.reincarnation, `（上限 ${c.reincarnationLimit}）`),
          h('tr', { class: 'total' }, h('td', {}, '使用 ／ 合計'), h('td', { class: 'n' }, `${b.spent} / ${b.total}`)),
        ),
      ),
    ),
    h('div', { class: 'sec' },
      h('h3', {}, '派生値'),
      h('div', { class: 'derived' },
        ...[['HP', d.hp], ['MP', d.mp], ['意志', d.will], ['知覚', d.per], ['速度', d.speed], ['回避', d.dodge], ['筋力ボ', fmtSigned(d.str_bonus)], ['反応', fmtSigned(d.reaction)]]
          .map(([k, v]) => h('div', {}, h('span', {}, k), h('b', {}, v))),
      ),
      h('h3', {}, '主な技能'),
      top.length ? h('ul', { class: 'top-skills' }, top) : h('p', { class: 'hint' }, 'まだ技能を取っていません'),
    ),
    h('div', { class: 'sec' },
      h('h3', {}, `確認事項（${r.errors.length ? `問題 ${r.errors.length}件` : '問題なし'}）`),
      h('ul', { class: 'issues' }, issues),
    ),
  );
  $('#f-total').addEventListener('change', (e) => {
    const v = Math.max(50, Math.min(500, Math.round(Number(e.target.value) || c.startingPoints)));
    state.ch.pointsTotal = v;
    commit({ panel: false });
  });

  $('#dock-points').textContent = b.unspent;
  $('#dock-points').style.color = over ? 'var(--bad)' : '';
  $('#dock-issues').textContent = r.errors.length ? `問題 ${r.errors.length}件` : '問題なし';
}

const fmtSigned = (v) => (v > 0 ? `+${v}` : String(v));

function renderBadges() {
  const ch = state.ch;
  const n = Object.values(ch.skills).filter((p) => p > 0).length;
  $('#badge-skills').textContent = n ? n : '';
  $('#badge-traits').textContent = ch.traits.length ? ch.traits.length : '';
  $('#badge-reinc').textContent = ch.reincarnation.length ? ch.reincarnation.length : '';
}

// ---------- タブ ----------

function renderPanel() {
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === state.tab));
  $('#panel').setAttribute('aria-labelledby', `tab-${state.tab}`);
  const fn = { attrs: panelAttrs, skills: panelSkills, traits: panelTraits, reinc: panelReinc, gear: panelGear }[state.tab];
  $('#panel').replaceChildren(...fn());
}

function stepper(id, value, min, max, onChange, label) {
  return h('span', { class: 'stepper' },
    h('button', { type: 'button', 'aria-label': `${label}を1下げる`, disabled: value <= min, onclick: () => onChange(value - 1) }, '−'),
    h('output', { id }, value),
    h('button', { type: 'button', 'aria-label': `${label}を1上げる`, disabled: value >= max, onclick: () => onChange(value + 1) }, '+'),
  );
}

function panelAttrs() {
  const core = state.data.core;
  const c = core.creation;
  const ch = state.ch;
  const d = derivedValues(state.rules, ch);
  const attrs = core.attributes.map((a) => {
    const v = ch.attributes[a.id];
    const cost = (v - a.base) * a.costPerLevel;
    return h('div', { class: 'stat' },
      h('span', { class: 'name' }, a.name),
      stepper(`v-${a.id}`, v, c.attributeMin, c.attributeMax, (nv) => { ch.attributes[a.id] = nv; commit(); }, a.name),
      h('span', { class: 'sub' }, `1点 ${a.costPerLevel}pt ／ 現在 `, h('span', { class: 'num' }, fmtSigned(cost)), 'pt'),
    );
  });
  const buyable = core.derived.filter((x) => x.costPerLevel > 0).map((x) => {
    const v = ch.derivedBought[x.id] ?? 0;
    return h('div', { class: 'stat' },
      h('span', { class: 'name' }, `${x.name} `, h('span', { class: 'meta num' }, `= ${d[x.id]}`)),
      stepper(`v-d-${x.id}`, v, x.minBought, x.maxBought, (nv) => { ch.derivedBought[x.id] = nv; commit(); }, `${x.name}の購入数`),
      h('span', { class: 'sub' }, `1点 ${x.costPerLevel}pt（${fmtSigned(x.minBought)}〜${fmtSigned(x.maxBought)}）`),
    );
  });
  return [
    h('p', { class: 'hint' }, `基準は10。作成時は${c.attributeMin}〜${c.attributeMax}の範囲で、10より下げるとポイントが戻ります。`),
    h('div', { class: 'stat-grid' }, attrs),
    h('h3', {}, '派生値の追加購入'),
    h('p', { class: 'hint' }, 'HP・MPは能力値から決まる値に上乗せします。意志・知覚は知力が基準で、下げることもできます。'),
    h('div', { class: 'stat-grid' }, buyable),
  ];
}

function hasTrait(id) {
  return state.ch.traits.some((t) => t.id === id) || state.ch.reincarnation.some((t) => t.id === id);
}

function panelSkills() {
  const tags = state.data.skills.tags;
  const ch = state.ch;
  const d = derivedValues(state.rules, ch);
  const q = state.skillQuery.trim();
  const all = [...ch.customSkills, ...state.data.skills.skills];
  const shown = all.filter((s) => {
    if (state.skillTag !== 'all' && !(s.tags ?? []).includes(state.skillTag)) return false;
    if (state.ownedOnly && !(ch.skills[s.id] > 0)) return false;
    if (q && !(s.name.includes(q) || s.description?.includes(q) || s.id.includes(q))) return false;
    return true;
  });

  const filterBtns = [['all', 'すべて'], ...Object.entries(tags)].map(([id, name]) =>
    h('button', { type: 'button', class: 'filter', 'aria-pressed': String(state.skillTag === id), onclick: () => { state.skillTag = id; renderPanel(); } }, name));

  const search = h('input', { class: 'inline-input', id: 'f-skill-q', type: 'search', placeholder: '技能を探す', value: state.skillQuery });
  search.addEventListener('input', () => { state.skillQuery = search.value; renderSkillList(); });
  const owned = h('input', { type: 'checkbox', id: 'f-owned', checked: state.ownedOnly });
  owned.addEventListener('change', () => { state.ownedOnly = owned.checked; renderSkillList(); });

  const listEl = h('div', { class: 'list', id: 'skill-list' });
  const renderSkillList = () => {
    const qq = state.skillQuery.trim();
    const rows = all.filter((s) => {
      if (state.skillTag !== 'all' && !(s.tags ?? []).includes(state.skillTag)) return false;
      if (state.ownedOnly && !(ch.skills[s.id] > 0)) return false;
      if (qq && !(s.name.includes(qq) || s.description?.includes(qq) || s.id.includes(qq))) return false;
      return true;
    }).map((s) => skillRow(s, d));
    listEl.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty' }, '条件に合う技能はありません')]));
  };
  listEl.replaceChildren(...(shown.length ? shown.map((s) => skillRow(s, d)) : [h('p', { class: 'empty' }, '条件に合う技能はありません')]));
  return [
    h('p', { class: 'hint' }, '使うポイントを選びます。1・2・4pt、以降4ptごとに技能値が上がります。灰色の数字は未修得のまま使ったときの値です。'),
    h('div', { class: 'filters' }, filterBtns),
    h('div', { class: 'filters' }, search, h('label', { class: 'toggle', for: 'f-owned' }, owned, '習得済みのみ')),
    listEl,
  ];
}

function skillRow(s, d) {
  const ch = state.ch;
  const pts = ch.skills[s.id] ?? 0;
  const locked = s.requires && !hasTrait(s.requires);
  const value = skillValue(state.rules, ch, s.id, d);
  const sel = h('select', { id: `sk-${s.id}`, 'aria-label': `${s.name}に使うポイント`, disabled: locked });
  for (const p of POINT_STEPS) sel.append(h('option', { value: p, selected: p === pts }, p ? `${p}pt` : '—'));
  sel.addEventListener('change', () => {
    const v = Number(sel.value);
    if (v) ch.skills[s.id] = v; else delete ch.skills[s.id];
    commit();
  });
  const reqName = s.requires ? state.rules.traits.get(s.requires)?.name : null;
  return h('div', { class: `item${pts ? ' owned' : ''}${locked ? ' locked' : ''}` },
    h('div', { class: 'title' }, s.name,
      h('span', { class: 'meta' }, `${ATTR_NAME[s.attr]}・${DIFF_NAME[s.difficulty]}`),
      s.source === 'past_knowledge' ? h('span', { class: 'meta' }, '前世の知識（4ptまで無償）') : null,
      locked ? h('span', { class: 'meta' }, `「${reqName}」が必要`) : null),
    h('div', { class: 'controls' },
      h('span', { class: `value${pts ? '' : ' untrained'}` }, value === null ? (pts ? '—' : '不可') : value),
      sel),
    h('p', { class: 'desc' }, s.description ?? ''),
  );
}

function effectNotes(def) {
  const notes = [];
  for (const e of def.effects ?? []) {
    if (e.type === 'situational') notes.push(`条件付き：${e.applies}`);
    if (e.type === 'urge') notes.push(`衝動：${e.when}（${ATTR_NAME[e.check] ?? e.check}判定）`);
  }
  return notes;
}

function costText(def) {
  if (def.options) return def.options.map((o) => `${o.label} ${o.cost}`).join(' ／ ') + 'pt';
  if (def.costPerLevel) {
    const base = def.cost ? `${def.cost}pt＋` : '';
    return `${base}Lv×${def.costPerLevel}pt（Lv${def.minLevel ?? 1}〜${def.maxLevel}）`;
  }
  return `${def.cost}pt`;
}

/** 特徴・転生技能の1行。listKey は 'traits' か 'reincarnation'。 */
function traitRow(def, listKey) {
  const list = state.ch[listKey];
  const entry = list.find((e) => e.id === def.id);
  const owned = !!entry;
  const checkbox = h('input', { type: 'checkbox', id: `tr-${def.id}`, checked: owned });
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) addTrait(def, listKey); else removeTrait(def, listKey);
    commit();
  });
  const cost = owned ? traitCost(def, entry) : null;
  const sub = [];
  if (owned) {
    if (def.options) {
      const sel = h('select', { 'aria-label': `${def.name}の段階` });
      for (const o of def.options) sel.append(h('option', { value: o.id, selected: o.id === entry.option }, `${o.label}（${o.cost}pt）`));
      sel.addEventListener('change', () => { entry.option = sel.value; commit(); });
      sub.push(sel);
    }
    if (def.costPerLevel) {
      const sel = h('select', { 'aria-label': `${def.name}のレベル` });
      for (let lv = def.minLevel ?? 1; lv <= def.maxLevel; lv++) {
        sel.append(h('option', { value: lv, selected: lv === (entry.level ?? def.minLevel ?? 1) }, `Lv${lv}（${traitCost(def, { level: lv })}pt）`));
      }
      sel.addEventListener('change', () => { entry.level = Number(sel.value); commit(); });
      sub.push(sel);
    }
    if (def.requiresDetail) sub.push(detailControl(def, entry));
  }
  const notes = effectNotes(def);
  return h('div', { class: `item${owned ? ' owned' : ''}${listKey === 'reincarnation' ? ' reinc' : ''}` },
    h('div', { class: 'title' },
      h('label', { class: 'check', for: `tr-${def.id}` }, checkbox, def.name),
      h('span', { class: `cost${(cost ?? def.cost ?? def.costPerLevel ?? def.options?.[0]?.cost ?? 0) < 0 ? ' neg' : ''}` }, owned ? `${cost}pt` : costText(def)),
      def.requiresTrait ? h('span', { class: 'meta' }, `「${state.rules.traits.get(def.requiresTrait)?.name}」が必要`) : null),
    h('div', { class: 'controls' }),
    h('p', { class: 'desc' }, def.description, ...notes.map((n) => [h('br'), n]), def.pvp ? [h('br'), `PVP：${def.pvp}`] : null),
    sub.length ? h('div', { class: 'sub-controls' }, sub) : null,
  );
}

function detailControl(def, entry) {
  const tags = state.data.skills.tags;
  if (def.id === 'weapon_talent') {
    const sel = h('select', { 'aria-label': '対象の武器技能' });
    sel.append(h('option', { value: '' }, '武器技能を選ぶ'));
    for (const s of state.data.skills.skills.filter((x) => x.tags.includes('melee'))) {
      sel.append(h('option', { value: s.id, selected: entry.detail === s.id }, s.name));
    }
    sel.addEventListener('change', () => { entry.detail = sel.value; commit(); });
    return sel;
  }
  if (def.id === 'gifted') {
    const sel = h('select', { 'aria-label': '対象の分類' });
    sel.append(h('option', { value: '' }, '分類を選ぶ'));
    for (const [id, name] of Object.entries(tags)) sel.append(h('option', { value: id, selected: entry.detail === id }, name));
    sel.addEventListener('change', () => { entry.detail = sel.value; commit(); });
    return sel;
  }
  const placeholder = def.id === 'past_knowledge' ? '前世の分野（例：薬学、機械工学）' : '内容を書く（例：相手の名前、誓いの中身）';
  const input = h('input', { class: 'inline-input', id: `detail-${def.id}`, value: entry.detail ?? '', maxlength: 60, placeholder, 'aria-label': `${def.name}の内容` });
  input.addEventListener('input', () => {
    entry.detail = input.value;
    if (def.id === 'past_knowledge') {
      const cs = state.ch.customSkills.find((s) => s.id === entry.customSkillId);
      if (cs) cs.name = makePastKnowledgeSkill(input.value || '前世の専門').name;
    }
    commit({ panel: false });
  });
  return input;
}

function addTrait(def, listKey) {
  const entry = { id: def.id };
  if (def.options) entry.option = def.options[0].id;
  if (def.costPerLevel) entry.level = def.minLevel ?? 1;
  if (def.requiresDetail) entry.detail = '';
  if (def.id === 'past_knowledge') {
    entry.customSkillId = PAST_KNOWLEDGE_SKILL_ID;
    state.ch.customSkills = state.ch.customSkills.filter((s) => s.id !== PAST_KNOWLEDGE_SKILL_ID);
    state.ch.customSkills.push(makePastKnowledgeSkill('前世の専門'));
    state.ch.skills[PAST_KNOWLEDGE_SKILL_ID] = 4;
  }
  state.ch[listKey].push(entry);
}

function removeTrait(def, listKey) {
  const old = state.ch[listKey].find((e) => e.id === def.id);
  state.ch[listKey] = state.ch[listKey].filter((e) => e.id !== def.id);
  if (def.id === 'past_knowledge') {
    const sid = old?.customSkillId ?? PAST_KNOWLEDGE_SKILL_ID;
    state.ch.customSkills = state.ch.customSkills.filter((s) => s.id !== sid);
    delete state.ch.skills[sid];
  }
  if (def.id === 'magery') {
    for (const s of state.data.skills.skills) if (s.requires === 'magery') delete state.ch.skills[s.id];
  }
}

function panelTraits() {
  const kinds = [['advantage', '有利な特徴'], ['disadvantage', '欠点']];
  const btns = kinds.map(([k, name]) => h('button', { type: 'button', class: 'filter', 'aria-pressed': String(state.traitKind === k), onclick: () => { state.traitKind = k; renderPanel(); } },
    name, h('span', { class: 'meta' }, ` ${state.ch.traits.filter((t) => state.rules.traits.get(t.id)?.kind === k).length}`)));
  const search = h('input', { class: 'inline-input', id: 'f-trait-q', type: 'search', placeholder: '特徴を探す', value: state.traitQuery });
  const listEl = h('div', { class: 'list' });
  const fill = () => {
    const q = state.traitQuery.trim();
    const rows = state.data.traits.traits
      .filter((t) => t.kind === state.traitKind)
      .filter((t) => !q || t.name.includes(q) || t.description.includes(q))
      .map((t) => traitRow(t, 'traits'));
    listEl.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty' }, '条件に合う特徴はありません')]));
  };
  search.addEventListener('input', () => { state.traitQuery = search.value; fill(); });
  fill();
  const lim = state.data.core.creation.disadvantageLimit;
  return [
    h('p', { class: 'hint' }, state.traitKind === 'advantage'
      ? '有利な特徴はポイントで買います。「条件付き」の効果は、判定のたびにGMが当てはまるかを判断し、数値はシステムが足します。'
      : `欠点を取るとポイントが戻ります（合計 ${lim} まで）。「衝動」のある欠点は、決まった場面で意志判定を求められます。`),
    h('div', { class: 'filters' }, btns, search),
    listEl,
  ];
}

function panelReinc() {
  const used = state.ch.reincarnation.reduce((s, e) => s + traitCost(state.rules.reincarnation.get(e.id), e), 0);
  const lim = state.data.core.creation.reincarnationLimit;
  return [
    h('div', { class: 'reinc-banner' },
      h('b', {}, '転生技能はキャラクター作成時にしか取得できません。'),
      ` 冒険の途中で新しく得ることはできず、レベルのあるものだけ後から強化できます。合計 ${lim}pt まで（現在 `,
      h('span', { class: 'num' }, used), 'pt）。'),
    h('div', { class: 'list' }, state.data.reincarnation.reincarnation.map((t) => traitRow(t, 'reincarnation'))),
  ];
}

function panelGear() {
  const ch = state.ch;
  const budget = moneyBudget(ch);
  const spent = moneySpent(ch);
  const groups = {};
  for (const e of state.data.equipment.equipment) {
    if (e.id === 'unarmed') continue;
    (groups[e.kind] ??= []).push(e);
  }
  const row = (def) => {
    const entry = ch.equipment.find((x) => x.id === def.id);
    const qty = entry?.qty ?? 0;
    const setQty = (n) => {
      if (n <= 0) ch.equipment = ch.equipment.filter((x) => x.id !== def.id);
      else if (entry) entry.qty = n;
      else ch.equipment.push({ id: def.id, qty: n, equipped: ['weapon', 'armor', 'shield'].includes(def.kind) });
      commit();
    };
    const facts = [];
    if (def.damage) facts.push(`ダメージ ${def.damage}`);
    if (def.skill) facts.push(state.rules.skills.get(def.skill)?.name);
    if (def.dr !== undefined) facts.push(`防護点 ${def.dr}`);
    if (def.dodgePenalty) facts.push(`回避 ${def.dodgePenalty}`);
    if (def.stealthPenalty) facts.push(`隠密 ${def.stealthPenalty}`);
    if (def.minSt) facts.push(`筋力${def.minSt}以上`);
    if (def.notes) facts.push(def.notes);
    let equip = null;
    if (entry && ['weapon', 'armor', 'shield'].includes(def.kind)) {
      const cb = h('input', { type: 'checkbox', id: `eq-${def.id}`, checked: !!entry.equipped });
      cb.addEventListener('change', () => { entry.equipped = cb.checked; commit(); });
      equip = h('label', { class: 'check', for: `eq-${def.id}` }, cb, '装備中');
    }
    return h('div', { class: `item${qty ? ' owned' : ''}` },
      h('div', { class: 'title' }, def.name, h('span', { class: 'cost' }, `${def.price} 銀貨`)),
      h('div', { class: 'controls' }, equip, stepper(`q-${def.id}`, qty, 0, 99, setQty, `${def.name}の数`)),
      h('p', { class: 'desc' }, facts.filter(Boolean).join('、')),
    );
  };
  return [
    h('p', { class: 'hint' }, '所持金 ', h('b', { class: 'num' }, budget), ' 銀貨（「裕福」で増えます）。残り ',
      h('b', { class: 'num', style: ch.money < 0 ? 'color:var(--bad)' : '' }, budget - spent), ' 銀貨。'),
    ...Object.entries(groups).flatMap(([kind, items]) => [h('h3', {}, KIND_NAME[kind] ?? kind), h('div', { class: 'list' }, items.map(row))]),
  ];
}

// ---------- AIの配分案 ----------

async function suggest({ fresh = false, fixFrom = null } = {}) {
  const concept = $('#f-concept').value.trim();
  if (!concept) { setStatus('先に「設定」を書いてください。', true); $('#f-concept').focus(); return; }
  const ctl = new AbortController();
  state.ai = { busy: true, ctl, result: null, error: null };
  renderProposal();
  const prompt = buildSuggestPrompt(state.data, {
    name: state.ch.name,
    concept,
    pointsTotal: state.ch.pointsTotal,
    previous: fixFrom?.raw ?? null,
    errors: fixFrom?.errors ?? null,
  });
  try {
    const raw = await state.gm.json(prompt, { tier: 'default', fresh: fresh || !!fixFrom, signal: ctl.signal });
    const base = { ...state.ch };
    const s = sanitizeProposal(state.rules, state.data, raw, base);
    s.character.money = moneyBudget(s.character) - moneySpent(s.character);
    const v = validateCharacter(state.rules, s.character, { phase: 'creation' });
    state.ai = { busy: false, ctl: null, result: { ...s, raw, validation: v }, error: null };
  } catch (e) {
    state.ai = { busy: false, ctl: null, result: null, error: e };
    if (e.permanent) hideAi(e.message);
  }
  renderProposal();
}

function hideAi(message) {
  $('#btn-suggest').disabled = true;
  $('#ai-hint').textContent = message;
}

function renderProposal() {
  const box = $('#proposal');
  const ai = state.ai;
  $('#btn-stop').hidden = !ai.busy;
  $('#btn-suggest').disabled = ai.busy || !state.gm?.available;
  if (ai.busy) { box.replaceChildren(h('p', { class: 'hint' }, '考えています…（数十秒かかることがあります）')); return; }
  if (ai.error) {
    box.replaceChildren(ai.error.code === 'cancelled' ? '' : h('p', { class: 'status error' }, ai.error.message));
    return;
  }
  const r = ai.result;
  if (!r) { box.replaceChildren(); return; }
  const v = r.validation;
  const b = v.breakdown;
  const skills = Object.entries(r.character.skills)
    .map(([id, p]) => `${skillDef(state.rules, r.character, id)?.name ?? id} ${skillValue(state.rules, r.character, id) ?? '—'}（${p}pt）`);
  const names = (list, map) => list.map((e) => {
    const def = map.get(e.id);
    const opt = def.options?.find((o) => o.id === e.option)?.label;
    return `${def.name}${e.level !== undefined && def.costPerLevel ? ` Lv${e.level}` : ''}${opt ? `（${opt}）` : ''}${e.detail ? `：${e.detail}` : ''}`;
  });
  const a = r.character.attributes;
  box.replaceChildren(h('div', { class: 'proposal' },
    h('b', {}, `配分案（使用 ${b.spent} / ${b.total}pt）`),
    r.rationale ? h('p', { class: 'rationale' }, r.rationale) : null,
    h('ul', {},
      h('li', {}, `能力値：筋力${a.st} 敏捷${a.dx} 知力${a.iq} 体力${a.ht}`),
      h('li', {}, `技能：${skills.join('、') || 'なし'}`),
      h('li', {}, `特徴・欠点：${names(r.character.traits, state.rules.traits).join('、') || 'なし'}`),
      h('li', {}, `転生技能：${names(r.character.reincarnation, state.rules.reincarnation).join('、') || 'なし'}`),
    ),
    v.errors.length ? h('ul', { class: 'issues' }, v.errors.map((e) => h('li', { class: 'error' }, e))) : h('p', { class: 'hint' }, '作成ルール上の問題はありません。'),
    r.dropped.length ? h('p', { class: 'hint' }, `定義にないため除いたもの：${r.dropped.join('、')}`) : null,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: applyProposal }, 'この案を反映する'),
      v.errors.length ? h('button', { class: 'btn', type: 'button', onclick: () => suggest({ fixFrom: { raw: r.raw, errors: v.errors } }) }, '問題を直してもらう') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => suggest({ fresh: true }) }, '別の案'),
      h('button', { class: 'btn', type: 'button', onclick: () => { state.ai.result = null; renderProposal(); } }, '閉じる'),
    ),
  ));
}

function applyProposal() {
  const c = state.ai.result.character;
  for (const k of ['attributes', 'derivedBought', 'skills', 'traits', 'reincarnation', 'customSkills']) state.ch[k] = structuredClone(c[k]);
  state.ai.result = null;
  renderProposal();
  commit();
  setStatus('配分案を反映しました。各タブで調整できます。');
}

// ---------- 保存・読み込み ----------

function renderLibrary() {
  const box = $('#library');
  if (!state.library.length) {
    box.replaceChildren(h('p', { class: 'empty' }, 'まだ保存したキャラクターはありません。「保存」を押すとここに並びます。'));
    return;
  }
  box.replaceChildren(...state.library.map((ch) => {
    const del = h('button', { class: 'btn small', type: 'button' }, '削除');
    del.addEventListener('click', () => twoStep(`del-${ch.id}`, del, '削除', '本当に削除', async () => {
      try {
        await state.store.characters.remove(ch.id);
        if (state.ch.id === ch.id) state.ch.id = null;
        setStatus(`「${ch.name || '名前なし'}」を削除しました。`);
      } catch (e) { setStatus(`削除できませんでした：${e.message ?? e.code}`, true); }
    }));
    const when = ch.updatedAt ? new Date(ch.updatedAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
    return h('div', { class: 'lib-item' },
      h('div', { class: 'who' }, h('b', {}, ch.name || '名前なし'), h('span', {}, `${(ch.concept || '').slice(0, 40)} ／ ${when}`)),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => loadCharacter(ch) }, '開く'),
        del),
    );
  }));
}

function loadCharacter(ch, { sample = false } = {}) {
  state.ch = normalize(structuredClone(ch));
  state.isSample = sample;
  $('#f-name').value = state.ch.name;
  $('#f-concept').value = state.ch.concept;
  $('#sample-notice').hidden = !sample;
  state.ai = { busy: false, ctl: null, result: null, error: null };
  renderProposal();
  commit();
  if (!sample) setStatus(`「${state.ch.name || '名前なし'}」を開きました。`);
}

async function save() {
  const btn = $('#btn-save');
  btn.disabled = true;
  try {
    const wasSample = state.isSample;
    const toSave = structuredClone(state.ch);
    if (wasSample) toSave.id = null;
    const saved = await state.store.characters.save(toSave);
    state.ch.id = saved.id;
    state.isSample = false;
    $('#sample-notice').hidden = true;
    saveDraft();
    const errs = evaluate().errors.length;
    const where = state.store.kind === 'account' ? 'あなたのアカウントに' : 'この端末に';
    setStatus(`${where}保存しました。${errs ? `作成ルール上の問題が ${errs}件 残っています。` : ''}`);
  } catch (e) {
    setStatus(`保存できませんでした：${e.message ?? e.code ?? e}`, true);
  } finally {
    btn.disabled = false;
  }
}

function syncJson() {
  const ta = $('#f-json');
  if (document.activeElement !== ta) ta.value = JSON.stringify(state.ch, null, 2);
}

// ---------- 起動 ----------

function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null'); } catch { return null; }
}

async function boot() {
  try {
    const { data, rules } = await loadRules();
    state.data = data;
    state.rules = rules;
  } catch (e) {
    setStatus(`ルールデータを読み込めませんでした：${e.message}`, true);
    return;
  }
  $('#rules-version').textContent = state.data.core.rulesVersion;

  const draft = readDraft();
  if (draft?.ch) {
    loadCharacter(draft.ch, { sample: !!draft.isSample });
  } else {
    try {
      const sample = await (await fetch(SAMPLE_URL)).json();
      loadCharacter({ ...sample, id: null }, { sample: true });
    } catch {
      loadCharacter(blankCharacter());
    }
  }

  // 入力欄
  $('#f-name').addEventListener('input', (e) => { state.ch.name = e.target.value; commit({ panel: false }); });
  $('#f-concept').addEventListener('input', (e) => { state.ch.concept = e.target.value; saveDraft(); syncJson(); });
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => { state.tab = t.dataset.tab; renderPanel(); });
  $('#btn-suggest').addEventListener('click', () => suggest());
  $('#btn-stop').addEventListener('click', () => state.ai.ctl?.abort());
  $('#btn-save').addEventListener('click', save);
  $('#btn-dismiss-sample').addEventListener('click', () => { state.isSample = false; $('#sample-notice').hidden = true; saveDraft(); });
  const newBtn = $('#btn-new');
  newBtn.addEventListener('click', () => twoStep('new', newBtn, '新規作成', '白紙にする', () => {
    loadCharacter(blankCharacter());
    setStatus('白紙のキャラクターを作りました。');
  }));
  const libBtn = $('#btn-library');
  libBtn.addEventListener('click', () => {
    const sec = $('#library-sec');
    sec.hidden = !sec.hidden;
    libBtn.setAttribute('aria-expanded', String(!sec.hidden));
  });
  $('#btn-copy').addEventListener('click', async () => {
    const ta = $('#f-json');
    ta.value = JSON.stringify(state.ch, null, 2);
    try { await navigator.clipboard.writeText(ta.value); setStatus('JSONをコピーしました。'); } catch { ta.select(); setStatus('選択した状態にしました。コピーしてください。'); }
  });
  $('#btn-import').addEventListener('click', () => {
    try {
      const obj = JSON.parse($('#f-json').value);
      if (!obj?.attributes) throw new Error('キャラクターのJSONではありません');
      loadCharacter(obj);
    } catch (e) { setStatus(`読み込めませんでした：${e.message}`, true); }
  });

  // 保存先とAI（どちらも無くても画面は使える）
  const [store, gm] = await Promise.all([createStore(), createGm()]);
  state.store = store;
  state.gm = gm;
  const chip = $('#storage-chip');
  chip.className = `chip ${store.kind}`;
  chip.textContent = store.kind === 'account' ? '保存先：あなたのアカウント' : '保存先：この端末のみ';
  chip.title = store.kind === 'account'
    ? 'claude.ai のあなた専用の領域に保存します。他の参加者からは見えません。'
    : 'このブラウザにだけ保存します。別の端末からは開けません。';
  store.characters.watch(
    (list) => { state.library = list; renderLibrary(); $('#btn-library').textContent = `保存済み（${list.length}）`; },
    (st) => {
      if (st.error) setStatus('保存済みの一覧を読み込めませんでした。', true);
      else if (st.stale && !state.library.length) $('#library').replaceChildren(h('p', { class: 'empty' }, '保存先にまだつながりません。しばらくすると表示されます。'));
    },
  );
  if (!gm.available) hideAi('AIの配分案は claude.ai 上でこのページを開いたときに使えます。手動での作成はそのままできます。');
  renderProposal();
}

boot();
