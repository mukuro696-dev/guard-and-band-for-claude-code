// 第4ラウンド（2026-10-13）: 変数追跡の保守化・rm -f 緩和の補強・F1/F6/I8/I9 の試験束。
// [コマンド, 由来] の配列。T は自分のセッション（sess-1）の scratchpad 配下＝/tmp 例外が効く場所。
// 期待: HOLD4 は全部止まる／PASS4 は全部通る（「通すべき正常形」）。
const T = "/private/tmp/claude-1000/proj/sess-1";

// round4 の 22 形（control だけ PASS 期待）
export const R4A_HOLD = [
  ["rm --rec --forc src", "case4 F1 rm --rec"],
  [`local HOME=${T}/h; rm -rf "$HOME/proj"`, "case4 F2 local"],
  [`S=${T}/x; declare "S=$HOME"; rm -rf "$S"`, "case4 F3 declare"],
  [`readonly HOME; HOME=${T}/h; rm -rf "$HOME/proj"`, "case4 F4 readonly"],
  [`eval 'readonly S=$HOME'; S=${T}/x; rm -rf "$S"`, "case4 F4b eval"],
  [`PWD=${T}/x; cd ~/proj; rm -rf "$PWD"`, "case4 F5 PWD"],
  [`_=${T}/x; ls ~ >/dev/null; rm -rf "$_"`, "case4 F5 _"],
  ["unset 'a[$(rm -rf ~)]'", "case4 F6 unset sub"],
  [`trap 'S=$HOME' DEBUG; S=${T}/x; rm -rf "$S"`, "case4 F7 trap"],
  [`eval 'IFS=/'; S=${T}/x; rm -rf $S`, "case4 I2 IFS eval"],
  [`false && D=${T}/x; echo $(rm -rf "$D/y")`, "case4 I3 chain"],
  [`S=${T}/x; rm -rf "$S$(printf /../..)"`, "case4 I4 subst"],
  [`declare -g -n R=S; S=${T}/x; R=/Users/me/proj; rm -rf "$S"`, "case4 I5 nameref"],
  ["rm -f '!(keep.txt)'", "case4 I6 extglob"],
  ["rm -f id_ed25519", "case4 I7 id_ed25519"],
  ["rm -f server.pem", "case4 I7 pem"],
  ["rm -f terraform.tfstate", "case4 I7 tfstate"],
  ["rm -f credentials.json", "case4 I7 credentials"],
  ["git push -f origin $B", "case4 I8 empty ref"],
  [`cd ${T}/x || true; rm -rf build`, "case4 I9 cd||true"],
  [`cd ${T}/x; rm -rf build`, "case4 I9 cd;"],
];
export const R4A_PASS = [[`S=${T}/x; rm -rf "$S"`, "case4 control"]];

