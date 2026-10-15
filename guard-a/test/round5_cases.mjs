// 第5ラウンド（2026-10-13）: 独立レビューの B1〜B4・B7 と、通ってよい対照。
// [コマンド, 由来] の配列。T は自分のセッション（sess-1）の配下＝/tmp 例外が効く場所。⏎ は改行に置き換えて使う。
// 期待: HOLD5 は全部止まる／PASS5 は全部通る。
const T = "/private/tmp/claude-1000/proj/sess-1";
const nl = (s) => s.replace(/⏎/g, "\n");

export const HOLD5 = [
  // ---- B1: && / || / | の直後の改行は同じ演算子の続き（代入・cd を「行頭＝確実」にしない） ----
  [`false &&⏎S=${T}/x; rm -rf "$S"`, "B1 && 改行の代入（実行されない→$S は環境値）"],
  [`true ||⏎S=${T}/x; rm -rf "$S"`, "B1 || 改行の代入（実行されない）"],
  [`false && # c⏎S=${T}/x; rm -rf "$S"`, "B1 && コメント 改行"],
  [`true ||⏎⏎S=${T}/x; rm -rf "$S"`, "B1 || 空行を挟む"],
  [`echo a |⏎S=${T}/x; rm -rf "$S"`, "B1 | 改行（代入はパイプの中＝外へ出ない）"],
  ["true ||⏎cd nowhere && git checkout file.txt", "B1 || 改行の cd（true なら cd されず root の file.txt を捨てる）"],
  ["false &&⏎cd nowhere && git checkout file.txt", "B1 && 改行の cd（続きの行の cd は追わない・保守側）"],
  // ---- B2: case のパターン語（fi / } / done）を制御構造と数えない ----
  [`case x in fi) :; S=${T}/x;; esac; rm -rf "$S"`, "B2 fi) パターン"],
  [`case x in done) :; S=${T}/x;; esac; rm -rf "$S"`, "B2 done) パターン"],
  [`case x in }) :; S=${T}/x;; esac; rm -rf "$S"`, "B2 }) パターン"],
  [`case x in x) :;; fi) :; S=${T}/x;; esac; rm -rf "$S"`, "B2 2 番目の分岐の fi)"],
  // ---- B3: 同じ行で確定した値の引用つき "$x" を埋める ----
  ['x=rm; "$x" -rf ~', "B3 \"$x\""],
  ['x=/bin/rm; "$x" -rf ~', "B3 \"$x\"（絶対パス）"],
  ['x=rm; "${x}" -rf ~', "B3 \"${x}\""],
  ['x=rm; command "$x" -rf ~', "B3 command \"$x\""],
  ['x=rm; exec "$x" -rf ~', "B3 exec \"$x\""],
  ['x=rm; nohup "$x" -rf ~', "B3 nohup \"$x\""],
  ['x=rm; sudo "$x" -rf ~', "B3 sudo \"$x\""],
  ['x=rm; env "$x" -rf ~', "B3 env \"$x\""],
  ["x=bash; \"$x\" -c 'rm -rf ~'", "B3 \"$x\" -c（x=bash）"],
  ['x=git; "$x" push -f origin main', "B3 \"$x\" push -f（x=git）"],
  // ---- B4: 値が追えない変数頭の -c / -e / -E / --eval / -m と -delete ----
  ["$P -c 'import shutil; shutil.rmtree(\"x\")'", "B4 $P -c（python の削除）"],
  ["$SH -c 'rm -rf ~'", "B4 $SH -c（シェルとして読む）"],
  ["$Q -c 'rm -rf ~'", "B4 $Q -c"],
  ["$NODE -e 'require(\"fs\").rmSync(\"x\",{recursive:true})'", "B4 $NODE -e"],
  ["\"$PY\" -c \"import shutil; shutil.rmtree('build')\"", "B4 \"$PY\" -c（引用つき頭）"],
  ["\"$N\" -e 'require(\"fs\").rmSync(\"x\",{recursive:true})'", "B4 \"$N\" -e"],
  ["$P -c 'import os; os.system(\"rm -rf build\")'", "B4 $P -c（外部コマンドで rm）"],
  ["$PL -E 'unlink \"x\"'", "B4 $PL -E（perl の unlink）"],
  ["$N --eval 'fs.rmSync(\"x\")'", "B4 $N --eval"],
  ["$PY -m rollback_db", "B4 $PY -m（名前が巻き戻し系のモジュール）"],
  ["$F . -delete", "B4 $F . -delete（find 型）"],
  ["$F . -name '*.tmp' -delete", "B4 $F … -delete"],
  // ---- B7: zsh の前置き ----
  ["=rm -rf ~", "B7 =rm（/bin/rm）"],
  ["=git reset --hard", "B7 =git"],
  ["nocorrect rm -rf ~", "B7 nocorrect"],
  ["nocorrect =rm -rf ~", "B7 nocorrect =rm"],
  ["repeat 1 rm -rf ~", "B7 repeat N"],
  ["repeat 3 do rm -rf build; done", "B7 repeat N do … done"],
  ["- rm -rf ~", "B7 - （login の argv[0]）"],
].map(([c, w]) => [nl(c), w]);

