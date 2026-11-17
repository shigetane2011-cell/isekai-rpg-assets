# シナリオ

個別のシナリオを置く場所。シナリオごとにフォルダを作り、その中に `scenario.json` を置く。

```
scenarios/
  <シナリオid>/
    scenario.json
```

書き方は `docs/data-schema.md` の「3. シナリオ」を参照。形式の見本は `docs/examples/scenario-minimal.json` にある。追加・修正したら、必ず次のコマンドで点検する。

```
node tools/validate.mjs
```

修正するたびに `version` を上げる。進行中のセッションは開始した時点の版で遊び続けるので、古い版を壊さずに直せる。
