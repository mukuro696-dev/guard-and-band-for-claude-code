// 変異試験: 判定器をわざと壊した版で test/battery.mjs が落ちることを確かめる。
// 実行: node test/mutate.mjs  （test/mut/ に一時コピーを作り、終わったら消す。本体は触らない）
// 「検出」＝束が最後まで走り、失敗例（✗）を 1 件以上出して終了コード 1 で終わったこと（読み込みエラー・クラッシュは検出に数えない）。
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = new URL("../", import.meta.url).pathname;
const SRC = readFileSync(`${ROOT}hooks/guard-a.mjs`, "utf8");
const MUT = `${ROOT}test/mut/`;

// [名前, 置換前（本体に 1 回だけ現れる文字列）, 置換後]
const MUTANTS = [
  // ---- 第2ラウンドまでの 10 本（置換位置だけ今の本体に合わせた） ----
  ["A1(R2) checkout の実在確認を外す", "    ctx.existChecks.push({ path: p.startsWith(\"/\") ? p : joinPath(b, p), name: p, label: \"git checkout <path>\", where, note: NOTE });", "    void p;"],
  ["A2(R2) -c の変数を単一引用以外でも通す（旧挙動）", "    if (code.exp) {\n      // 二重引用でも", "    if (code.exp && !code.q) {\n      // 二重引用でも"],
  ["A3(R2) ヒアドキュメント本文の $( ) を拾わない", "        h.tok.word.subs.push(...extractSubs(h.tok.body.split(\"\\\\\\n\").join(\"\")));", "        void 0;"],
  ["A3(R2) ${ } の中を拾わない", "      cur.subs.push(...extractSubs(inner));\n      if (/^[A-Za-z_]", "      if (/^[A-Za-z_]"],
  ["B1(R2) oneLine を旧正規表現へ戻す", "  const cut = s.length > max * 4 ? s.slice(0, max * 4) : s;\n  const t = cut.split(\"\\n\").map((l) => l.trim()).join(\" ⏎ \");", "  const cut = s;\n  const t = s.replace(/\\s*\\n\\s*/g, \" ⏎ \");"],
  ["B3(R2) 起動子越しを見ない", "function launcherRest(cmd, args, depth, ctx, at) {\n", "function launcherRest(cmd, args, depth, ctx, at) {\n  return null;\n"],
  ["B4(R2) scratchpad の親の保護を外す", "    if (rest.length <= 3) {", "    if (false) {"],
  ["B5(R2) 文字列の rm を起動呼び出し無しでも数える", "if (s !== null && (isPwsh || SPAWN.test(code))) {", "if (s !== null) {"],
  ["B6(R2) 長オプションの接頭辞を解かない", "  const table = GIT_LONG[sub];\n", "  const table = undefined;\n"],
  ["fail-open(R2): stat の失敗を全部『無い』扱い", "    if (/^(ENOENT|ENOTDIR)$/.test(code) || /\\b(ENOENT|ENOTDIR)\\b/.test(msg)) {", "    if (true) {"],
  // ---- 第3ラウンド ----
  ["A1 代入の判定を引用なしに限る（旧挙動）", "    if (ASSIGN.test(x.lead)) {\n      const name = x.lead", "    if (!x.q && ASSIGN.test(x.lead)) {\n      const name = x.lead"],
  ["A2 ( … ) > f も空にする扱い（旧挙動）", "  if (trunc !== undefined && !closerOnly && truncatesOnly(w, seg)) {", "  if (trunc !== undefined && truncatesOnly(w, seg)) {"],
  ["A2 cat /dev/null > f を通す", "    return rest.every((a) => a.v === \"/dev/null\");", "    return false;"],
  ["A3 フラグだけで止める（旧挙動）", "    } else if (destrName(head.v) || scriptDanger(base(head.v))) {", "    } else if (args.some((a) => FLAG_DESTR.test(a.v)) || destrName(head.v) || scriptDanger(base(head.v))) {"],
  ["A3 変数のコマンド名の後ろを読まない（$SUDO rm）", "  } else if (maybePrefix && args.length > 0) {", "  } else if (false) {"],
  ["A4 場所を探す置換も止める（旧挙動）", "      } else if (!locatorHead(head, args)) {", "      } else if (true) {"],
  ["A4 eval の環境設定ツールも止める（旧挙動）", "    if (args.length === 1 && args[0].subs.length === 1 && onlyExpansion(args[0]) && envSetup(args[0].subs[0])) {", "    if (false) {"],
  ["S1 排他の設定を surfaces の後へ戻す（旧挙動）", "    holding = true;\n    let answer;\n    try {\n      const surfaces = await $.session.surfaces();", "    const surfaces0 = await $.session.surfaces();\n    holding = true;\n    let answer;\n    try {\n      const surfaces = surfaces0;"],
  ["C1 二重引用内の \\+改行を残す", "          if (nx === \"\\n\") {\n            i += 2;\n            continue;\n          }\n          if (nx === \"$\"", "          if (nx === \"$\""],
  ["C1 $\\+改行( を $( と読まない", "function skipLC(text, j) {\n", "function skipLC(text, j) {\n  return j;\n"],
  ["C2 \\r を区切りに戻す", "    if (c === \" \" || c === \"\\t\") {\n      flush();", "    if (c === \" \" || c === \"\\t\" || c === \"\\r\") {\n      flush();"],
  ["C3 コマンド名の glob を見ない", "  if (head.glob && head.v !== \"[\"", "  if (false && head.glob && head.v !== \"[\""],
  ["C4 checkout の pathspec（glob・変数・:・./）を見ない", "  const odd = posW.filter((a) => (a.exp && !refGenerator(a) && !detach) || a.glob", "  const odd = posW.filter((a) => false && a.glob"],
  ["C4 $'…' を復号しない", "      quoted(ansiDecode(body));", "      quoted(body);"],
  ["C5 --help を対象つきでも通す（旧挙動）", "  if (unknownLong.length === 0 && targets.length === 0 && flags.some((f) => !f.exp && (f.v === \"--help\" || f.v === \"--version\"))) {", "  if (flags.some((f) => !f.exp && (f.v === \"--help\" || f.v === \"--version\"))) {"],
  ["C6 /dev/stdin・- を標準入力と読まない", "  if (script !== null && (script.v === \"-\" || script.v === \"/dev/stdin\" || script.v === \"/dev/fd/0\")) {", "  if (false) {"],
  ["C6 bash -- の後を標準入力と読まない", "    k += 1; // bash -- script ／ bash --（スクリプト無し＝標準入力）", "    void 0;"],
  ["C6 <( ) をシェルに渡す形を見ない", "    if (script.subs.length > 0 && /^[<>]\\(/.test(script.v)) {\n      return add(ctx, { label: `${cmd} <( … )`, where: at, notes: [\"プロセス置換の出力をシェルが実行する＝中身を測れない\"] });", "    if (false) {\n      return;"],
  ["C6 スクリプト名が変数だけでも通す", "    if (onlyExpansion(script)) {\n      return add(ctx, { label: `${cmd} ${script.v}`", "    if (false) {\n      return add(ctx, { label: `${cmd} ${script.v}`"],
  ["I1 -c の直後をコードと決め打ち（旧挙動）", "function shCodeIndex(args, k) {\n", "function shCodeIndex(args, k) {\n  return k + 1 < args.length ? k + 1 : -1;\n"],
  ["I4 git のサブコマンドの変数を見ない", "  if (subW.exp) {\n    return add(ctx, { label: \"git のサブコマンドが変数\"", "  if (false) {\n    return add(ctx, { label: \"git のサブコマンドが変数\""],
  ["I4 git の引数の変数を見ない", "    if (hidden.length > 0) {", "    if (false) {"],
  ["I5 git の設定値（alias・core.sshCommand 等）を読まない", "function gitConfigValue(key, val, w, aliases, depth, ctx, at) {\n", "function gitConfigValue(key, val, w, aliases, depth, ctx, at) {\n  return;\n"],
  ["I5 値が命令になる環境変数（GIT_EDITOR=）を読まない", "      if (CMD_ENV.has(name)) {\n        const val", "      if (false) {\n        const val"],
  ["I5 restore --pathspec-from-file を見ない", "    if (has(\"--pathspec-from-file\") || rest.some((a) => a.startsWith(\"--pathspec-from-file=\"))) {\n      key(\"restore", "    if (false) {\n      key(\"restore"],
  ["I6 find -exec の後ろを 1 語しか見ない（旧挙動）", "    const inner = args.slice(k + 1, e).map(", "    const inner = args.slice(k + 1, Math.min(e, k + 2)).map("],
  ["I7 command/builtin/nohup の -- を外さない", "        w.shift(); // command -- rm・builtin -- rm・nohup -- rm", "        void 0;"],
  ["I7 watch を読まない", "      if (!execMode) {\n        if (w.length > 0) walk(wordsText(w), depth + 1, ctx, nest(where, \"watch\"));", "      if (!execMode) {\n        if (false) walk(wordsText(w), depth + 1, ctx, nest(where, \"watch\"));"],
  ["I7 script -qc を -c と読まない", "        if ((/^-[a-zA-Z]*c$/.test(o) || o === \"--command\") && w.length > 0) {", "        if ((o === \"-c\" || o === \"--command\") && w.length > 0) {"],
  ["I8 インタプリタのコードが変数だけでも通す", "    if (onlyExpansion(c.w)) {", "    if (false) {"],
  ["I8 パイプで流したコードを見ない", "  if (seg.piped && codes.length === 0 && !module && (script === null || script.v === \"-\")) {", "  if (false) {"],
  ["I8 awk の system() を読まない", "function awkRule(cmd, args, depth, ctx, at) {\n", "function awkRule(cmd, args, depth, ctx, at) {\n  return;\n"],
  ["I8 sed の e を見ない", "function sedExec(s) {\n", "function sedExec(s) {\n  return false;\n"],
  ["I8 pwsh -enc を見ない", "    if (isPwsh && PWSH_ENC.test(o)) {", "    if (false) {"],
  ["C1' docker exec の中を読まない", "    return inside(args.slice(k + 1), `${cmd} exec ${v[k] ?? \"\"}`.trim());", "    return;"],
  ["C1' kubectl exec の中を読まない", "    if (words.length > 0) {\n      withNote(ctx, \"Pod の中で実行される\",", "    if (false) {\n      withNote(ctx, \"Pod の中で実行される\","],
  ["C1'' cd 先を基準にしない", "      ctx.cwd = cdTarget(cmd, args, ctx);", "      void 0;"],
  ["S2 他のセッションの作業物も通す", "    if (rest[2] !== own) {", "    if (false) {"],
  ["名前規則 マイグレーションの巻き戻しを見ない", "    const down = args.find((a) => MIGRATE_DOWN.test(a.v));", "    const down = undefined;"],
  ["名前規則 rsync --delete-missing-args を見ない", "/^--(del|delete|delete-[a-z-]+|remove-source-files)$/", "/^--(del|delete|delete-[a-z]+|remove-source-files)$/"],
  ["固定語 terraform destroy を見ない", "    if (pos.length > 0 && (pos[0].v === \"destroy\" ||", "    if (false && (pos[0].v === \"destroy\" ||"],
  ["固定語 DB の DROP を見ない", "    const hit = texts.find((t) => DB_DROP.test(t));", "    const hit = undefined;"],
  ["変数追跡 代入の確かさを見ない（&& の鎖・if の中も確実扱い）", "  if (prev === \"\" || prev === \";\" || prev === \"\\n\" || prev === \"(\") return \"global\";", "  return \"global\";"],
  ["変数追跡 2 回以上代入される名前も追う", "  if (mode === null || val === null || ctx.unstable.has(name)", "  if (mode === null || val === null"],
  ["変数追跡 算術展開・(( ))・nameref の代入を見ない", "    if (t.v.includes(\"$((\")) return null; // $(( S=1 )) は代入しうる", "    void 0;"],
  ["xargs -I の入力位置を見ない（末尾に足す旧挙動）", "  if (repl !== null && repl !== \"\" && inner.some((a) => a.v === repl)) {", "  if (false) {"],
  ["case のパターンをコマンドとして読む（旧挙動）", "    if (seg.pattern) {\n      continue; // case のパターンはコマンドではない\n    }", "    void 0;"],
  // ---- rm -f 単一相対ファイルの緩和（2026-10-13）: 条件を 1 つずつ外す ----
  ["RMF 単一: 対象 1 個の条件を外す", "  if (bare && targets.length === 1 && softFlags(fv)", "  if (bare && softFlags(fv)"],
  ["RMF フラグ: -f/-v/-i/--force 以外も通す", "function softFlags(fv) {\n", "function softFlags(fv) {\n  return true;\n"],
  ["RMF 文字どおり: 変数・置換・glob・~・$'…' の条件を丸ごと外す", "function literalArg(a) {\n", "function literalArg(a) {\n  return true;\n"],
  ["RMF 文字どおり: 引用内の glob 文字・$・`・~ を見ない", " && a.subs.length === 0 && !/[*?[\\]{}~$`\\\\\\x00-\\x1f]/.test(a.v) && ", " && a.subs.length === 0 && "],
  ["RMF 文字どおり: $'…'（ANSI-C）を見ない", "  return !a.exp && !a.glob && !a.tilde && !a.ansi && a.subs.length === 0", "  return !a.exp && !a.glob && !a.tilde && a.subs.length === 0"],
  ["RMF 危険名: 危険名リスト（先頭ドット含む）を見ない", " && !t.v.includes(\"..\") && dangerOf(t) === null;", " && !t.v.includes(\"..\");"],
  ["RMF ..: パスの .. を見ない", " && !t.v.startsWith(\"-\") && !t.v.includes(\"..\") && dangerOf", " && !t.v.startsWith(\"-\") && dangerOf"],
  ["RMF 絶対パス: / で始まる対象も通す", "  return t.v !== \"\" && !t.v.startsWith(\"/\") && ", "  return t.v !== \"\" && "],
  ["RMF 空・- 始まり: 空の対象・- で始まる対象も通す", "  return t.v !== \"\" && !t.v.startsWith(\"/\") && !t.v.startsWith(\"-\") && ", "  return !t.v.startsWith(\"/\") && "],
  ["RMF cd: 同じ行の cd を見ない（緩和を戻さない）", "  if (ctx.cwdMoved) {\n    ctx.risks.push(...ctx.softRm);", "  if (false) {\n    ctx.risks.push(...ctx.softRm);"],
  ["RMF cd: cd・pushd・popd を作業フォルダの移動と数えない", "    ctx.cwdMoved = true; // 行のどこかで作業フォルダが動く", "    void 0; // 行のどこかで作業フォルダが動く"],
  ["RMF cd: 名前が測れないコマンド・source を移動と数えない", "  if (head.exp || cmd === \"source\" || cmd === \".\") {\n    ctx.cwdMoved = true;", "  if (false) {\n    ctx.cwdMoved = true;"],
  ["RMF 前置き: sudo・env・nohup・VAR=値 などの前置きを見ない", "rmRule(args, sudo, ctx, at, depth === 0 && !prefixed)", "rmRule(args, sudo, ctx, at, depth === 0)"],
  ["RMF 入れ子: sh -c・$( )・xargs・find -exec の中でも通す", "rmRule(args, sudo, ctx, at, depth === 0 && !prefixed)", "rmRule(args, sudo, ctx, at, !prefixed)"],
  ["RMF 逆向き: 緩和そのものを外す（旧挙動）", "rmRule(args, sudo, ctx, at, depth === 0 && !prefixed)", "rmRule(args, sudo, ctx, at, false)"],
  // ---- 第4ラウンド（2026-10-13）: 保守化・補強を 1 つずつ外す ----
  ["R4-1 追跡中止の語（declare・read・eval・trap・set など）を見ない", "    if (VAR_ABORT.has(t.v)) return null;", "    void 0;"],
  // R4-1 の「IFS が語として出たら追わない」（for IFS in 等）は変異を置かない: 引用なしの $S を解決しない（R4-3）に包含され、
  // 判定に現れない（同値変異。IFS が効くのは単語分割＝引用なしの展開だけで、それはもう解決しない）。二重の防御として残す。
  ["R4-1 printf -v・-vNAME を見ない", "        if (toks[j].v.startsWith(\"-v\") || (j === k + 1 && toks[j].v.startsWith(\"$\"))) return null;", "        void 0;"],
  ["R4-1 export のオプション・展開の引数を見ない", "        if (/^[-+]/.test(toks[j].v) || toks[j].v.startsWith(\"$\")) return null;", "        void 0;"],
  ["R4-1 コマンド位置の . を見ない", "      if (t.v === \".\") return null; // . file（source）", "      void 0;"],
  ["R4-1 測れないコマンド名の後も変数を追う", "    ctx.dropVars = true; // 名前が測れない", "    void 0; // 名前が測れない"],
  ["R4-2 記録しない変数（PWD・_・HOME 等）も記録する", "  if (noTrack(name)) {", "  if (false) {"],
  ["R4-3 引用なしの $S も解決する（旧挙動）", "  if (!assign && w.refs.some((r) => !r.q)) return null;", "  void 0;"],
  ["R4-5 置換・$'…' を含む語も解決する", "  if (w.subs.length > 0 || w.ansi) return null;", "  void 0;"],
  ["R4-6 引用・エスケープ・展開の左辺を見ない", "    if ((cmdPos || exportSeg) && ASSIGN_LIKE.test(t.v) && !ASSIGN.test(t.lead)) return null;", "    void 0;"],
  ["R4-8 I8 引用なしの $B も ref として通す", "  if (w.refs.some((r) => !r.q)) return false;", "  void 0;"],
  ["R4-F1 rm の長オプション接頭辞を解かない", "    if (full === null) unknownLong.push(f.v);\n    else flags[k] = { ...f, v: full };", "    void full;"],
  ["R4-F1 曖昧・未知の長オプションでも止めない", "    if (full === null) unknownLong.push(f.v);", "    if (false) unknownLong.push(f.v);"],
  ["R4-F6 添字内のコマンド置換を見ない", "function subscriptRule(cmd, args, depth, ctx, at) {\n", "function subscriptRule(cmd, args, depth, ctx, at) {\n  return;\n"],
  ["R4-F6 ${!r} と添字の置換を見ない", "  if (toks.some((t) => t.t === \"w\" && t.v.includes(\"${!\"))", "  if (false && toks.some((t) => t.t === \"w\" && t.v.includes(\"${!\"))"],
  ["R4-I9 cd を ;・||・&・分岐・ループでも追う（旧挙動）", "function cdTracked(seg) {\n", "function cdTracked(seg) {\n  return !seg.piped;\n"],
  ["R4-I9 && の鎖の外でも cd 先を使う", "      if (ctx.cwdChain !== null && ctx.cwdChain !== chain) {", "      if (false) {"],
  ["R4-I9 eval の中の cd を見ない", "    ctx.cwd = null; // eval の中の cd は", "    void 0; // eval の中の cd は"],
  ["R4-I9 trap の中の cd を見ない", "        ctx.cwd = null; // trap の中の cd", "        void 0; // trap の中の cd"],
  ["R4-I9 CDPATH を見ない", "  if (!v.startsWith(\"/\") && ctx.cdpath) return null;", "  void 0;"],
  ["R4-I7 鍵・状態ファイル（id_*・known_hosts・tfstate 等）を危険名にしない", "    else if (/^id_|^known_hosts|", "    else if (/^$^|^known_hosts|"],
  ["R4-I7 tfstate・wallet.dat を危険名にしない", "|tfstate|^wallet\\.dat$|", "|^$^|"],
  ["R4-I7 *.pfx・*.jks を危険名にしない", "p12|pfx|jks|keystore", "p12|keystore"],
  ["R4-I6 extglob・! を緩和の対象外にしない", " && !/[!()]/.test(a.v);", ";"],
  // ---- 第5ラウンド（2026-10-13）: B1〜B4・B7 の修正を 1 つずつ外す ----
  ["R5-B1 &&・||・| の直後の改行を新しい行頭にする（旧挙動）", "      if (t.v === \"\\n\" && seg.words.length === 0 && seg.redirs.length === 0 && CONT_OPS.has(seg.prev)) {", "      if (false) {"],
  ["R5-B1 続きの行の cd も追う", " && seg.ctl === 0 && seg.contNL !== true && seg.prev !== \"||\"", " && seg.ctl === 0 && seg.prev !== \"||\""],
  ["R5-B2 case のパターン語で制御構造を数える（旧挙動）", "    for (const x of seg.pattern ? [] : seg.words) {", "    for (const x of seg.words) {"],
  ["R5-B3 引用つきの \"$x\" を埋めない（旧挙動）", "known.value.trim() !== \"\" && (!head.refs[0].q || PLAIN_VALUE.test(known.value));", "known.value.trim() !== \"\" && !head.refs[0].q;"],
  ["R5-B3 引用つきの値の確定条件（空白・glob・展開なし）を外す", "const PLAIN_VALUE = /^[A-Za-z0-9._/+@%:,=-]+$/;", "const PLAIN_VALUE = /^/;"],
  ["R5-B4 値が追えない変数頭のコード引数を読まない（旧挙動）", "    unknownHeadRule(head, args, seg, depth, ctx, at);", "    void 0;"],
  ["R5-B4 変数頭の -delete を見ない", "  if (args.some((a) => !a.q && a.v === \"-delete\")) {", "  if (false) {"],
  ["R5-B4 変数頭のコードの削除呼び出しを見ない", "  const hit = codeDanger(name, code.v, false, at);\n  if (hit !== null) add(ctx, hit);", "  void name;"],
  ["R5-B4 変数頭の -c をシェルとして読まない", "    walk(code.v, depth + 1, ctx, nest(at, `${head.v} -c`));", "    void 0;"],
  ["R5-B4 推測の読みの『コマンド名が測れない』所見を捨てない", ".filter((r) => !SPECULATIVE_NOISE.has(r.label));", ".filter(() => true);"],
  ["R5-B4 変数頭の -m のモジュール名を見ない", "    if (scriptDanger(code.v)) add(ctx, { label: `${head.v} -m ${code.v}`", "    if (false) add(ctx, { label: `${head.v} -m ${code.v}`"],
  ["R5-B7 nocorrect・- を外さない", "    if (!x.q && (v === \"nocorrect\" || v === \"-\")) {", "    if (false) {"],
  ["R5-B7 repeat N を外さない", "    if (!x.q && v === \"repeat\" && w.length > 2) {", "    if (false) {"],
  ["R5-B7 =cmd を cmd と読まない", "    if (!x.q && !x.exp && /^=[A-Za-z0-9_.+/-]/.test(v)) {", "    if (false) {"],
];