export const PASS5 = [
  // ---- B1: 正常形 ----
  [`S=${T}/x &&⏎rm -rf "$S"`, "B1 正常: 代入 && 改行 rm（同じ鎖）"],
  [`S=${T}/x⏎rm -rf "$S"`, "B1 正常: 改行区切り"],
  ["cd sub &&⏎git checkout main", "B1 正常: cd && 改行 checkout <無い名前>"],
  ["true &&⏎echo ok", "B1 正常: && 改行"],
  ["git status |⏎head -5", "B1 正常: | 改行"],
  // ---- B2: 正常形（パターン語で計数が崩れない＝esac の後は確実に戻る） ----
  [`case $a in fi) echo x;; esac; S=${T}/x; rm -rf "$S"`, "B2 正常: esac の後の代入（旧: 計数が -1 になり誤止め）"],
  ["case x in x) S=1;; esac; echo ok", "B2 正常: case の中の代入（rm なし）"],
  // ---- Reviewer 報告「通ってよい対照」 ----
  [`S=${T}/x; echo $(S=/etc); rm -rf "$S"`, "対照: $( ) 内の代入は外へ出ない"],
  [`S=${T}/x; U="$S"; rm -rf "$U" "$S"`, "対照: 2 対象とも own"],
  [`S=${T}/x; caller >/dev/null; rm -rf "$S"`, "対照: caller"],
  [`S=${T}/x; compgen -v S >/dev/null; rm -rf "$S"`, "対照: compgen"],
  [`S=${T}/x; enable -n cd; rm -rf "$S"`, "対照: enable"],
  [`S=${T}/x; sudo -n true; rm -rf "$S"`, "対照: 無関係な sudo"],
  [`S=${T}/x; U=$S/y; rm -rf "$U"`, "対照: 連鎖＋/y"],
  // ---- B3: 正常形 ----
  [`x=rm; "$x" -rf ${T}/x`, "B3 正常: \"$x\" で自分の scratchpad を消す"],
  ["x='rm -rf'; \"$x\" ~", "B3 正常: 空白入りの値は 1 語のコマンド（not found・埋めない）"],
  ['x=ls; "$x" -la', "B3 正常: \"$x\"＝ls"],
  // ---- B4: 正常形（実セッションの $PY -c / $N -e は止めない） ----
  ["$PY -c 'print(1)'", "B4 正常: $PY -c"],
  ["$N -e 'console.log(1)'", "B4 正常: $N -e"],
  ["$A shell ls", "B4 正常: $A shell（adb）"],
  ["$PY script.py", "B4 正常: $PY script.py"],
  ['$PY -c "$CODE"', "B4 正常: コードも変数＝読めない（従来どおり）"],
  ["$PY -m pytest -q", "B4 正常: $PY -m pytest"],
  ["\"$PY\" -c \"from PIL import Image; print(Image.__version__)\"", "B4 正常: 実セッションの形"],
  ["for p in a b; do $p -c \"import sys; print(sys.version_info[:2])\"; done", "B4 正常: python のコードをシェルとして読んだ時の [:2] は捨てる"],
  // ---- B7: 正常形 ----
  ["nocorrect ls -la", "B7 正常: nocorrect ls"],
  ["=ls -la", "B7 正常: =ls"],
  ["repeat 3 echo hi", "B7 正常: repeat"],
  ["- ls", "B7 正常: - ls"],
  ["=rm -f out.txt", "B7 正常: =rm -f 単一相対（rm -f 緩和と同じ）"],
].map(([c, w]) => [nl(c), w]);
