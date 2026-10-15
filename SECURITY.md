# Security / セキュリティ

## 対象 / Scope
guard-a と progress-band（このリポジトリの 2 つの mod）。

## 前提 / What you should know
- **mod は利用者の権限で動き、サンドボックス外です。** ファイル・プロセス・ネットワークに触れうる仕組みの上で動きます。信頼できるものだけを導入してください。
- **guard-a は補助であって防御ではありません。** denylist 方式のため、知らない形は通ります。確実に止めたい操作は permission rules の deny と sandbox で守ってください。
- 対応は**ベストエフォート**です。応答時期や修正を保証しません。

## 報告 / Reporting
脆弱性・誤止め・見逃しは、GitHub の Issues で報告してください。**個人情報・機密・認証情報・実際のコマンド履歴は貼らないでください**（再現に必要な最小の文字列だけにしてください）。重大な内容で公開 Issue が不安な場合は、詳細を伏せて「連絡方法を相談したい」とだけ書いてください。

## サプライチェーン / Supply chain
- 導入前に取得したフォルダで `claude plugin validate <dir>` を実行し、`hooks:` と `calls:` を確認してください（この mod は `$.process`・`$.fs.write`・`$.http` を呼びません）。
- `/plugin marketplace add mukuro696-dev/progress-append-mods#<tag>` のようにタグ（`#ref`）を固定することを推奨します。
- リリースのタグと同梱の `CHECKSUMS.sha256`（全ファイルの SHA-256 一覧）を照合できます（例: `shasum -a 256 -c CHECKSUMS.sha256`）。署名は付けていません。

## English summary
Mods run with your permissions and outside the sandbox. guard-a is an aid, not a defense (denylist; unknown forms pass). Support is best-effort. Report issues via GitHub Issues without personal data or secrets. Inspect `claude plugin validate` output (`hooks:`/`calls:`), pin a tag with `#ref`, and compare files with `CHECKSUMS.sha256`.
