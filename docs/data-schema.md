# データ形式（v0.1.0）

データは4つの層に分かれる。上の層ほど変更が少なく、下の層は上の層を参照するだけで、上の層を書き換えない。

| 層 | 置き場所 | 変更の頻度 |
|---|---|---|
| エンジン | `engine/*.mjs` | まれ |
| ルールデータ | `data/rules/*.json` | ときどき（技能の追加、コストの調整） |
| シナリオ | `scenarios/<id>/scenario.json` | シナリオを足すたび |
| セッション | Artifactの共有データベース | プレイ中ずっと |

すべてのデータは `node tools/validate.mjs` で点検できる。点検に通らないものは公開しない。

## 1. ルールデータ

### core.json

判定、作成の上限、派生値、技能のコスト、戦闘、魔法、回復、PVPの定数を持つ。各項目の意味は `rules.md` を参照。`rulesVersion` を上げたら、セッションは開始時の版に固定されるので、進行中の卓には影響しない。

### skills.json

```json
{ "id": "observation", "name": "観察", "attr": "per", "difficulty": "average",
  "default": true, "tags": ["survival", "covert"], "description": "..." }
```

| 項目 | 内容 |
|---|---|
| `id` | 英小文字と `_`。変えると参照が壊れるので変えない |
| `attr` | `st` `dx` `iq` `ht` `will` `per` |
| `difficulty` | `easy` `average` `hard` |
| `default` | 未修得で使えるか。難技能は必ず `false` |
| `requires` | 習得に必要な特徴のid（魔法技能は `magery`） |
| `tags` | 分類。`tags` に定義したものだけ使える。特徴の「分類まとめて+1」や天賦の才が参照する |

### traits.json と reincarnation.json

```json
{ "id": "charisma", "name": "カリスマ", "kind": "advantage",
  "costPerLevel": 5, "minLevel": 1, "maxLevel": 4,
  "effects": [{ "type": "skill", "target": "leadership", "value": 1, "perLevel": true }],
  "description": "..." }
```

`kind` は `advantage`（有利）、`disadvantage`（欠点）、`reincarnation`（転生技能）のいずれか。コストは次の2形のどちらか一方で書く。

- **固定またはレベル制**：コストは `cost + costPerLevel × レベル`。固定なら `cost` だけを書く。魔法適性のように「基本5pt＋1レベル10pt、レベル0から」というものは、`cost` と `costPerLevel` の両方を書き、`minLevel: 0` にする。
- **選択式**：`options: [{ id, label, cost }]`。

欠点のコストは負の数で書く。内容を自分で書く必要があるもの（誓い、宿敵など）には `requiresDetail: true` をつける。他の特徴が前提のもの（魔力過多には魔法適性が要る）には `requiresTrait` を書く。

#### 効果の種類

効果はエンジンが知っている種類だけ使える。新しい種類が必要になったら、まずエンジンと点検スクリプトに追加する。

| type | 働き | 処理する側 |
|---|---|---|
| `skill` | 特定の技能に常に±値 | コード |
| `tag` | 分類の技能すべてに常に±値 | コード |
| `derived` | 派生値（回避・受け・反応など）に±値 | コード |
| `derivedMultiplier` | 派生値を倍にする（魔力過多） | コード |
| `chosenSkill` | 本人が選んだ技能1つに±値（`detail` に技能id） | コード |
| `skillCostTier` | 選んだ分類の技能の難度を軽くする（天賦の才） | コード |
| `customSkill` | 独自の技能を持ち込む（前世の知識） | コード |
| `resource` | 所持金などの倍率 | コード |
| `reroll` | 振り直しの回数 | コード（回数を数える） |
| `growthBonus` | 成長ポイントの増加 | コード |
| `unlock` | 技能群を習得可能にする | コード |
| `situational` | 条件（`applies`）に当てはまる判定で±値 | **AIが該当を判断**し、数値はコードが足す |
| `urge` | 決まった場面（`when`）で衝動判定を求める | **AIが場面を判断**し、判定はコードが振る |
| `companion` | 同行するNPC（契約精霊） | AIがNPCとして動かす |
| `narrative` | 数値を持たない効果 | AIが描写で扱う |

