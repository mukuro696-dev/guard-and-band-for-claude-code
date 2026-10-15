# guard-a（削除・巻き戻しの影響範囲ガード）

Claude Code の mod（function hooks のプラグイン）。Claude が Bash ツールで「消す・巻き戻す・強制上書きする」コマンドを実行しようとした時に、**コマンド文字列から静的に判定**して保留し、確認ダイアログで「止める（実行しない）／実行する」を聞きます。

> **画面の文言について**: 確認ダイアログや理由の文言は日本語です（English UI texts are not provided; the dialog and deny reasons are in Japanese）。

## まず知っておくこと（限界）

- **補助であって防御ではありません。** 判定は「危ない形の一覧」（denylist）で、**知らない形は通ります**。サンドボックスでも権限システムでもありません。確実に止めたい操作は Claude Code の permission rules（deny）で守ってください（トップ README の「推奨設定」。Bash の deny も前方一致なので別形は抜けます。確実な境界は sandbox と組み合わせます）。
- **拒否の理由は回避を誘いえます。** 止めた理由は Claude に返るため、「スクリプトを書いて実行する」など別の道を選ぶことがあります。スクリプトの中身や Edit/Write・MCP ツールは見ません。
- **「fail-closed」の意味は狭いです。** 判定・保留の途中で例外が起きたら止める、という意味です。判定器が「測れない」と認識できた信号（変数・置換・glob など）だけを止めます。
- Bash ツールの呼び出しだけを見ます。
- 画面が無い実行（`claude -p`・SDK）では、待たずに理由つきで止めます。

動作確認の状況: 判定器と、偽の `$` を使ったフック本体は自動試験で確認しています。実画面での確認ダイアログは、作者の環境で常用して動作を確認していますが、環境やバージョンの差で挙動が違う可能性があります。

## 何を止めるか（主なもの）

| 種類 | 例 |
|---|---|
| rm | `rm -r/-R/-rf`、対象が複数・glob・ブレース展開・変数や置換を含む、危険名（`.env`・`.git`・`node_modules`・`*.sqlite`・鍵や `session`/`auth`/`token` を含む名前）、`~`・`/`・`.`。長オプションの接頭辞（`--rec` など）も正式名に直して判定 |
| 他の削除 | `rimraf`・`del-cli`・`unlink`・`shred`・`truncate`・`dd of=`・`mkfs`・`diskutil erase*`・`crontab -r`・中身を書かないリダイレクト（`> file`） |
| docker / kubectl 等 | `docker volume rm/prune`・`system prune`・`compose down -v`・`kubectl delete`・`terraform destroy`・`gh repo delete`・DB CLI の `DROP TABLE/DATABASE` |
| git | `reset --hard`・`clean`・強制 push（`-f`・`--force-with-lease`・`+ref`・`--delete`・`:branch`）・`checkout -- <path>`/`checkout .`・実在パスへの `checkout <name>`・`restore <path>`・`switch --discard-changes`・`branch -D`・`stash drop/clear`・`reflog expire`・`gc --prune` など |
| まとめて消す | `find -delete`・`find -exec …`・`xargs rm`・`rsync --delete*` |
| 入れ子 | `sh -c '…'`・`eval`・`$( )`・ヒアドキュメント・`ssh host '…'`・`npx`/`uv run` 等の起動子の中身も同じ規則で読む |
| 測れないもの | 変数だけのコマンド名（`$CMD`）・中身が変数の `bash -c "$X"`・`curl … \| sh` |
| 名前で止める | 名前に `rollback`・`wipe`・`purge`・`nuke`・`teardown`・`destroy` を含むスクリプト（例: `rollback.sh`）やタスク名、マイグレーションの巻き戻し（`rollback`・`reset`・`drop` など） |

## 止めないもの

通常の `ls`・`git status/diff/commit`・通常の `git push`・ブランチ名への `git checkout`・単一の相対ファイルへの `rm`／`rm -f out.txt`（条件あり・下記）・`echo 'rm -rf x'` のような文字列・ビルド掃除（`npm run clean`）・履歴の書き換え（`git rebase`・`--amend`）など。

**単一の相対ファイルへの `rm -f` は通します**（損害が小さく、git 管理下なら戻せるため）。次を全部満たす時だけです: 対象が 1 個の文字どおりの相対パス／フラグは `-f`・`-v`・`-i` の組合せのみ／glob・変数・置換・`~` なし／危険名でない／`..` や `/` 始まりでない／`sudo` 等の前置きなし／同じ行に `cd` がない。

**`/tmp` の定型掃除は通します**: 対象が全部確定した `/tmp/…`（または `/private/tmp/…`）の絶対パスで、親フォルダの実体が `/private/tmp` 配下と確かめられた時だけです。`/tmp/claude-<uid>` 配下は、**今のセッション自身**の scratchpad だけを通し、他のセッションの作業物・セッションのフォルダそのものは止めます。

