# progress-band

Claude Code の mod。プロンプト上の帯（AbovePrompt）に、作業進捗と文脈使用量を 1 行で出す。
決定的コードのみ（モデル・ネットワーク・ファイル書込・`$.process` なし）。観測は fail-open（deny も書き換えもしない・常に next の結果を返す）。

## 表示（テーマ色キー。ダーク/ライトに自動追従）
| 状態 | 例 | 色 |
|---|---|---|
| タスクあり | `▓▓▓░░░░░ 3/7 ・進行1 ｜ 文脈 24%` | バーと n/m=`claude`・`・進行n` `｜` `文脈`=dim |
| 全完了 | `✓ 7/7 完了 ｜ 文脈 24%` | `success` |
| タスク無し | `文脈 ▓▓░░░░░░ 24%` | バーと %=70% 未満 `claude`／70% 以上 `warning` |
| 85% 以上 | 末尾に `（要 compact 検討）` | `warning`＋bold |
何も無い時、`e.props.hasSurvey` の時は帯を出さない（`next(e)`）。

## 観測するもの
- `tool.call`: TaskCreate / TaskUpdate / TodoWrite / update_plan（正規表現 `(^|__)update_plan$`）。
- **メインエージェントの呼び出しのみ数える**: `e.agentId` 付き（サブエージェント／チームメイト）は記録しない。共有タスクを別 agent が作る場合も数えない。
- 通った呼び出しだけ数える（deny / isError / `result.success:false` は除外）。
- 系統ごとにキーを分ける: TaskCreate/Update=`t:<id>`、TodoWrite/update_plan（全置換）=`s:<n>`。未知 id の TaskUpdate は記録しない。
- 文脈使用量: `session.measure` の `e.context`（percent、無ければ tokens/window）。context は在るが値が無い（compact 直後）なら null＝帯から消す。`turn.complete` では取らない（同値の重複のため）。
- `session.end`: reason が `clear` / `resume` で件数と使用量をリセット。

## 信頼と中身の確認
mod は利用者の権限で動きます。`claude plugin validate ./progress-band` の出力で確認できる内容: hooks は `tool.call`（TaskCreate・TaskUpdate・TodoWrite・`update_plan`）・`session.measure`・`session.end`・`ui.render{AbovePrompt}`、calls は `$.state.get/set`・`$.ui.resolve` だけです（`$.process`・`$.fs.write`・`$.http` は呼びません）。

## 導入と撤去
```
/plugin install progress-band@progress-append-mods
/plugin uninstall progress-band@progress-append-mods
```
単独で完結します（他の mod に依存しません）。

## 確かめ手順
```
# PATH の古い claude（2.1.287 未満）では validate が失敗する。Desktop 同梱版または 2.1.287 以上を使う（対応は 2.1.287 以上を前提）
CLAUDE=<claude 2.1.287 以上>
$CLAUDE plugin validate ./progress-band
$CLAUDE plugin test ./progress-band
tsc -p <型定義を置いた tsconfig>   # tsconfig.json は .claude-plugin/types を include（エンジンが読込時に置く）
```
実描画は Desktop で TodoWrite 等を走らせて確認する。

## 未確認点
- `session.measure` が各応答の後に context 変化として届くこと（`turn.complete` の usage 取得は重複なので外した。届かない場合は復活させる）。
- `session.end` の reason `clear` / `resume` の実セッションでの発火（型定義の記述のみ・テストは $.session.end を直接発火）。
- update_plan の入力形（`plan` 配列の `status`）は built-in 型表に無く、型定義未確認。
- `safe` 相当の guard を register 層で外した変異は、register のテストでは検出されない（例外を起こす入力を engine 越しに作れないため。guard 単体のテストで検出）。