`perLevel: true` なら値にレベルを掛ける。選択式の特徴は `valueByOption` で選択肢ごとに値を書ける。

### equipment.json

武器（`weapon`）、鎧（`armor`）、盾（`shield`）、道具（`gear`）、消耗品（`consumable`）。武器は `skill`・`damage`（ダイス式）・`reach`（届く距離帯）を持ち、鎧は `dr`（防護点）と回避・隠密への修正を持つ。

### backgrounds.json

シナリオが使う背景画像の一覧。シナリオは画像ファイル名ではなく `id` で指定する。画像の置き場所が変わっても、ここを直すだけで済む。

## 2. キャラクター

見本は `docs/examples/character-sample.json`。

```json
{
  "id": "...", "name": "ユウト", "concept": "元社畜の薬師", "rulesVersion": "0.1.0",
  "pointsTotal": 120,
  "attributes": { "st": 9, "dx": 11, "iq": 13, "ht": 11 },
  "derivedBought": { "hp": 0, "mp": 0, "will": 0, "per": 1 },
  "skills": { "herbalism": 8, "observation": 4 },
  "customSkills": [{ "id": "pk_pharmacology", "name": "薬学（前世）", "attr": "iq", "difficulty": "hard", "default": false, "tags": ["knowledge"], "source": "past_knowledge" }],
  "traits": [{ "id": "acute_smell", "level": 2 }, { "id": "outsider", "option": "stranger" }],
  "reincarnation": [{ "id": "past_knowledge", "detail": "薬学", "customSkillId": "pk_pharmacology" }],
  "equipment": [{ "id": "dagger", "qty": 1, "equipped": true }],
  "money": 200,
  "state": { "hp": null, "mp": null, "conditions": [] }
}
```

`skills` には技能値ではなく**使ったポイント**を書く。技能値は毎回コードが計算する（`engine/points.mjs` の `skillValue`）。こうしておけば、ルールデータのコストを調整したときにキャラクターを書き直さずに済む。`state` のHP・MPが `null` なら最大値として扱う。

成長でキャラクターを更新するときは、更新前のキャラクターを `previous` として `validateCharacter` に渡す。転生技能が新しく増えていたらエラーになる。

## 3. シナリオ

見本は `docs/examples/scenario-minimal.json`（形式確認用で、遊ぶためのものではない）。シナリオは「台本」ではなく、**事実と状況の集まり**として書く。プレイヤーは必ず想定外の行動をとるので、分岐を書き込むのではなく、場所・人物・手がかり・条件を用意し、その範囲でAIに即興させる。

### 全体

| 項目 | 必須 | 内容 |
|---|---|---|
| `formatVersion` | ○ | この形式の版（現在は1） |
| `id` / `version` / `title` | ○ | `id` は英小文字。`version` は修正のたびに上げる |
| `summary` / `authors` | | 紹介文、作者 |
| `rulesVersion` | ○ | 前提とするルールの版 |
| `players` | ○ | `{ min, max }` |
| `startingPoints` | | 初期ポイント（省略時は120） |
| `pvp` | ○ | `{ mode: "off" \| "zones" \| "always", zones?: [場所id] }` |
| `gmGuide` | | AIへのシナリオ固有の指示（雰囲気、題材、禁止事項） |
| `ruleExtensions` | | このシナリオだけの技能・特徴・転生技能・装備。idは `x_` で始める |
| `flags` | | 進行状態 `{ id, type, initial, description, eventOnly? }` |
| `start` | ○ | `{ locationId, time, introduction }` |
| `locations` | ○ | 場所の一覧 |
| `npcs` | | NPC・魔物の一覧 |
| `items` | | シナリオ固有のアイテム（装備データと同じ形） |
| `events` | | 条件で起きる出来事 |
| `endings` | ○ | 結末（1つ以上） |

`eventOnly: true` のフラグは出来事によってしか変わらず、AIは描写の効果として変更できない。物語の要所（封印が解けた、など）を守るために使う。

### 場所