export const HOLD4 = [
  // ---- 1. 追跡中止の語（引用・\・builtin/command 前置きを問わない） ----
  [`S=${T}/x; \\declare "S=$HOME"; rm -rf "$S"`, "中止語: \\declare"],
  [`S=${T}/x; builtin read S < f; rm -rf "$S"`, "中止語: builtin read"],
  [`S=${T}/x; command eval 'S=$HOME'; rm -rf "$S"`, "中止語: command eval"],
  [`S=${T}/x; 'mapfile' S < f; rm -rf "$S"`, "中止語: 引用 mapfile"],
  [`S=${T}/x; unset S; rm -rf "$S/y"`, "中止語: unset（$S/y＝/y）"],
  [`S=${T}/x; let S=1; rm -rf "$S/y"`, "中止語: let"],
  [`S=${T}/x; source env.sh; rm -rf "$S"`, "中止語: source"],
  [`S=${T}/x; . ./env.sh; rm -rf "$S"`, "中止語: コマンド位置の ."],
  [`S=${T}/x; getopts ab S; rm -rf "$S"`, "中止語: getopts"],
  [`S=${T}/x; set -- a; rm -rf "$S"`, "中止語: set"],
  [`S=${T}/x; shopt -s extglob; rm -rf "$S"`, "中止語: shopt"],
  [`S=${T}/x; coproc cat; rm -rf "$S"`, "中止語: coproc"],
  [`S=${T}/x; typeset S=$HOME; rm -rf "$S"`, "中止語: typeset"],
  [`S=${T}/x; readonly S; rm -rf "$S"`, "中止語: readonly"],
  [`S=${T}/x; export -n S; rm -rf "$S"`, "中止語: export -n"],
  [`S=${T}/x; export $N; rm -rf "$S"`, "export の引数が展開（S=/ になりうる）"],
  [`S=${T}/x; printf -vS %s "$HOME"; rm -rf "$S"`, "中止語: printf -vNAME"],
  [`S=${T}/x; printf -v S %s ~; rm -rf "$S"`, "中止語: printf -v NAME"],
  [`S=${T}/x; printf $O S %s ~; rm -rf "$S"`, "printf の最初の引数が展開（-v かもしれない）"],
  [`S=${T}/x; select S in a; do :; done; rm -rf "$S"`, "中止語: select"],
  [`S=${T}/x; $C "S=$HOME"; rm -rf "$S"`, "コマンド名が変数（export でありうる）＝以降追わない"],
  [`S=${T}/x; "$D" -g "S=$HOME"; rm -rf "$S"`, "コマンド名が変数（引用・declare -g でありうる）＝以降追わない"],
  [`. ./env.sh; S=${T}/x; rm -rf "$S"`, "中止語: 先に . した行（読み込んだ側の trap・関数が後の代入を変えうる）"],
  ["for IFS in -; do :; done; c=rm-rf-x; $c", "IFS: for IFS in（変数を追わない。判定は「変数の中身だけの行」でも止まる＝二重）"],
  // ---- 2. 記録しない変数 ----
  [`HOME=${T}/h; rm -rf "$HOME/proj"`, "記録しない: HOME"],
  [`PWD=${T}/x; rm -rf "$PWD"`, "記録しない: PWD"],
  [`OLDPWD=${T}/x; cd ~/p && cd - && rm -rf "$OLDPWD"`, "記録しない: OLDPWD"],
  [`_=${T}/x; rm -rf "$_"`, "記録しない: _"],
  [`BASH_ALIASES=${T}/x; rm -rf "$BASH_ALIASES"`, "記録しない: BASH*"],
  [`EPOCHSECONDS=${T}/x; rm -rf "$EPOCHSECONDS"`, "記録しない: EPOCH*"],
  [`PATH=${T}/x; rm -rf "$PATH"`, "記録しない: PATH"],
  // ---- 3. 引用なしの $S は解決しない ----
  [`S=${T}/x; rm -rf $S`, "引用なし $S"],
  [`S=${T}/x; rm -rf $S/y`, "引用なし $S/y"],
  [`S=${T}/x; rm -rf \${S}`, "引用なし ${S}"],
  // ---- 4. 鎖番号（$( )・サブシェルへ鎖の代入を持ち込まない） ----
  [`false && D=${T}/x; echo "$(rm -rf "$D")"`, "鎖: $( ) の中（引用）"],
  [`false && D=${T}/x; ( rm -rf "$D/y" )`, "鎖: サブシェルの中"],
  [`false && D=${T}/x; echo \`rm -rf "$D/y"\``, "鎖: ` ` の中"],
  // ---- 5. 置換・ANSI-C を含む語 ----
  [`S=${T}/x; rm -rf "$S\`echo /..\`"`, "置換: ` `"],
  [`S=${T}/x; rm -rf "$S/$(cat n)"`, "置換: $( )"],
  ["cd $'nowhere' && git checkout file.txt", "cd 先が $'…'＝解決しない（基準不明で止める）"],
  // ---- 6. 引用・エスケープ・展開の左辺 ----
  [`S=${T}/x; export "S=$HOME"; rm -rf "$S"`, "左辺が引用（export）"],
  [`S=${T}/x; export S\\=$HOME; rm -rf "$S"`, "左辺がエスケープ（export）"],
  [`S=${T}/x; export $N=$HOME; rm -rf "$S"`, "左辺が展開（export）"],
  [`S=${T}/x; "S=$HOME"; rm -rf "$S"`, "コマンド位置の引用代入（意味を確定しない）"],
  // ---- 7. nameref ----
  [`\\declare -n R=S; S=${T}/x; R=/Users/me/proj; rm -rf "$S"`, "nameref: \\declare"],
  [`typeset -n R=S; S=${T}/x; R=/Users/me/proj; rm -rf "$S"`, "nameref: typeset"],
  [`f() { local -n R=S; }; S=${T}/x; rm -rf "$S"`, "nameref: local（関数）"],
  // ---- F1 rm の長オプション接頭辞 ----
  ["rm --recu src", "F1: --recu＝--recursive"],
  ["rm --rec -f build", "F1: --rec＝--recursive"],
  ["rm --frob x", "F1: 未知の長オプション"],
  ["rm --v x", "F1: 曖昧（--verbose/--version）"],
  ["rm --in=never --rec x", "F1: 値つきの接頭辞（--in=never）と --rec"],
  // ---- F6 添字内のコマンド置換 ----
  ["printf -v 'a[$(touch x)]' %s 1", "F6: printf -v の添字"],
  ["printf -v'a[$(rm -rf ~)]' %s 1", "F6: printf -vNAME の添字"],
  ["read 'a[`rm -rf ~`]' < f", "F6: read の添字（` `）"],
  ["[[ -v 'a[$(rm -rf ~)]' ]]", "F6: [[ -v ]]"],
  ["declare \"a[\\$(rm -rf ~)]=1\"", "F6: declare の添字"],
  ["let 'a[$(rm -rf ~)]=1'", "F6: let の添字"],
  ["builtin unset 'a[$(id)]'", "F6: builtin unset（中身が無害でも止める）"],
  ["r='a[$(rm -rf ~)]'; echo \"${!r}\"", "F6: ${!r} の先が添字"],
  // ---- I6 extglob・ヒストリ展開 ----
  ["rm -f '@(a|b)'", "I6: @( )"],
  ["rm -f 'x+(1)'", "I6: +( )"],
  ["rm -f 'a!b'", "I6: !"],
  ["rm -f \"!!\"", "I6: ヒストリ展開"],
  // ---- I7 危険名 ----
  ["rm -f ID_RSA", "I7: id_*（大文字）"],
  ["rm -f keys/id_rsa.pub", "I7: id_*（途中要素の下）"],
  ["rm -f known_hosts", "I7: known_hosts"],
  ["rm -f authorized_keys", "I7: authorized_keys"],
  ["rm -f cert.PFX", "I7: *.pfx"],
  ["rm -f store.jks", "I7: *.jks"],
  ["rm -f terraform.tfstate.backup", "I7: *tfstate*"],
  ["rm -f config/master.key", "I7: master.key"],
  ["rm -f vault.kdbx", "I7: *.kdbx"],
  ["rm -f wallet.dat", "I7: wallet.dat"],
  ["rm -f .netrc", "I7: .netrc"],
  ["rm -f .pypirc", "I7: .pypirc"],
  ["rm -f secrets.yaml", "I7: secrets*"],
  ["rm -f app.sqlite3", "I7: *.sqlite3"],
  // ---- I8 空展開の ref ----
  ["B=$(git branch --show-current); git push origin $B", "I8: ref 変数でも引用なし"],
  ["B=$(git rev-parse HEAD); git push origin $B", "I8: 引用なし（空なら既定の push 先）"],
  // ---- I9 cd の追跡（作業フォルダを確定しない形）: 旧挙動は nowhere/… を見て「無い」で通していた ----
  ["cd nowhere || true; git checkout src/app.js", "I9: cd || true"],
  ["cd nowhere; git checkout src/app.js", "I9: cd ;（失敗しても次が走る）"],
  ["cd nowhere & git checkout src/app.js", "I9: cd &"],
  ["if true; then cd nowhere; fi; git checkout src/app.js", "I9: if の中の cd"],
  ["for d in a; do cd nowhere; done; git checkout src/app.js", "I9: ループの中の cd"],
  ["for d in a b; do cd nowhere && git checkout file.txt; done", "I9: ループの中の cd &&（2 周目は別の場所から相対）"],
  ["cd nowhere && ls; git checkout file.txt", "I9: && の鎖が ; で切れた後"],
  ["cd nowhere && eval 'cd ..' && git checkout file.txt", "I9: eval の中の cd"],
  ["cd nowhere && trap 'cd ..' DEBUG && git checkout file.txt", "I9: trap の中の cd"],
  ["CDPATH=/x; cd nowhere && git checkout file.txt", "I9: CDPATH を代入した行の相対 cd"],
];

