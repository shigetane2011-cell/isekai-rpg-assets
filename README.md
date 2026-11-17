# 異世界TRPG（AI GM）

AIがGMを務めるTRPG。プレイヤーはWebページ上に自然言語で行動を書き、AIがそれを解釈して判定を宣言し、描写する。ダイスや数値の計算はプログラムが行う。claude.aiのArtifact上で動かし、APIキーは使わない。

ルールは、ポイントを割り振って能力値・技能・特徴を獲得し、3d6の下方判定で行為を解決する方式（GURPSのようなポイント制から着想した独自ルール）。

## 設計書

- [全体構成](docs/architecture.md)：層の分け方、使うArtifactの機能、共有方法、手番、PVPの公平性
- [ルール仕様](docs/rules.md)：判定、キャラクター作成、転生技能、戦闘、魔法、成長、PVP
- [データ形式](docs/data-schema.md)：ルールデータ、キャラクター、シナリオ、セッションの形式
- [AI GMの取り決め](docs/ai-gm.md)：AIに渡すもの、返させる形式、コードによる検証

## データとコード

- `data/rules/`：技能75種、特徴71種、転生技能14種、装備36種、基本定数
- `engine/`：判定（`dice.mjs`）とポイント計算・キャラクター検証（`points.mjs`）
- `scenarios/`：個別シナリオ（後から追加する）
- `tools/validate.mjs`：データの整合性点検（`node tools/validate.mjs`）