```json
{
  "id": "barn", "name": "物置小屋", "background": "dungeon",
  "public": "PCに見える描写",
  "secret": "GMだけが知ること",
  "npcs": ["giant_rat"],
  "clues": [{ "id": "...", "text": "...", "discover": { "skill": "observation", "modifier": 0 } }],
  "hazards": [{ "id": "...", "text": "...", "check": { "skill": "acrobatics", "modifier": 2 }, "onFail": [{ "damage": "1d3", "to": "actor", "armor": false }] }],
  "exits": [{ "to": "farmyard", "label": "庭に戻る", "condition": null, "hidden": false }]
}
```

手がかりの `discover` が `null` なら、その場所を調べれば判定なしで見つかる。`hidden: true` の出口は、見つけるまでPCに示さない。

### NPC・魔物

能力は2通りで書ける。主要なNPCは、キャラクターと同じ形式の `sheet` で書く（点検スクリプトがポイントの整合性まで確かめる）。雑魚の魔物は、簡易な `statblock` で書く。

```json
"statblock": {
  "hp": 6, "dr": 0, "speed": 6, "dodge": 9, "will": 8, "per": 12,
  "attacks": [{ "name": "噛みつき", "skill": 11, "damage": "1d3", "reach": ["engaged"] }],
  "skills": { "stealth": 13 }, "tags": ["animal"]
}
```

どちらの場合も、`public`（見た目）、`secret`（秘密）、`motivation`（動機）、`knows`（知っていること）、`attitude`（初期態度）を持たせる。AIがNPCを演じるときの拠り所になる。

### 条件と効果の書き方

条件は次の組み合わせで書く。

```json
{ "flag": "barn_unlocked", "eq": true }
{ "all": [ 条件, 条件 ] }
{ "any": [ 条件, 条件 ] }
{ "not": 条件 }
```

効果は配列で書く。`setFlag` / `value`、`moveParty`、`giveItem` / `to`、`takeItem`、`spawnNpc` / `at`、`npcAttitude` / `value`、`damage` / `to` / `armor`、`money` がある。

### 出来事

```json
{ "id": "rat_flees", "trigger": { "type": "npcDefeated", "npc": "giant_rat" }, "once": true,
  "gmText": "AIへの説明", "effects": [{ "setFlag": "rat_driven_off", "value": true }] }
```

`trigger.type` は `enterLocation`（場所に入った）、`flag`（条件を満たした）、`npcDefeated`（NPCを倒した）、`time`（時刻）、`round`（経過ターン数）。発火の判定はコードが行い、`gmText` をAIに渡して描写させる。

### 結末

`{ id, title, condition, text, rewards }`。`rewards` には所持金と成長ポイントの目安を書ける。PVPのあるシナリオでは、結末を一人勝ち・共闘・全滅のように複数用意しておく。

## 4. セッション（共有データベース）

セッションはArtifactの共有データベース（`db` 機能）に置く。パスと中身は次のとおり。

| パス | 中身 |
|---|---|
| `sessions/{sid}` | シナリオidと版、ルールの版、参加者、モード（探索・戦闘・PVP）、現在地、フラグ、手番、あらすじ、PVP設定 |
| `sessions/{sid}/chars/{uid}` | そのプレイヤーのキャラクター（上の形式）と現在の状態 |
| `sessions/{sid}/npcs/{npcId}` | NPCの現在の状態（HP、態度、位置、生死） |
| `sessions/{sid}/log/{entryId}` | ログ1件：時刻、行動者、行動文、裁定、出目、結果、描写、公開範囲、捨てた効果 |
| `sessions/{sid}/sealed/{round}_{uid}` | PVPの封印提出：最初はハッシュだけ、開示後に本文とsalt |
| `sessions/{sid}/lock` | 解決処理の手番ロック（db の `acquire` によるリース） |
| `data/users/{uid}/characters/{cid}` | 作成中・保管中のキャラクター（本人だけが読める） |

ログは1件ずつ別の文書にする（1文書の上限は256KiB）。並べ替えは時刻順で行う。セッション文書には、シナリオを開始した時点の `scenarioVersion` と `rulesVersion` を記録する。シナリオやルールが更新されても、進行中のセッションはその版のデータで遊び続ける。
