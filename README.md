# progress-append-mods

日本語 / [English](#english)

Claude Code 用の小さな自作 mod（プラグイン）集です。

| mod | 内容 |
|---|---|
| `guard-a` | Bash で「消す・巻き戻す・強制上書きする」コマンドを文字列から静的に判定し、確認ダイアログで止める。**補助であって防御ではない**（denylist 方式で、知らない形は通る）。詳細は `guard-a/README.md` |
| `progress-band` | タスク進捗とコンテキスト使用量(%)をプロンプト上の帯に 1 行で表示。トークン非消費・fail-open。詳細は `progress-band/README.md` |

## 対応バージョン
**Claude Code 2.1.287 以上を前提**としています（公式ドキュメントの記載は、ターミナル版 2.1.287 以上・Desktop 2.1.286 以上と、ページによって 1 違います。この配布物は安全側の 2.1.287 以上で書いています）。

## 導入
リポジトリのルートに `.claude-plugin/marketplace.json` があります。
```
/plugin marketplace add mukuro696-dev/progress-append-mods
/plugin install progress-band@progress-append-mods
/plugin install guard-a@progress-append-mods
```
`owner/repo` の後ろに `#ref` を付けてタグ等に固定することもできます。ローカルで試す場合: `claude plugin marketplace add <このリポジトリのパス>`。

### 導入前に中身を確認する
mod は**あなたの権限で動き**、ファイル・プロセス・ネットワークに触れうる作りで、サンドボックスの対象外です（信頼していないディレクトリでは trust 確認までは読み込まれません）。導入前に、取得したフォルダで `claude plugin validate <dir>` を実行し、`hooks:`（受けるイベント）と `calls:`（呼ぶ API）の行で中身を確認できます。この mod 群での出力の要約（validate の静的な検出結果）:

| mod | hooks | calls |
|---|---|---|
| guard-a | `tool.call{tool=Bash}`（gating・`.catch` つき） | `$.clock.after`・`$.fs.stat`・`$.session.id`・`$.session.surfaces`・`$.state.get/set`・`$.ui.ask`・`$.ui.toast` |
| progress-band | `tool.call`（TaskCreate・TaskUpdate・TodoWrite・`update_plan`）・`session.measure`・`session.end`・`ui.render{AbovePrompt}` | `$.state.get/set`・`$.ui.resolve` |

どちらも validate の calls に `$.process`・`$.fs.write`・`$.http` は現れません。

## 推奨設定
この mod 群に関する推奨です。

### 1. guard-a は「補助」。禁止したい操作は permission rules の deny で守る
`permissions.deny` は文字列の配列です（評価順は deny → ask → allow）。正規形はコマンドの後ろに「スペース＋`*`」です（末尾に限り `Bash(ls:*)` は `Bash(ls *)` と同義）。（書式は公式ドキュメントに合わせましたが、お使いの版で必ず確認してください。）
```json
{
  "permissions": {
    "deny": [
      "Bash(git push --force *)",
      "Bash(rm -rf *)",
      "Read(./.env)",
      "Read(./secrets/**)"
    ]
  }
}
```
限界（公式ドキュメントの記載による）:
- Bash のルールはコマンド文字列の前方一致です。`git -C . push`・`/bin/rm`・`bash -c '…'` といった別の形は一致しません。確実な境界が要るなら sandbox と組み合わせてください。
- `Read(./.env)` の deny は Edit/Write や Bash の `cat`/`sed` にも効きますが、Python/Node のスクリプトが自分でファイルを開くことは止まりません。

### 2. インストール範囲（scope）
| scope | 記録先 | 効く範囲 | コミット |
|---|---|---|---|
| user | `~/.claude/settings.json` の `enabledPlugins` | このマシンの全プロジェクト | 対象外 |
| project | `.claude/settings.json` | そのリポジトリの全員 | 必要 |
| local | `.claude/settings.local.json` | そのプロジェクトのみ | 対象外 |

優先順位は local > project > user です。ターミナル・Desktop のローカルセッション・VS Code 拡張は同じ settings を読むので、user で入れれば他でも有効です。クラウドセッションはローカルの設定を読みません。

- **guard-a**: local scope を推奨します（`claude plugin install guard-a@progress-append-mods --scope local`）。公式の仕様説明に基づく推奨で、作者の環境では guard-a を local で常用して確認済みです。誤止めが多いと感じたら、そのプロジェクトで撤去してください。
- **progress-band**: user scope を推奨します（全プロジェクトで文脈使用量が見えます）。公式の仕様説明に基づく推奨で、user scope での動作は未検証です。

### 3. progress-band の表示
Task 系ツール（TaskCreate/TaskUpdate・TodoWrite・update_plan）を使わないセッションでは、文脈使用量(%)のみを表示します。色はテーマ色で、ダーク/ライトに自動追従します。

### 4. 同時導入の注意
同じイベントを扱う別の mod（プロンプト上の帯を出すものなど）と併用すると、表示が競合することがあります。

### 5. 撤去と調査
```
/plugin uninstall guard-a@progress-append-mods
/plugin uninstall progress-band@progress-append-mods
/plugin marketplace remove progress-append-mods
```
問題が出た時は、Claude Code のデバッグ機能（`claude --debug`）の利用をまず検討してください（出力内容は未確認です）。

### 管理者の方へ（任意）
管理設定で、利用者の mod を止められます（`pluginConfigs` 内 `cc-plugin-sec-default@builtin` の `options.allowManagedModsOnly: true`）。組織の mod として配るには、管理設定でのディレクトリ配布が必要です。GitHub から入れたものは「利用者の mod」として扱われます。出典: https://code.claude.com/docs/en/plugins/mods/admin

参考（公式ドキュメント）: https://code.claude.com/docs/en/permissions ・ /settings ・ /plugins/install ・ /plugins/mods/overview

## セキュリティ
報告方法・限界・サプライチェーンの注意は [SECURITY.md](SECURITY.md) を参照してください。リリースのタグと `CHECKSUMS.sha256` を照合できます。

## 免責
- guard-a は事故を減らす補助です。画面の無い実行（`-p`・SDK）では待たずに止めます。確認ダイアログの文言は日本語です。
- 無保証（MIT）。使用は自己責任でお願いします。非公式プロジェクトで Anthropic とは無関係です。

## テスト
Node.js が必要です（リポジトリのルートで実行）。
```
node guard-a/test/battery.mjs
node guard-a/test/mutate.mjs        # 判定器をわざと壊して試験が検出するか確認（test/mut/ に一時ファイルを作り、終了時に消す）
claude plugin validate .            # marketplace.json
claude plugin validate ./guard-a
claude plugin validate ./progress-band
claude plugin test ./progress-band
```
**PATH 上の古い claude（2.1.287 未満）では validate が失敗します。** Claude Code の Desktop 同梱版、または 2.1.287 以上を使ってください。

## English
Small, self-made Claude Code mods (plugins).

- **guard-a** — statically classifies Bash commands that delete, rewind or force-overwrite things and asks for confirmation. **An aid, not a defense**: it is a denylist, unknown forms pass through, and it is neither a sandbox nor a permission system. Use Claude Code permission rules (deny) for anything that must be blocked. Dialog and deny-reason texts are in Japanese only.
- **progress-band** — shows task progress and context usage (%) in a one-line band above the prompt. No token cost, fail-open.

Requires Claude Code 2.1.287 or later (the official pages differ by one on the Desktop number; this repo assumes 2.1.287+). Per-mod READMEs are in Japanese.

Install: `/plugin marketplace add mukuro696-dev/progress-append-mods`, then `/plugin install progress-band@progress-append-mods`.
Recommended: keep guard-a as a helper and protect critical operations with `permissions.deny` (e.g. `Bash(git push --force *)`; Bash rules are prefix matches, so variants like `git -C . push` are not matched, and a sandbox is the firm boundary); install guard-a at local scope and progress-band at user scope. Mods run with your permissions and are outside the sandbox: inspect `hooks:`/`calls:` with `claude plugin validate <dir>` before installing (neither mod calls `$.process`, `$.fs.write` or `$.http`). Uninstall: `/plugin uninstall progress-band@progress-append-mods`.
Tests: `node guard-a/test/battery.mjs`, `node guard-a/test/mutate.mjs`, `claude plugin validate ./guard-a`, `claude plugin test ./progress-band`. Note: validate fails with a `claude` older than 2.1.287 on PATH; use the Desktop-bundled one.
License: MIT. Provided as is, no warranty; unofficial.
