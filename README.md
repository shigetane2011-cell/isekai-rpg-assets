# 異世界TRPG（AI GM）

AIがGMを務めるTRPG。プレイヤーはWebページ上に自然言語で行動を書き、AIがそれを解釈して判定を宣言し、描写する。ダイスや数値の計算はプログラムが行う。claude.aiのArtifact上で動かし、APIキーは使わない。

ルールは、ポイントを割り振って能力値・技能・特徴を獲得し、3d6の下方判定で行為を解決する方式（GURPSのようなポイント制から着想した独自ルール）。

## 設計書

- [全体構成](docs/architecture.md)：層の分け方、使うArtifactの機能、共有方法、手番、PVPの公平性
- [ルール仕様](docs/rules.md)：判定、キャラクター作成、転生技能、戦闘、魔法、成長、PVP
- [データ形式](docs/data-schema.md)：ルールデータ、キャラクター、シナリオ、セッションの形式
- [AI GMの取り決め](docs/ai-gm.md)：AIに渡すもの、返させる形式、コードによる検証

## 画面

- `character-creator.html`：キャラクター作成画面「転生者登録票」。ポイント計算と作成ルールの検証、設定文からのAI配分案、保管。claude.ai のArtifactとして公開すると、AI配分案とアカウントへの保管が使える。ローカルで開くとAIは使えず、保管は端末内になる。

ローカルで確認するときは、リポジトリ直下で静的サーバーを立てて開く（例：`python3 -m http.server` で `http://localhost:8000/character-creator.html`）。

## データとコード

- `data/rules/`：技能75種、特徴71種、転生技能14種、装備36種、基本定数
- `engine/`：判定（`dice.mjs`）とポイント計算・キャラクター検証（`points.mjs`）
- `app/`：画面のコード。保存先とAI呼び出しは `app/adapters/` だけが扱う（将来のサーバー移行に備えた境界）
- `scenarios/`：個別シナリオ（後から追加する）
- `tools/validate.mjs`：データの整合性点検（`node tools/validate.mjs`）