## 信頼と中身の確認

mod は利用者の権限で動きます。`claude plugin validate ./guard-a` の `calls:` 行で、この mod が呼ぶ API を確認できます: `$.clock.after`・`$.fs.stat`・`$.session.id`・`$.session.surfaces`・`$.state.get/set`・`$.ui.ask`・`$.ui.toast`（`$.process`・`$.fs.write`・`$.http` は呼びません）。受けるイベントは `tool.call{tool=Bash}` だけです。

## 保留の動き

- 該当すると確認ダイアログ（AskUserQuestion）に、コマンド・検出した項目・対象・注意を出します。選択肢は「止める（実行しない）」「実行する」。
- 「実行する」だけが実行です。「止める」・自由回答・ダイアログを閉じた・**10 分無回答**・ターン中断はすべて止めます（deny。理由は Claude に返ります）。
- 確認待ちの間に別の該当コマンドが来たら、待たずに理由つきで止めます（ダイアログは 1 枚）。
- 同じ対象の削除の試みがセッション内で 2 回目なら、ダイアログに注意を足します。
- コマンドは書き換えません。止めるか、そのまま通すかだけです。

## 設計の原則

1. 決定的なコードだけ（LLM・ネットワーク・ファイル書込・環境変数参照なし）。
2. 承認前に外部コマンドを実行しない。使う host API は `$.fs.stat`・`$.session.id`・`$.session.surfaces`・`$.ui.ask`・`$.ui.toast`・`$.clock.after`・`$.state` だけ。
3. 例外が起きたら止める（`.catch` で deny）。
4. コマンドを黙って書き換えない。

## 既知の限界

- **知らない包み・起動子は通ります**（`pkexec`・`strace`・`screen -dm`・`tmux new`・`direnv exec`・`conda run` など）。
- **スクリプトの中身は読みません。** `python3 cleanup.py`・Makefile・npm scripts の中の `rm` は止められません（名前による停止のみ）。
- **インタプリタの中は呼び出しの形を正規表現で探すだけ**です。別名・文字列の組み立て・ライブラリ経由の削除は見えません。
- **難読化は追い切れません**（変数の連結・`printf -v`・エイリアス・関数定義・`base64 -d` の実行など）。
- システム管理や SQL の `DELETE FROM`（WHERE の有無を読まない）・`aws s3 rm`（`--recursive` なし）は止めません。
- 前のコマンドで `cd` した後の作業フォルダの違い、`CDPATH`、パスの途中のシンボリックリンクは確認できません。
- 誤止め（雑音）がありえます。`if … ; then cd X && …; fi` の中の `cd`、`bash -c "$X"` などです。
- 判定と実行の間の差し替え（TOCTOU）は守れません。`$.ui.ask` は AskUserQuestion を経由するため、別のプラグインが回答しうる点にも注意してください。
- zsh 固有の構文は一部（`nocorrect`・`noglob`・`repeat N`・先頭の `-`・`=cmd`）だけ対応です。`hash` や `alias` による名前の差し替えは見ません。

## 拡張する場所

「危険名」のリストは `hooks/guard-a.mjs` の `dangerOf` 関数にある正規表現です（隠しフォルダ名の候補: `.git`・`.env`・`.ssh`・`.aws` など）。自分の環境の設定フォルダ名（例: ツールの設定ディレクトリ）を止めたい時は、その正規表現の選択肢に名前を足してください。設定ファイルでの追加は未実装です。

## 試験

リポジトリのルートで、Node.js が入っていれば動きます。

```bash
node guard-a/test/battery.mjs   # 判定器・フック本体の試験束
node guard-a/test/mutate.mjs    # 判定器をわざと壊して、試験束が検出するか確かめる（test/mut/ に一時ファイルを書く）
claude plugin validate ./guard-a
```

- **PATH 上の古い claude（2.1.287 未満）では validate が失敗します。** Claude Code の Desktop 同梱版、または 2.1.287 以上を使ってください（対応は 2.1.287 以上を前提としています）。
- `battery.mjs` は実コマンドを走らせません（stat は偽物）。
- 1 セッションだけ試す: `claude --plugin-dir ./guard-a`

## ファイル

- `.claude-plugin/plugin.json` — マニフェスト
- `hooks/guard-a.mjs` — 本体（判定器 `classify`/`decide`・`dangerOf` など）
- `hooks/hooks.json` — フックモジュールの指定
- `types/index.d.ts` — `$.state` の型
- `test/battery.mjs` — 試験束。`test/reviewer_cases.mjs`・`round3〜5_cases.mjs` は 1 行ずつ理由つきの入力集
- `test/gen_reviewer_cases.mjs` — `reviewer_cases.mjs` を作った一度きりの生成スクリプト（入力元は公開物に無く、単体では実行できません）
- `test/mutate.mjs` — 変異試験

## インストール
```
/plugin install guard-a@progress-append-mods
```