export const PASS4 = [
  // ---- 1. 追跡中止の語: 正常形 ----
  [`S=${T}/x; rm -rf "$S"`, "正常: 1 回だけ代入した /tmp（control）"],
  ['A=1; B=2; ls "$A"', "正常: 単純な代入と参照"],
  [`S=${T}/x; export S; rm -rf "$S"`, "正常: export（オプションなし・代入なし）"],
  [`S=${T}/x && rm -rf "$S/out"`, "正常: && の鎖"],
  [`S=${T}/x; mkdir -p "$S"; rm -rf "$S/y"`, "正常: 間に無関係なコマンド"],
  [`S=${T}/x; printf '%s\\n' hi; rm -rf "$S"`, "正常: printf（-v なし）"],
  [`S=${T}/x; git commit -m "S=1"; rm -rf "$S"`, "正常: 引数の中の S=…（代入ではない）"],
  // ---- 2. 記録しない変数: 正常形 ----
  [`HOMEDIR=${T}/x; rm -rf "$HOMEDIR"`, "正常: HOME で始まる別名"],
  [`MYPATH=${T}/p; rm -rf "$MYPATH"`, "正常: PATH を含む別名"],
  // ---- 3. 引用付きは解決する ----
  [`S=${T}/x; rm -rf "$S"/y`, "正常: \"$S\"/y"],
  [`S=${T}/x; rm -rf "\${S}/y"`, "正常: \"${S}/y\""],
  // ---- 4. 鎖: 正常形 ----
  [`D=${T}/x && echo $(rm -rf "$D/y")`, "正常: 行頭の代入（global）は $( ) へ引き継ぐ"],
  [`D=${T}/x; echo $(rm -rf "$D/y")`, "正常: ; の後の $( )"],
  [`D=${T}/x; ( rm -rf "$D/y" )`, "正常: サブシェルの中"],
  // ---- 5. 置換なし ----
  [`S=${T}/x; rm -rf "$S/a"`, "正常: 置換なし"],
  [`S=${T}/x; rm -rf "$S/b" "$S/c"`, "正常: 複数とも /tmp"],
  // ---- 6. 左辺: 正常形 ----
  [`export S=${T}/y; rm -rf "$S"`, "正常: export S=…（引用なしの左辺）"],
  [`S="${T}/x"; rm -rf "$S"`, "正常: 右辺だけ引用"],
  // ---- 7. nameref でない ----
  [`S=${T}/x; R=${T}/y; rm -rf "$S" "$R"`, "正常: 普通の代入 2 つ"],
  [`S=${T}/x; ( $C x ); rm -rf "$S"`, "正常: サブシェルの中の測れないコマンドは外へ効かない"],
  [`S=${T}/x; echo "$($C x)"; rm -rf "$S"`, "正常: $( ) の中の測れないコマンドは外へ効かない"],
  // ---- F1: 正常形 ----
  ["rm --forc out.txt", "F1 正常: --forc＝--force（単一相対の緩和）"],
  ["rm --verb out.txt", "F1 正常: --verb＝--verbose"],
  ["rm --he", "F1 正常: --he＝--help（対象なし）"],
  [`rm --recursive --force ${T}/x`, "F1 正常: 正式名の /tmp 掃除"],
  [`rm --rec --forc ${T}/x`, "F1 正常: 接頭辞の /tmp 掃除"],
  // ---- F6: 正常形 ----
  ["unset 'a[1]'", "F6 正常: 添字が数"],
  ["unset arr", "F6 正常: 配列ごと"],
  ["printf -v x %s 1", "F6 正常: printf -v（添字なし）"],
  ["[[ -v a[1] ]] && echo y", "F6 正常: [[ -v ]]（置換なし）"],
  ["unset 'a[$((i+1))]'", "F6 正常: 算術展開だけ"],
  ['echo "${!p@}"', "F6 正常: ${!prefix@}"],
  // ---- I6/I7: 正常形 ----
  ["rm -f my-file_1.txt", "I6 正常"],
  ["rm -f foo@2x.png", "I6 正常: @ だけ（( が無い）"],
  ["rm -f idea.md", "I7 正常: id_ でない"],
  ["rm -f monkey.txt", "I7 正常: key を含むが .key でない"],
  ["rm -f out.txt", "I7 正常"],
  // ---- I8: 正常形 ----
  ['B=$(git rev-parse HEAD); git push origin "$B"', "I8 正常: 引用つき"],
  ['B=$(git branch --show-current); git push -q origin "$B"', "I8 正常: 引用つき"],
  // ---- I9: 正常形（&& で追う） ----
  ["cd nowhere && git checkout main", "I9 正常: cd X && git checkout <無い名前>"],
  ["cd sub && git checkout main && git status", "I9 正常: 鎖の中"],
];
