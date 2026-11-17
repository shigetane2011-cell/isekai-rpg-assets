// ルールデータを読み込む。ページと一緒に配信した JSON を、このファイルからの相対パスで取得する。
import { buildRules } from '../engine/points.mjs';

const FILES = {
  core: '../data/rules/core.json',
  skills: '../data/rules/skills.json',
  traits: '../data/rules/traits.json',
  reincarnation: '../data/rules/reincarnation.json',
  equipment: '../data/rules/equipment.json',
};

export async function loadRuleData() {
  const entries = await Promise.all(Object.entries(FILES).map(async ([key, rel]) => {
    const res = await fetch(new URL(rel, import.meta.url));
    if (!res.ok) throw new Error(`${rel} を読み込めませんでした（${res.status}）`);
    return [key, await res.json()];
  }));
  return Object.fromEntries(entries);
}

export async function loadRules() {
  const data = await loadRuleData();
  return { data, rules: buildRules(data) };
}