// R4-4 は離れた 2 か所（$( )・( ) へ鎖の代入を持ち込まない／鎖番号を ctx 全体で単調増加）を同時に戻す。
// どちらか片方だけでも衝突は起きない（二重の防御）ので、片方だけ外す変異は「検出されない」のが正しい。
{
  const A = "    ctx.vars = inherit ? globalVars(saved[1]) : new Map();";
  const B = "      ctx.seq += 1;\n      chain = ctx.seq;";
  const block = SRC.slice(SRC.indexOf(A), SRC.indexOf(B) + B.length);
  MUTANTS.push(["R4-4 鎖番号: 単調増加をやめ、$( )・( ) へ鎖の代入を持ち込む（旧挙動）", block, block.replace("globalVars(saved[1])", "new Map(saved[1])").replace("      ctx.vars = globalVars(ctx.vars);\n", "").replace(B, "      chain += 1;")]);
}

const results = [];
for (const [name, before, after] of MUTANTS) {
  const n = SRC.split(before).length - 1;
  if (n !== 1) {
    results.push([name, `置換位置が ${n} 件（変異を作れない）`]);
    continue;
  }
  rmSync(MUT, { recursive: true, force: true });
  mkdirSync(`${MUT}hooks`, { recursive: true });
  mkdirSync(`${MUT}test`, { recursive: true });
  writeFileSync(`${MUT}hooks/guard-a.mjs`, SRC.replace(before, () => after));
  for (const f of ["battery.mjs", "reviewer_cases.mjs", "round3_cases.mjs", "round4_cases.mjs", "round5_cases.mjs"]) {
    copyFileSync(`${ROOT}test/${f}`, `${MUT}test/${f}`);
  }
  let out;
  let failed = false;
  try {
    out = execFileSync(process.execPath, [`${MUT}test/battery.mjs`], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    failed = true;
    out = String(e.stdout ?? "") + (e.signal ? ` [${e.signal}]` : "");
  }
  const ran = /^性質/m.test(out) && /失敗例:/.test(out);
  const summary = out.split("\n").filter((l) => /^(HOLD側|雑音側|Reviewer  |第3R|第4R|第5R|rm -f緩和|性質)/.test(l)).map((l) => l.replace(/\s+/g, " ")).join(" ｜ ");
  const firstFail = (out.split("\n").find((l) => l.includes("✗")) ?? "").trim().slice(0, 120);
  const detected = failed && ran && firstFail !== "";
  results.push([name, detected ? `検出: 例 ${firstFail}` : `**未検出**（${ran ? "束は走った" : "束が走っていない"}）: ${summary}`]);
}
rmSync(MUT, { recursive: true, force: true });
for (const [n, r] of results) console.log(`| ${n} | ${r} |`);
const missed = results.filter(([, r]) => !r.startsWith("検出")).length;
console.log(`検出 ${results.length - missed}/${results.length}`);
process.exitCode = missed > 0 ? 1 : 0;
