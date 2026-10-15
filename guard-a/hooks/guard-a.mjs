// guard-a: 削除・巻き戻しの影響範囲ガード（自前 mod・2026-10-13）
//
// tool.call (Bash) で、消す・巻き戻す・強制上書きするコマンドを「静的に」判定し、
// 該当すれば engine の確認ダイアログ（$.ui.ask）で「止める／実行する」を聞く。
//
// 設計原則（README に詳細）:
//  1. 決定的コードのみ。LLM・ネットワーク・ファイル書込・環境変数参照なし。
//  2. 承認前に外部コマンドを一切実行しない（$.process.run を使わない）。
//     読むのは $.fs.stat だけ: /tmp 例外の検証（親フォルダの realPath）と、
//     git checkout <名前> の名前が実在パスかの確認（無ければブランチ名として通す）。
//  3. fail-closed: 判定中の例外は .catch で deny（理由つき）。
//  4. 画面が無い（$.session.surfaces() が空）なら待たずに理由つきで deny。
//     待ちは最大 10 分、無回答・ダイアログを閉じた・中断は deny。
//  5. 同じ対象の削除の試みが同一セッションで 2 回目なら警告する（$.state）。
//  6. コマンドは書き換えない。止めるか通すかだけ。
//
// 公式 blast-radius（Apache-2.0）の構造（tool.call で保留→deny に理由）を手本にしたが、
// 判定器・保留の仕組みは書き直している。公式のコードは複製していない。

const HOLD_LIMIT_MS = 10 * 60 * 1000;
const MAX_DEPTH = 6;
const SEEN_MAX_KEYS = 500;
const CANCEL = "止める（実行しない）";
const PROCEED = "実行する";
const SEEN = { plugin: "guard-a", key: "seen" };

// 一度に 1 件だけ保留する。2 件目は待たずに理由つきで止める（待ちに外部 sleep を使わないため）。
let holding = false;

export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const command = String(e.command ?? "");
    // $.session.id() は /tmp/claude-<uid>/<プロジェクト>/<セッション> の線引き（自分のセッションだけ通す）にだけ使う。
    const verdict = await decide(command, (path) => $.fs.stat(path, { resolve: true }), { sessionId: () => $.session.id() });
    const repeats = await noteAttempts($, verdict.deletes);

    if (!verdict.hold) {
      if (repeats.length > 0) {
        $.ui.toast(`guard-a: 同じ対象の削除はこのセッションで2回目です（${repeats.slice(0, 3).join(", ")}）。消していること自体を疑ってください。`, { timeoutMs: 8000 });
      }
      return next(e);
    }

    const summary = summarize(verdict, command);
    // 排他: 検査と設定の間に await を挟まない（同時に届いた 2 件が両方ダイアログを出さないため）
    if (holding) {
      return { deny: `guard-a がこのコマンドを止めました: 別の確認待ちが既にあります。${summary} ユーザーが求めない限り再試行しないでください。` };
    }
    holding = true;
    let answer;
    try {
      const surfaces = await $.session.surfaces();
      if (surfaces.length === 0) {
        return { deny: `guard-a がこのコマンドを止めました: 確認を出せる画面がありません（headless / -p 実行）。${summary} 必要ならユーザーに対話セッションで実行してもらってください。` };
      }
      answer = await askUser($, next.signal, question(verdict, command, repeats));
    } finally {
      holding = false;
    }

    if (answer.kind === "proceed") {
      $.ui.toast("guard-a: ユーザーの承認で実行します");
      return next(e);
    }
    const why = {
      cancel: "ユーザーが「止める」を選びました",
      other: `ユーザーは実行を選ばず、こう答えました: 「${String(answer.text ?? "").slice(0, 300)}」`,
      dismissed: `確認ダイアログが閉じられたか、出せませんでした（${String(answer.text ?? "").slice(0, 120)}）`,
      timeout: "10分以内に回答がありませんでした",
      interrupted: "ターンが中断されました",
    }[answer.kind] ?? "回答を記録できませんでした";
    return { deny: `guard-a がこのコマンドを止めました: ${why}。${summary} ユーザーが求めない限り再試行しないでください。` };
  }).catch(($, e, next) => {
    // 判定・保留のどこかで例外 → 止める（fail-closed）。
    // re-entry（このフックの $ 呼び出しの下で Bash が起きた）は $ を使えないので静的判定だけで決める。
    if (next.error !== undefined && next.error.kind === "re-entry") {
      let c;
      try {
        c = classify(String(e.command ?? ""));
      } catch {
        c = null;
      }
      if (c !== null && c.risks.length === 0 && c.tmpChecks.length === 0 && c.existChecks.length === 0) {
        return next(e);
      }
      return { deny: "guard-a がこのコマンドを止めました: 他の確認の最中に届いた削除・巻き戻し系のコマンドで、確認を出せません。ユーザーが求めない限り再試行しないでください。" };
    }
    if (next.called) {
      return next(e);
    }
    const kind = next.error !== undefined ? next.error.kind : "unknown";
    return { deny: `guard-a がこのコマンドを止めました: 判定中にエラーが起きました（${kind}）。安全側に倒して実行していません。ユーザーが求めない限り再試行しないでください。` };
  });
}

// ---- 保留（ダイアログ） ----------------------------------------------------

async function askUser($, signal, text) {
  let timer = null;
  let onAbort = null;
  const asked = $.ui.ask(text, { header: "guard-a", options: [CANCEL, PROCEED] }).then(
    (a) => ({ kind: a === PROCEED ? "proceed" : a === CANCEL ? "cancel" : "other", text: a }),
    (err) => ({ kind: "dismissed", text: String(err?.message ?? err) }),
  );
  const timedOut = new Promise((resolve) => {
    timer = $.clock.after(HOLD_LIMIT_MS, () => resolve({ kind: "timeout" }));
  });
  const interrupted = new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "interrupted" });
      return;
    }
    onAbort = () => resolve({ kind: "interrupted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([asked, timedOut, interrupted]);
  } finally {
    if (timer !== null) {
      timer.cancel();
    }
    if (onAbort !== null) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

// 同じ対象への削除の試みを数える（情報用。失敗しても判定は変えない）。
async function noteAttempts($, keys) {
  if (keys.length === 0) {
    return [];
  }
  try {
    const { value, version } = await $.state.get(SEEN);
    const seen = value !== undefined && value !== null && typeof value === "object" ? { ...value } : {};
    const repeats = [];
    for (const k of new Set(keys)) {
      if ((seen[k] ?? 0) >= 1) {
        repeats.push(k);
      }
      seen[k] = (seen[k] ?? 0) + 1;
    }
    const names = Object.keys(seen);
    for (const k of names.slice(0, Math.max(0, names.length - SEEN_MAX_KEYS))) {
      delete seen[k];
    }
    await $.state.set(SEEN, seen, { ifVersion: version });
    return repeats;
  } catch {
    return [];
  }
}

function question(verdict, command, repeats) {
  const lines = [];
  lines.push("guard-a: このコマンドは削除・巻き戻し・強制上書きを含みます。");
  lines.push(`コマンド: ${oneLine(command, 300)}`);
  for (const r of verdict.risks.slice(0, 8)) {
    lines.push(`・${r.label}${r.where ? `（${r.where}）` : ""}`);
    if (r.targets && r.targets.length > 0) {
      lines.push(`  対象: ${r.targets.slice(0, 6).join(" ")}${r.targets.length > 6 ? ` ほか${r.targets.length - 6}件` : ""}`);
    }
    for (const note of r.notes.slice(0, 4)) {
      lines.push(`  注意: ${note}`);
    }
  }
  if (verdict.risks.length > 8) {
    lines.push(`・ほか ${verdict.risks.length - 8} 件`);
  }
  if (repeats.length > 0) {
    lines.push(`★同じ対象の削除はこのセッションで2回目です（${repeats.slice(0, 3).join(", ")}）。消していること自体を疑ってください。`);
  }
  lines.push("（文字列からの静的判定です。何が消えるかは実測していません。安全保証ではありません）");
  lines.push("実行しますか？");
  return lines.join("\n");
}

function summarize(verdict) {
  const parts = verdict.risks.slice(0, 5).map((r) => {
    const t = r.targets && r.targets.length > 0 ? ` 対象=${r.targets.slice(0, 4).join(" ")}` : "";
    const n = r.notes.length > 0 ? `（${r.notes.slice(0, 2).join("／")}）` : "";
    return `${r.label}${t}${n}`;
  });
  return `検出: ${parts.join("; ")}${verdict.risks.length > 5 ? ` ほか${verdict.risks.length - 5}件` : ""}。`;
}

// 線形: 先に長さを切り、行ごとに trim して ⏎ でつなぐ（正規表現の \s*\n\s* は長い空白列で二次になる）。
export function oneLine(s, max) {
  const cut = s.length > max * 4 ? s.slice(0, max * 4) : s;
  const t = cut.split("\n").map((l) => l.trim()).join(" ⏎ ");
  return t.length > max || cut.length < s.length ? `${t.slice(0, max)}…` : t;
}

// ---- 判定（純関数。$ を使わない） -------------------------------------------

/**
 * コマンドと stat 関数から最終判定を出す。stat は /tmp 例外の検証と git checkout <名前> の実在確認だけに使う。
 * opts.sessionId（関数または文字列）は /tmp/claude-<uid>/<プロジェクト>/<セッション>/… の線引きにだけ使う。
 * @returns {{ hold: boolean, risks: object[], deletes: string[] }}
 */
export async function decide(command, stat, opts = {}) {
  const c = classify(command);
  const risks = c.risks.slice();
  let sid;
  const sessionId = async () => {
    if (sid === undefined) {
      try {
        const v = typeof opts.sessionId === "function" ? await opts.sessionId() : opts.sessionId;
        sid = typeof v === "string" && v !== "" ? v : null;
      } catch {
        sid = null;
      }
    }
    return sid;
  };
  for (const check of c.tmpChecks) {
    const problem = await verifyTmp(check.path, stat, sessionId);
    if (problem !== null) {
      risks.push({ label: check.label, where: check.where, targets: [check.path], notes: [`/tmp 例外を認めない: ${problem}`] });
    }
  }
  // git checkout <名前> の後段チェック: 名前が実在パスなら「作業ツリーの変更を捨てる」形。
  // 無い（ENOENT/ENOTDIR）なら ブランチ名などとして通す。それ以外の失敗・基準フォルダ不明は確かめられない＝止める。
  for (const check of c.existChecks) {
    if (check.path === null) {
      risks.push({ label: check.label, where: check.where, targets: [check.name], notes: [`${check.name} がパスかどうか確かめられない（${check.unknown}）。${check.note}かもしれない`] });
      continue;
    }
    const found = await pathExists(check.path, stat);
    if (found !== false) {
      risks.push({ label: check.label, where: check.where, targets: [check.path], notes: [found === true ? `${check.path} は実在するパス＝${check.note}` : `${check.path} がパスかどうか確かめられない（${found}）。${check.note}かもしれない`] });
    }
  }
  return { hold: risks.length > 0, risks, deletes: c.deletes };
}

/** true=実在 / false=無い（ENOENT・ENOTDIR） / 文字列=確かめられない理由。 */
async function pathExists(path, stat) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    const code = String(err?.code ?? "");
    const msg = String(err?.message ?? err);
    if (/^(ENOENT|ENOTDIR)$/.test(code) || /\b(ENOENT|ENOTDIR)\b/.test(msg)) {
      return false;
    }
    return msg.slice(0, 80) || "不明なエラー";
  }
}

/**
 * /tmp 例外の検証: rm は最後の要素を消すので、親フォルダの realPath が /tmp 配下かを見る。
 * /tmp/claude-<uid>（全体）・<プロジェクト>・<セッション> は根扱いで止める。
 * その下は「自分のセッション（$.session.id()）」のものだけ通す。他のセッション・確かめられない時は止める。
 */
async function verifyTmp(path, stat, sessionId) {
  const cut = path.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : path.slice(0, cut);
  const name = path.slice(cut + 1);
  let st;
  try {
    st = await stat(parent);
  } catch {
    return `親フォルダ ${parent} の実体を確認できない`;
  }
  const real = st && typeof st.realPath === "string" ? st.realPath : null;
  if (real === null) {
    return `親フォルダ ${parent} の実体を確認できない`;
  }
  const root = TMP_ROOTS.find((r) => real === r || real.startsWith(`${r}/`));
  if (root === undefined) {
    return `親フォルダの実体が ${real}（/tmp の外）`;
  }
  const full = `${real}/${name}`;
  const rest = full.slice(root.length + 1).split("/");
  if (/^claude-/.test(rest[0])) {
    if (rest.length === 1) {
      return `${full} は全セッション共有の scratchpad 根`;
    }
    if (rest.length <= 3) {
      return `${full} は scratchpad の親（プロジェクト・セッション単位のフォルダ）`;
    }
    const own = await sessionId();
    if (own === null) {
      return `${full} がどのセッションの作業物か確かめられない（自分のセッション ID を得られない）`;
    }
    if (rest[2] !== own) {
      return `${full} は他のセッション（${rest[2]}）の作業物`;
    }
  }
  return null;
}

const TMP_ROOTS = ["/private/tmp", "/tmp"];

/**
 * 静的判定。全セグメント・全入れ子を評価し、見つけた危険を全部返す。
 * @returns {{ risks: object[], tmpChecks: object[], existChecks: object[], deletes: string[] }}
 */
export function classify(command, depth = 0) {
  // cwd: "" ＝ $.fs.stat の基準（セッションの作業フォルダ）／文字列＝そこからの cd 先／null＝cd 先を確かめられない
  // vars: 同じコマンド行で確実に代入された変数（名前→文字どおりの値）。null＝追えない（ループ・関数・IFS など）
  const ctx = { risks: [], tmpChecks: [], existChecks: [], deletes: [], cwd: "", cwdChain: null, cdpath: false, vars: new Map(), unstable: new Set(), chain: 0, seq: 0, dropVars: false, softRm: [], cwdMoved: false };
  walk(String(command), depth, ctx, "");
  // rm -f 単一相対の緩和は、同じ行で作業フォルダが動かない時だけ（動けば従来どおり HOLD）
  if (ctx.cwdMoved) {
    ctx.risks.push(...ctx.softRm);
  }
  delete ctx.softRm;
  delete ctx.cwdMoved;
  delete ctx.cwd;
  delete ctx.vars;
  delete ctx.unstable;
  delete ctx.chain;
  delete ctx.seq;
  delete ctx.cwdChain;
  delete ctx.cdpath;
  delete ctx.dropVars;
  return ctx;
}

const CTL_OPEN = new Set(["if", "case", "{", "while", "until", "for", "select"]);
const CTL_CLOSE = new Set(["fi", "esac", "}", "done"]);
// 添字の中のコマンド置換（a[$(cmd)]・a[`cmd`]。算術 $(( は除く）
const SUBSCRIPT_SUB = /\$\((?!\()|`/;
// 引数・オプション値を「変数名（添字つき）」として評価する組込み: 添字 a[…] の中は算術として展開される＝$( ) が走る
const SUBSCRIPT_CMDS = new Set(["unset", "read", "declare", "typeset", "local", "readonly", "export", "let", "printf", "test", "[", "[[", "mapfile", "readarray"]);
const VAR_RESET = new Set(["read", "export", "declare", "typeset", "local", "readonly", "unset", "getopts", "mapfile", "readarray", "let", "eval", "source", ".", "printf"]);

// ---- 変数追跡（第3ラウンドで頼まれずに足した機構・通す方向に効くので最も保守的に扱う） ----
// 前提は「同じコマンド行で、確実に 1 回だけ代入された文字どおりの値」。bash の組込み・特殊変数・分岐・eval/trap で
// この前提は簡単に崩れる。方針: 疑わしければ追跡をやめる（ctx.vars = null）＝従来どおり「測れない」で止める。
// 同じコマンド行に（引用・\・builtin/command 前置きを問わず＝語の値で）出たら、その行では変数を追わない語
const VAR_ABORT = new Set(["declare", "typeset", "local", "readonly", "trap", "eval", "source", "read", "mapfile", "readarray", "unset", "set", "shopt", "let", "coproc", "getopts", "select"]);
// 記録しない変数（bash が自分で書き換える・意味が特別・展開や cd の結果を変える）。BASH*・EPOCH* も
const NO_TRACK = new Set(["PWD", "OLDPWD", "_", "REPLY", "BASH_REMATCH", "MAPFILE", "OPTARG", "OPTIND", "OPTERR", "COPROC", "RANDOM", "SECONDS", "LINENO", "BASHPID", "SHLVL", "IFS", "CDPATH", "HOME", "PATH", "GLOBIGNORE", "ENV", "BASH_ENV", "PS1", "PS2", "PS3", "PS4", "PROMPT_COMMAND", "FUNCNAME", "SRANDOM"]);
function noTrack(name) {
  return NO_TRACK.has(name) || /^(BASH|EPOCH)/.test(name);
}
// 左辺 NAME= の形（引用・エスケープの有無を問わず語の値で見る）／左辺が展開（$N=…・${N}=…）
const ASSIGN_LIKE = /^(?:[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?:\[[^\]]*\])?\+?=)/;
// コマンド位置で外す前置き（この後もまだコマンド位置）
const CMDPOS_PREFIX = new Set(["builtin", "command", "time", "exec", "nohup", "!"]);

/**
 * 変数を追えるかの下見。null＝この行では追わない（VAR_ABORT の語・関数定義・IFS・算術・nameref・printf -v・export のオプション・
 * 引用/エスケープされた代入の左辺・コマンド位置の「.」・ループの中の export/let 等）。
 * それ以外は「2 回以上代入される名前・for などで値が変わる名前」の集合（追わない名前）。
 * 代入が 1 回だけの名前なら、文字どおりの順で読んでもループの回り方で値が変わらない。
 */
function varPrescan(toks) {
  const count = new Map();
  const bump = (name) => count.set(name, (count.get(name) ?? 0) + 2);
  let loop = false;
  let risky = false;
  let cmdPos = true; // 次の語がコマンド位置か
  let prevPrefix = false; // 直前の語が command/builtin/time（その後のオプションもまだコマンド位置）
  let exportSeg = false; // 今のセグメントが export
  for (let k = 0; k < toks.length; k += 1) {
    const t = toks[k];
    if (t.t === "op" && t.v === "(" && toks[k + 1] !== undefined && toks[k + 1].t === "op" && (toks[k + 1].v === ")" || toks[k + 1].v === "(")) return null; // f() { … } ／ (( S=1 ))
    if (t.t === "op") {
      cmdPos = true;
      prevPrefix = false;
      exportSeg = false;
      continue;
    }
    if (t.t !== "w") continue;
    if (VAR_ABORT.has(t.v)) return null;
    if (t.v.includes("$((")) return null; // $(( S=1 )) は代入しうる
    if (t.v === "IFS" || /^IFS(\[|\+?=)/.test(t.v)) return null;
    if (t.v === "function") return null;
    if (t.assigns) return null;
    if (t.v === "printf") {
      // printf -v NAME・-vNAME は代入する。最初の引数が展開なら -v かもしれない
      for (let j = k + 1; j < toks.length && toks[j].t === "w"; j += 1) {
        if (toks[j].v.startsWith("-v") || (j === k + 1 && toks[j].v.startsWith("$"))) return null;
      }
    }
    if (t.v === "export") {
      exportSeg = true;
      // export -n・-f・-p など、オプション（展開でオプションになりうる語も）が付いたら追わない
      for (let j = k + 1; j < toks.length && toks[j].t === "w"; j += 1) {
        if (/^[-+]/.test(toks[j].v) || toks[j].v.startsWith("$")) return null;
      }
    }
    // 左辺が引用・エスケープ・展開の「代入らしい語」（"S=$HOME"・S\=x・$N=x）がコマンド位置か export の引数にある＝意味を確定できない
    if ((cmdPos || exportSeg) && ASSIGN_LIKE.test(t.v) && !ASSIGN.test(t.lead)) return null;
    if (cmdPos) {
      if (t.v === ".") return null; // . file（source）
      if (KEYWORDS.has(t.v) || CTL_OPEN.has(t.v) || CMDPOS_PREFIX.has(t.v) || ASSIGN.test(t.lead) || (prevPrefix && t.v.startsWith("-"))) {
        prevPrefix = CMDPOS_PREFIX.has(t.v) || (prevPrefix && t.v.startsWith("-"));
      } else {
        cmdPos = false;
        prevPrefix = false;
      }
    }
    if (!t.q && /^(for|while|until)$/.test(t.v)) {
      loop = true;
      if (t.v === "for" && toks[k + 1] !== undefined && toks[k + 1].t === "w") bump(toks[k + 1].v);
    }
    if (/^(\.|export|let)$/.test(t.v)) risky = true; // ループの中の「.」は位置を問わず追わない（第3Rの線を緩めない）
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/.exec(t.lead);
    if (m !== null) count.set(m[1], (count.get(m[1]) ?? 0) + 1);
  }
  if (loop && risky) return null;
  return new Set([...count].filter(([, n]) => n > 1).map(([name]) => name));
}

/** 鎖（&&）の中だけ有効な代入を捨てた写し（$( )・( ) の中へ引き継ぐ時に使う）。 */
function globalVars(vars) {
  return vars === null ? null : new Map([...vars].filter(([, e]) => e.chain === null));
}

/**
 * inherit=true は $( ) の中（親の変数が見え、中の代入は外へ出ない）。
 * sh -c・eval・ssh などの文字列は別のシェル・別の時点で読まれるので、変数は引き継がない（追えない扱い）。
 */
function walk(src, depth, ctx, where, inherit = false) {
  if (depth > MAX_DEPTH) {
    ctx.risks.push({ label: "入れ子が深すぎる", where, targets: [], notes: ["sh -c / eval / $( ) の入れ子が深く、中身を読み切れない"] });
    return;
  }
  const toks = lex(src);
  const segs = split(toks);
  const saved = [ctx.cwd, ctx.vars, ctx.unstable, ctx.chain, ctx.cwdChain];
  const unstable = varPrescan(toks);
  if (unstable === null || (inherit && saved[1] === null)) {
    ctx.vars = null;
  } else {
    // $( ) の中へは「鎖の中だけ有効」な代入を引き継がない（鎖番号の衝突を構造的に無くす）
    ctx.vars = inherit ? globalVars(saved[1]) : new Map();
    ctx.unstable = inherit && saved[2] ? new Set([...saved[2], ...unstable]) : unstable;
  }
  // CDPATH を代入する行では相対の cd 先を確かめない
  if (toks.some((t) => t.t === "w" && /^CDPATH(\+?=|$)/.test(t.v))) ctx.cdpath = true;
  // ${!r}（間接展開）と、添字の中のコマンド置換らしい語が同じ行にある＝添字の評価でコマンドが走りうる
  if (toks.some((t) => t.t === "w" && t.v.includes("${!")) && toks.some((t) => t.t === "w" && t.v.includes("[") && SUBSCRIPT_SUB.test(t.v))) {
    ctx.risks.push({ label: "間接展開と添字内のコマンド置換", where, targets: [], notes: ["${!名前} の先が配列の添字 a[$(…)] なら、展開の時に添字の中のコマンドが走る（測れない）"] });
  }
  const stack = [];
  let pd = 0;
  let ctl = 0;
  let chain = 0;
  for (const seg of segs) {
    // ( … ) の中の cd・代入は外へ出ない（中へは鎖の中だけ有効な代入を持ち込まない）
    while (pd < seg.pd) {
      stack.push([ctx.cwd, ctx.vars === null ? null : new Map(ctx.vars), ctx.cwdChain]);
      ctx.vars = globalVars(ctx.vars);
      pd += 1;
    }
    while (pd > seg.pd) {
      [ctx.cwd, ctx.vars, ctx.cwdChain] = stack.pop();
      pd -= 1;
    }
    // if/case/{/ループの中の代入は「確実」でない。case のパターン（fi)・})・done)）は語であって制御構造ではない（第5R B2）
    for (const x of seg.pattern ? [] : seg.words) {
      if (x.q) break;
      if (CTL_OPEN.has(x.v)) ctl += 1;
      else if (CTL_CLOSE.has(x.v)) ctl -= 1;
      else if (!KEYWORDS.has(x.v)) break;
    }
    seg.ctl = ctl;
    // && でつながる限り同じ鎖（a && X=v && rm $X の rm は X=v を通った時だけ走る）。番号は ctx 全体で単調増加
    if (seg.prev !== "&&") {
      ctx.seq += 1;
      chain = ctx.seq;
      // cd X && … の cd 先は鎖の中だけ確か（鎖の外では cd が失敗・不実行だったかもしれない）
      if (ctx.cwdChain !== null && ctx.cwdChain !== chain) {
        ctx.cwd = null;
        ctx.cwdChain = null;
      }
    }
    seg.chain = chain;
    ctx.chain = chain;
    // $( ) ・ ` ` ・ <( ) の中身も同じ規則で見る
    for (const w of seg.words.concat(seg.redirs.map((r) => r.word).filter(Boolean))) {
      for (const sub of w.subs) {
        const keep = [ctx.cwd, ctx.chain, ctx.cwdChain];
        walk(sub, depth + 1, ctx, where ? `${where} › $( )` : "$( ) の中", true);
        [ctx.cwd, ctx.chain, ctx.cwdChain] = keep;
      }
    }
    if (seg.pattern) {
      continue; // case のパターンはコマンドではない
    }
    const outerDrop = ctx.dropVars;
    ctx.dropVars = false;
    analyze(seg, depth, ctx, where);
    const drop = ctx.dropVars;
    ctx.dropVars = outerDrop;
    // コマンド名が測れない（$C …）なら、それが declare・read などでありうる＝この後は変数を追わない
    if (drop) ctx.vars = null;
  }
  [ctx.cwd, ctx.vars, ctx.unstable, ctx.chain, ctx.cwdChain] = saved;
}

/**
 * 代入の確かさ: "global"（行頭・;・改行・( の後）／"chain"（&& の後＝同じ鎖の中だけ）／null（不確か）。
 * 「改行の後」は &&・||・| の直後の改行を含まない（それは同じ演算子の続き。prev は && / || / | のまま＝chain / null / パイプ。第5R B1）。
 */
function assignMode(seg, ctx) {
  if (ctx.vars === null || seg.ctl !== 0 || seg.piped || ["|", "|&", "&"].includes(seg.next ?? "")) return null;
  const prev = seg.prev ?? "";
  if (prev === "" || prev === ";" || prev === "\n" || prev === "(") return "global";
  return prev === "&&" ? "chain" : null;
}

/** 代入 NAME=値 を記録する。不確か・値を追えない・配列・追記・~・2 回以上代入される名前は「分からない」（消す）。 */
function recordAssign(ctx, name, x, mode) {
  const eq = x.lead.indexOf("=");
  if (noTrack(name)) {
    ctx.vars.delete(name); // PWD・_・HOME・IFS など＝bash が書き換える・意味が特別なので記録しない
    return;
  }
  const val = resolveWord(x, ctx, true);
  // B=$(git branch --show-current) のような ref だけを出す置換は「ref として安全」と覚える（値は追わない）
  if (val === null && mode !== null && !ctx.unstable.has(name) && x.lead === x.lit && x.lead[eq - 1] !== "+" && refGenerator({ ...x, lit: "" })) {
    ctx.vars.set(name, { value: null, refSafe: true, chain: mode === "chain" ? ctx.chain : null });
    return;
  }
  if (mode === null || val === null || ctx.unstable.has(name) || x.lead[eq - 1] === "+" || x.lead.slice(0, eq).includes("[")) {
    ctx.vars.delete(name);
    return;
  }
  const value = val.slice(val.indexOf("=") + 1);
  if (value.startsWith("~") || value.includes(":~")) {
    ctx.vars.delete(name);
    return;
  }
  ctx.vars.set(name, { value, chain: mode === "chain" ? ctx.chain : null });
}

/** 変数を変えうる組み込み: read・eval・source などは全部忘れる。export/declare/local は代入を記録（オプション付きは忘れる）。 */
function resetVars(ctx, cmd, args, mode) {
  if (cmd === "unset") {
    args.forEach((a) => ctx.vars.delete(a.v));
    return;
  }
  if (cmd === "printf" && !args.some((a) => a.v === "-v" || a.v.startsWith("-v"))) {
    return;
  }
  if (/^(export|declare|typeset|local|readonly)$/.test(cmd)) {
    const hasOpt = args.some((a) => a.v.startsWith("-") || a.v.startsWith("+"));
    for (const a of args) {
      if (!ASSIGN.test(a.lead)) continue;
      const name = a.lead.slice(0, a.lead.indexOf("=")).replace(/\+$/, "").replace(/\[.*$/, "");
      recordAssign(ctx, name, a, hasOpt ? null : mode);
    }
    return;
  }
  ctx.vars.clear();
}

/** 語が「ref だけを出す置換を確実に代入した変数」だけでできているか（"$B"・$B）。フラグ・+ref・:ref にならない。 */
function refSafeWord(w, ctx) {
  if (ctx.vars === null || !w.exp || w.complex || w.refs.length === 0 || /^[-+:]/.test(w.v)) return false;
  // 引用なしの $B は空展開で引数ごと消える（git push -f origin $B → 既定の push 先）＝ref 扱いしない
  if (w.refs.some((r) => !r.q)) return false;
  return w.refs.every((r) => {
    const e = ctx.vars.get(r.name);
    return e !== undefined && e.refSafe === true && (e.chain === null || e.chain === ctx.chain);
  }) && w.lit.trim() === "";
}

/**
 * 語の値を、同じコマンド内で確実に代入された変数で埋める。追えなければ null。
 * 置換（$( )・` `）・$'…' を含む語は null。引用なしの $S（単語分割・glob を受ける）は null（assign=true＝代入の右辺だけは分割されないので読む）。
 */
function resolveWord(w, ctx, assign = false) {
  if (w.subs.length > 0 || w.ansi) return null;
  if (!w.exp) return w.v;
  if (ctx.vars === null || w.complex || w.refs.length === 0) return null;
  if (!assign && w.refs.some((r) => !r.q)) return null;
  let out = "";
  let prev = 0;
  for (const r of w.refs) {
    const e = ctx.vars.get(r.name);
    if (e === undefined || e.value === null || (e.chain !== null && e.chain !== ctx.chain)) return null;
    // 引用なしの $X は単語分割と glob を受ける＝空白・glob 文字・空の値は件数が変わるので追わない
    if (!r.q && (e.value === "" || /[\s*?[\]{}~]/.test(e.value))) return null;
    out += w.v.slice(prev, r.s) + e.value;
    prev = r.e;
  }
  return out + w.v.slice(prev);
}

// ---- 字句解析 ------------------------------------------------------------

// v＝語の値（引用を外し、展開はそのままの綴り）／unq＝引用の外の文字だけ／lit＝展開以外の文字（引用の中も含む）
// lead＝先頭から最初の引用・展開までの引用なしの文字（VAR= の判定用）／ansi＝$'…' を復号した
function newWord() {
  return { v: "", unq: "", lit: "", lead: "", leadOpen: true, q: false, glob: false, exp: false, tilde: false, ansi: false, subs: [], refs: [], complex: false, assigns: false };
}

/** $'…'（ANSI-C 引用）の中身を復号する: \xHH・\NNN・\uHHHH・\n 等・\\・\'・\cX。 */
export function ansiDecode(s) {
  const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== "\\" || i + 1 >= s.length) {
      out += c;
      continue;
    }
    i += 1;
    const d = s[i];
    if (Object.hasOwn(simple, d)) {
      out += simple[d];
      continue;
    }
    if (d === "x") {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1, i + 3));
      if (m !== null) {
        out += String.fromCharCode(parseInt(m[0], 16));
        i += m[0].length;
      } else {
        out += "\\x";
      }
      continue;
    }
    if (d === "u" || d === "U") {
      const len = d === "u" ? 4 : 8;
      const m = /^[0-9a-fA-F]+/.exec(s.slice(i + 1, i + 1 + len));
      if (m !== null) {
        out += String.fromCodePoint(Math.min(parseInt(m[0], 16), 0x10ffff));
        i += m[0].length;
      } else {
        out += `\\${d}`;
      }
      continue;
    }
    if (d >= "0" && d <= "7") {
      const m = /^[0-7]{1,3}/.exec(s.slice(i, i + 3));
      out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
      i += m[0].length - 1;
      continue;
    }
    if (d === "c" && i + 1 < s.length) {
      i += 1;
      out += String.fromCharCode(s.charCodeAt(i) & 0x1f);
      continue;
    }
    out += `\\${d}`;
  }
  return out;
}

/** j から「\+改行」（行継続）を読み飛ばした位置。bash は単一引用の外でこれを取り除く。 */
function skipLC(text, j) {
  while (text[j] === "\\" && text[j + 1] === "\n") {
    j += 2;
  }
  return j;
}

/** シェルの字句を読む。引用・エスケープ・$( )・` `・リダイレクト・ヒアドキュメントを扱う。 */
export function lex(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  let cur = null;
  let pendingRedir = null; // 次の語をリダイレクト先として受ける
  const heredocs = []; // 改行で本文を読む待ち
  const start = () => {
    if (cur === null) {
      cur = newWord();
    }
  };
  const plain = (s) => {
    cur.v += s;
    cur.unq += s;
    cur.lit += s;
    if (cur.leadOpen) {
      cur.lead += s;
    }
  };
  const quoted = (s) => {
    cur.v += s;
    cur.lit += s;
    cur.q = true;
    cur.leadOpen = false;
  };
  // ref: 単純な変数参照なら { name, q }（同じコマンド内の代入から値を読める）。null なら complex（置換・特殊変数・演算つき ${ }）
  const expand = (s, ref = null) => {
    if (ref !== null) {
      cur.refs.push({ name: ref.name, q: ref.q, s: cur.v.length, e: cur.v.length + s.length });
    } else {
      cur.complex = true;
    }
    cur.v += s;
    cur.exp = true;
    cur.leadOpen = false;
  };
  const flush = () => {
    if (cur === null) {
      return;
    }
    if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(cur.unq)) {
      cur.glob = true; // ブレース展開＝複数対象
    }
    if (pendingRedir !== null) {
      const r = { t: "redir", kind: pendingRedir, word: cur, body: null };
      toks.push(r);
      if (pendingRedir === "<<" || pendingRedir === "<<-") {
        heredocs.push({ tok: r, delim: cur.v, strip: pendingRedir === "<<-", quoted: cur.q });
      }
      pendingRedir = null;
    } else {
      toks.push({ t: "w", ...cur });
    }
    cur = null;
  };
  const balanced = (open) => balancedIn(src, open);
  const dollar = (j, inDq) => {
    const j1 = skipLC(src, j + 1);
    const nx = src[j1];
    if (nx === "(") {
      if (src[skipLC(src, j1 + 1)] === "(") {
        // $(( … )) 算術展開: 中の $( )・` ` は実行される
        const [inner, end] = balanced(j1);
        cur.subs.push(...extractSubs(inner));
        expand(`$(${inner})`);
        return end;
      }
      const [inner, end] = balanced(j1);
      cur.subs.push(inner);
      expand(`$(${inner})`);
      return end;
    }
    if (nx === "{") {
      // ${ … } パラメータ展開: ${X:-$(cmd)} の $(cmd) は実行される。入れ子の { } と $( ) を数えて閉じを探す
      const end = braceEnd(src, j1);
      const inner = src.slice(j1 + 1, Math.max(j1 + 1, end - 1));
      cur.subs.push(...extractSubs(inner));
      if (/^[A-Za-z_][A-Za-z0-9_]*:?[=]/.test(inner)) {
        cur.assigns = true; // ${X:=v}・${X=v} は代入する
      }
      expand(`\${${inner}}`, /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) ? { name: inner, q: inDq } : null);
      return end;
    }
    if (nx === "'" && !inDq) {
      // $'...'（ANSI-C）: 中身は確定するので復号して判定に使う
      let k = j1 + 1;
      let body = "";
      while (k < n && src[k] !== "'") {
        if (src[k] === "\\" && k + 1 < n) {
          body += src.slice(k, k + 2);
          k += 2;
          continue;
        }
        body += src[k];
        k += 1;
      }
      cur.ansi = true;
      quoted(ansiDecode(body));
      return k + 1;
    }
    VAR_NAME.lastIndex = j1;
    const m = VAR_NAME.exec(src);
    if (m !== null) {
      expand(`$${m[0]}`, /^[A-Za-z_]/.test(m[0]) ? { name: m[0], q: inDq } : null);
      return j1 + m[0].length;
    }
    if (inDq) {
      quoted("$");
    } else {
      plain("$");
    }
    return j + 1;
  };
  const backtick = (j) => {
    let k = j + 1;
    while (k < n && src[k] !== "`") {
      k += src[k] === "\\" ? 2 : 1;
    }
    const inner = src.slice(j + 1, Math.min(k, n));
    cur.subs.push(inner);
    expand(`\`${inner}\``);
    return k + 1;
  };
  const readHeredocs = (j) => {
    while (heredocs.length > 0) {
      const h = heredocs.shift();
      const body = [];
      while (j < n) {
        const eol = src.indexOf("\n", j);
        const line = src.slice(j, eol < 0 ? n : eol);
        j = eol < 0 ? n : eol + 1;
        const cmp = h.strip ? line.replace(/^\t+/, "") : line;
        if (cmp === h.delim) {
          break;
        }
        body.push(line);
      }
      h.tok.body = body.join("\n");
      if (!h.quoted) {
        // 非引用デリミタ（<<EOF）の本文は「\+改行」を除いてから $( )・` `・${ } が展開・実行される。<<'EOF' は展開されない
        h.tok.word.subs.push(...extractSubs(h.tok.body.split("\\\n").join("")));
      }
    }
    return j;
  };
  const redirect = (j) => {
    // j は < か > の位置
    const ops = ["<<<", "<<-", "<<", "<>", ">>", ">|", ">&", "<&", ">", "<"];
    const op = ops.find((o) => src.startsWith(o, j));
    pendingRedir = op;
    return j + op.length;
  };

  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      start();
      quoted(src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === "'") {
      start();
      const k = src.indexOf("'", i + 1);
      const end = k < 0 ? n : k;
      quoted(src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '"') {
      start();
      cur.q = true;
      cur.leadOpen = false;
      i += 1;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          // 二重引用の中の \ は $ ` " \ 改行 の前だけ働く。「\+改行」は両方消える（行継続）
          const nx = src[i + 1];
          if (nx === "\n") {
            i += 2;
            continue;
          }
          if (nx === "$" || nx === "`" || nx === '"' || nx === "\\") {
            quoted(nx);
            i += 2;
            continue;
          }
          quoted("\\");
          i += 1;
          continue;
        }
        if (src[i] === "$") {
          i = dollar(i, true);
          continue;
        }
        if (src[i] === "`") {
          i = backtick(i);
          continue;
        }
        quoted(src[i]);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "$") {
      start();
      i = dollar(i, false);
      continue;
    }
    if (c === "`") {
      start();
      i = backtick(i);
      continue;
    }
    // \r は bash では区切りでない（普通の文字）。CRLF の行でもヒアドキュメントの終端は "EOF\r"
    if (c === " " || c === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (c === "\n") {
      flush();
      toks.push({ t: "op", v: "\n" });
      i = readHeredocs(i + 1);
      continue;
    }
    if (c === "#" && cur === null) {
      while (i < n && src[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (c === "&" && src[i + 1] === ">") {
      flush();
      i = redirect(i + 1); // &> と &>>
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "(" || c === ")") {
      flush();
      const two = src.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === "|&" || two === ";;") {
        toks.push({ t: "op", v: two });
        i += 2;
        continue;
      }
      toks.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    if (c === "<" || c === ">") {
      if (src[i + 1] === "(") {
        start();
        const [inner, end] = balanced(i + 1);
        cur.subs.push(inner);
        expand(`${c}(${inner})`);
        i = end;
        continue;
      }
      if (cur !== null && /^\d+$/.test(cur.v) && !cur.q && cur.unq === cur.v) {
        cur = null; // 2> の 2
      } else {
        flush();
      }
      i = redirect(i);
      continue;
    }
    start();
    if (c === "*" || c === "?" || c === "[") {
      cur.glob = true;
    }
    if (c === "~" && cur.v === "") {
      cur.tilde = true;
    }
    plain(c);
    i += 1;
  }
  flush();
  return toks;
}

const VAR_NAME = /(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?$!#@*-])/y;

/** text[open] === "(" から対応する ")" まで。引用の中の括弧は数えない。[中身, 閉じの次の位置]。 */
function balancedIn(text, open) {
  const n = text.length;
  let depth = 0;
  let j = open;
  while (j < n) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "'") {
      const k = text.indexOf("'", j + 1);
      j = k < 0 ? n : k + 1;
      continue;
    }
    if (ch === '"') {
      j += 1;
      while (j < n && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      j += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return [text.slice(open + 1, j), j + 1];
      }
    }
    j += 1;
  }
  return [text.slice(open + 1), n];
}

/** text[open] === "{"（${ の {）から対応する "}" の次の位置。入れ子の { } と $( ) を数える。 */
function braceEnd(text, open) {
  const n = text.length;
  let depth = 0;
  let j = open;
  while (j < n) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "$" && text[j + 1] === "(") {
      j = balancedIn(text, j + 1)[1];
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return j + 1;
      }
    }
    j += 1;
  }
  return n;
}

/**
 * 展開される文脈の文字列（非引用ヒアドキュメント本文・${ } の中・$(( )) の中）から、
 * 実行される $( ) と ` ` の中身を拾う。$(( は算術なので中を続けて走査する。「$\+改行(」も $( と読む。
 */
function extractSubs(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "\\" && text[i + 1] !== "\n") {
      i += 2;
      continue;
    }
    if (c === "$") {
      const j = skipLC(text, i + 1);
      if (text[j] === "(") {
        if (text[skipLC(text, j + 1)] === "(") {
          i = j + 2;
          continue;
        }
        const [inner, end] = balancedIn(text, j);
        out.push(inner);
        i = end;
        continue;
      }
    }
    if (c === "`") {
      let k = i + 1;
      while (k < n && text[k] !== "`") {
        k += text[k] === "\\" ? 2 : 1;
      }
      out.push(text.slice(i + 1, Math.min(k, n)));
      i = k + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * 演算子でセグメントに分ける。パイプの右側は piped を立てる。
 * pd＝そのセグメントの ( ) の深さ（cd・変数の効き目の範囲）／afterClose＝直前が ")"（( … ) > f の > f は複合コマンドに付く）
 * prev/next＝前後の演算子（"" は行頭・行末）／pattern＝case の分岐パターン（a|b) の a・b。コマンドではない）
 */
const CONT_OPS = new Set(["&&", "||", "|", "|&"]);

function split(toks) {
  const segs = [];
  let pd = 0;
  let inPattern = false; // case WORD in の後、")" までがパターン
  const mk = (piped, prev, afterClose = false) => ({ words: [], redirs: [], piped, pd, afterClose, prev, next: "", pattern: inPattern });
  let seg = mk(false, "");
  const push = (op, nextPiped, afterClose = false) => {
    seg.next = op;
    if (seg.words.length > 0 || seg.redirs.length > 0) {
      segs.push(seg);
    }
    seg = mk(nextPiped, op, afterClose);
  };
  for (const t of toks) {
    if (t.t === "op") {
      // &&・||・| の直後の改行（コメント行を挟んでも）は同じ演算子の続き（第5R B1）。新しいセグメントを「行頭」にしない。
      // 続きの行は prev が演算子のまま（代入は && なら鎖の中だけ・|| なら不確か）。さらに contNL を立て、そこでの cd は追わない（cdTracked・保守側）
      if (t.v === "\n" && seg.words.length === 0 && seg.redirs.length === 0 && CONT_OPS.has(seg.prev)) {
        seg.contNL = true;
        continue;
      }
      if (t.v === "(") {
        const piped = seg.piped && seg.words.length === 0;
        if (inPattern && seg.words.length === 0) {
          continue; // case のパターンの前の任意の "("
        }
        pd += 1;
        push("(", piped);
        continue;
      }
      if (t.v === ")") {
        if (seg.pattern) {
          inPattern = false;
          push(")", false);
          continue;
        }
        pd = Math.max(0, pd - 1);
        push(")", false, true);
        continue;
      }
      if (t.v === ";;") {
        inPattern = true; // 次の分岐のパターン
      }
      push(t.v, t.v === "|" || t.v === "|&");
      continue;
    }
    if (t.t === "redir") {
      seg.redirs.push(t);
      continue;
    }
    if (seg.pattern && !t.q && t.v === "esac" && seg.words.length === 0) {
      inPattern = false;
      seg.pattern = false;
    }
    seg.words.push(t);
    // case WORD in: 次からパターン
    if (!t.q && t.v === "in" && seg.words.length === 3 && !seg.words[0].q && seg.words[0].v === "case") {
      inPattern = true;
      push("in", false);
    }
  }
  push("", false);
  return segs;
}

// ---- セグメントの判定 ------------------------------------------------------

const KEYWORDS = new Set(["{", "}", "then", "do", "else", "elif", "if", "while", "until", "!", "fi", "done", "esac"]);
const CLOSERS = new Set(["}", "done", "fi", "esac"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const ARRAY_ELEM = /^\[[^\]]*\]\+?=/; // declare -A X=( [k]=v … ) の要素
const SIMPLE_PREFIX = new Set(["command", "builtin", "nohup", "noglob", "stdbuf", "unbuffer", "setsid"]);
const SUDO_VALUE_OPTS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group", "--chdir", "--prompt", "--role", "--type", "--close-from", "--host", "--other-user", "--command-timeout", "--login-class"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh", "yash", "busybox"]);
const INTERPRETER = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|perl[0-9.]*|ruby[0-9.]*|php[0-9.]*|osascript|pwsh|powershell|Rscript|lua[0-9.]*|tclsh|swift)$/;
const SCRIPT_DANGER = /(rollback|roll-back|wipe|purge|nuke|teardown|destroy)/i;
// 値に命令を持つ環境変数（VAR=… cmd の前置きで、値をシェルが・git が実行する）
const CMD_ENV = new Set(["GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_PAGER", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_PROXY_COMMAND", "EDITOR", "VISUAL", "PAGER", "MANPAGER", "BASH_ENV", "ENV", "PROMPT_COMMAND", "LESSOPEN", "LESSCLOSE"]);
// npm パッケージの rm 相当（rm -rf と同じ扱い）。trash は ゴミ箱経由なので入れない。
const RM_LIKE = new Set(["rimraf", "del-cli", "del", "rm-cli", "rmrf"]);
// 変数のコマンド名（$RM・$GIT_BIN など）で「削除・巻き戻し系」と読める語
const DESTR_WORDS = new Set(["rm", "rmdir", "del", "delete", "unlink", "shred", "rsync", "git", "trunc", "truncate", "wipe", "purge", "nuke", "destroy", "rollback", "rimraf", "erase", "clean", "reset", "srm"]);
const FLAG_DESTR = /^-[a-zA-Z]*[rRf][a-zA-Z]*$|^--(force|recursive|delete|hard)/;
// マイグレーションの巻き戻し・作り直し（名前で止める）
const MIGRATE_TOOLS = new Set(["knex", "prisma", "alembic", "sequelize", "sequelize-cli", "typeorm", "rails", "rake", "dbmate", "goose", "migrate", "diesel", "sqlx", "drizzle-kit", "node-pg-migrate", "db-migrate", "mikro-orm", "flyway", "liquibase"]);
const MIGRATE_DOWN = /^(?:migrate:(?:rollback|reset|fresh|refresh|undo(?::all)?|down)|db:(?:drop|reset|rollback|migrate:undo(?::all)?|schema:load)|downgrade|rollback|reset|drop|drop-all|down|undo|fresh|refresh|revert|clean|migration:revert|schema:drop|--force-reset)$/i;
const NESTED_RULES = new Set(["docker", "podman", "docker-compose", "podman-compose", "kubectl", "oc", "find", "xargs", "parallel", "npx", "bunx", "pnpx", "uvx"]);
const DB_CLI = /^(sqlite3?|psql|mysql|mariadb|duckdb|sqlcmd|clickhouse-client|cockroach)$/;
const DB_DROP = /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i;

/** 名前で止める判定。purgecss（CSS の未使用クラス除去）は消去系ではないので除く。 */
function scriptDanger(name) {
  return SCRIPT_DANGER.test(name.replace(/purge[-:_]?css/gi, ""));
}

/** 変数名・パスを語に割って（_ / - . と camelCase）削除系の語を含むか。$FORMAT や $MODEL は含まない。 */
function destrName(s) {
  return s.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).some((t) => DESTR_WORDS.has(t.toLowerCase()));
}

// インタプリタのコード内: 呼び出しの形だけを見る（文字列リテラル内の語だけでは止めない）。
const DANGER_CALL = new RegExp(
  [
    "(?<![\\w'\"])rmtree\\b(?!\\s*['\".])",
    "\\bos\\s*\\.\\s*(?:remove|unlink|rmdir|removedirs|truncate)\\b(?!\\s*\\.)",
    "\\.\\s*(?:unlink|rmdir)\\s*\\(",
    "(?<![\\w/$'\"])unlink(?:Sync)?\\b(?!\\s*[./])",
    "['\"]unlink['\"]\\s*,",
    "\\brmdir(?:Sync)?\\s*\\(",
    "\\brmSync\\b(?!\\s*\\.)",
    "(?<![\\w$-])rm\\s*\\(",
    "\\bfs(?:\\.promises)?\\s*\\.\\s*(?:rm|unlink|rmdir|truncate)\\b(?!\\s*\\.)",
    "\\btruncate(?:Sync)?\\s*\\(",
    "\\bFileUtils\\s*\\.\\s*(?:rm|rm_r|rm_rf|rm_f|remove|remove_dir|remove_entry|remove_entry_secure)\\b",
    "\\bFile\\s*\\.\\s*(?:delete|unlink)\\b",
    "\\bDir\\s*\\.\\s*(?:delete|rmdir|unlink)\\b",
    "\\bremove_tree\\b",
    "\\brimraf\\b",
    "\\bsend2trash\\b",
    "\\bRemove-Item\\b",
    "\\bDeno\\s*\\.\\s*(?:remove|truncate)(?:Sync)?\\s*\\(",
    "\\bremoveItem\\s*\\(\\s*at",
    "\\bDROP\\s+(?:TABLE|DATABASE)\\b",
  ].join("|"),
  "i",
);
// シェルの削除コマンドの文字列。コード内に「外部コマンドを起動する呼び出し」がある時だけ数える。
const SHELL_STR = /(?:^|[^\w.-])rm(?:\s+-|["'])|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+(?:-[a-z]*f|--force))/i;
const SPAWN = /\b(?:system|popen|Popen|subprocess|exec[A-Za-z]*|spawn[A-Za-z]*|check_call|check_output|shell_exec|passthru|proc_open|getattr|__import__|child_process|Command)\b|%x|`|do\s+shell\s+script/;
const PWSH_DEL = /(?:^|[;|&{(]\s*)(?:ri|rd|del|erase|rmdir|rm)\s+\S/i;
const PWSH_ENC = /^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i;
const FINDER_DEL = /\bdelete\s+(?:file|folder|every|item|items|disk\s+item|POSIX\s+file|alias|\()|\bempty\s+(?:the\s+)?trash\b/i;

function base(v) {
  return v.replace(/^.*\//, "");
}

function wordsText(ws) {
  return ws.map((w) => w.v).join(" ");
}

/** 語の中身が展開だけ（文字どおりの部分が無い）か。"$CMD"・$(cat x) は true、$HOME/bin/tool は false。 */
function onlyExpansion(w) {
  return w.exp && w.lit.trim() === "";
}

function injectedWord(label) {
  return { ...newWord(), v: label, exp: true, injected: true };
}

function add(ctx, risk) {
  ctx.risks.push({ targets: [], notes: [], ...risk });
}

function joinPath(b, p) {
  if (p.startsWith("/") || b === "") return p;
  return `${b.replace(/\/+$/, "")}/${p}`;
}

/** 子の判定を走らせ、増えた危険に注記を足す（ssh・docker exec などの「向こう側で実行」）。 */
function withNote(ctx, note, fn) {
  const before = ctx.risks.length;
  fn();
  for (const r of ctx.risks.slice(before)) {
    r.notes.push(note);
  }
}

/** sh -c の「コード」の位置: -c の後の最初のオプションでない引数（bash -c -x '…'・bash -c -- '…'）。無ければ -1。 */
function shCodeIndex(args, k) {
  let j = k + 1;
  while (j < args.length) {
    const v = args[j].v;
    if (v === "--") return j + 1 < args.length ? j + 1 : -1;
    if (/^[-+]/.test(v) && v !== "-" && v.length > 1) {
      j += v === "-o" || v === "+o" || v === "-O" || v === "+O" || v === "--rcfile" || v === "--init-file" ? 2 : 1;
      continue;
    }
    return j;
  }
  return -1;
}

function analyze(seg, depth, ctx, where) {
  const w = seg.words.slice();
  let sudo = false;
  // ( … ) > f ／ { …; } > f ／ … done > f ／ … fi > f の > f は直前の複合コマンドの出力先（空にする形ではない）
  const closerOnly = seg.afterClose === true || (seg.words.length > 0 && seg.words.every((x) => !x.q && CLOSERS.has(x.v)));
  // 代入だけのセグメント（D=/tmp/x）は、行頭・; ・改行の後で、if/case/{ の外・パイプや & でない時だけ「確実」に記録する
  const assignOnly = seg.words.length > 0 && seg.words.every((x) => (!x.q && KEYWORDS.has(x.v)) || ASSIGN.test(x.lead));
  const mode = assignOnly ? assignMode(seg, ctx) : null;
  // 前置きの語を外す: 予約語・VAR=値・function 名・sudo/doas・command/exec/env/nohup/time/nice/timeout/ionice/script など
  for (;;) {
    if (w.length === 0) {
      break;
    }
    const x = w[0];
    const v = x.v;
    if (!x.q && KEYWORDS.has(v)) {
      w.shift();
      continue;
    }
    // zsh の前置き（第5R B7）: nocorrect・-（login の argv[0]）は外す。repeat N は回数ごと外す。=cmd は PATH の cmd（=rm＝/bin/rm）
    if (!x.q && (v === "nocorrect" || v === "-")) {
      w.shift();
      continue;
    }
    if (!x.q && v === "repeat" && w.length > 2) {
      w.splice(0, 2);
      continue;
    }
    if (!x.q && !x.exp && /^=[A-Za-z0-9_.+/-]/.test(v)) {
      w[0] = { ...x, v: v.slice(1), lit: x.lit.replace(/^=/, ""), unq: x.unq.replace(/^=/, ""), lead: x.lead.replace(/^=/, "") };
      continue;
    }
    // VAR=値: 左辺 NAME= が引用の外にあれば、右辺が引用・展開でも代入（f="$A/x"・MSG="$(cat m)"）
    if (ASSIGN.test(x.lead)) {
      const name = x.lead.slice(0, x.lead.indexOf("=")).replace(/\+$/, "").replace(/\[.*$/, "");
      if (ctx.vars !== null && assignOnly) {
        recordAssign(ctx, name, x, mode);
      }
      if (CMD_ENV.has(name)) {
        const val = v.slice(v.indexOf("=") + 1);
        if (onlyExpansion({ ...x, lit: x.lit.slice(x.lit.indexOf("=") + 1) }) && val !== "") {
          add(ctx, { label: `${name}=…`, where, notes: [`${name} の値（命令として実行される）が変数・置換で、測れない`] });
        }
        walk(val, depth + 1, ctx, nest(where, `${name}=`));
      }
      w.shift();
      continue;
    }
    if (!x.q && v === "function") {
      w.splice(0, 2); // function 名 { … } の「function 名」
      continue;
    }
    if (v === "sudo" || v === "doas") {
      sudo = true;
      w.shift();
      while (w.length > 0 && w[0].v.startsWith("-")) {
        const o = w.shift().v;
        if (o === "--") break;
        if (SUDO_VALUE_OPTS.has(o)) {
          w.shift();
        }
      }
      continue;
    }
    if (v === "command" && w.length > 1 && /^-[a-zA-Z]*[vV]/.test(w[1].v)) {
      return; // command -v / -V は探すだけで実行しない
    }
    if (v === "exec") {
      w.shift();
      while (w.length > 0 && /^-/.test(w[0].v) && w[0].v !== "--") {
        if (w.shift().v === "-a") {
          w.shift(); // exec -a NAME
        }
      }
      if (w.length > 0 && w[0].v === "--") {
        w.shift();
      }
      continue;
    }
    if (SIMPLE_PREFIX.has(v)) {
      w.shift();
      while (w.length > 0 && /^-/.test(w[0].v) && w[0].v !== "--") {
        w.shift();
      }
      if (w.length > 0 && w[0].v === "--") {
        w.shift(); // command -- rm・builtin -- rm・nohup -- rm
      }
      continue;
    }
    if (v === "coproc") {
      w.shift();
      if (w.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w[0].v) && w[1].v === "{") {
        w.shift(); // coproc NAME { …; }
      }
      continue;
    }
    if (v === "caffeinate") {
      w.shift();
      while (w.length > 0 && /^-/.test(w[0].v)) {
        if (/^-[a-zA-Z]*[tw]$/.test(w.shift().v)) {
          w.shift(); // -t 秒・-w PID
        }
      }
      continue;
    }
    if (v === "arch") {
      w.shift();
      while (w.length > 0 && /^-/.test(w[0].v)) {
        const o = w.shift().v;
        if (o === "-arch" || o === "-e" || o === "-d") {
          w.shift();
        }
      }
      continue;
    }
    if (v === "flock") {
      w.shift();
      let lock = false;
      while (w.length > 0) {
        const o = w[0].v;
        if ((o === "-c" || o === "--command") && w.length > 1) {
          return walk(w[1].v, depth + 1, ctx, nest(where, "flock -c"));
        }
        if (o.startsWith("-") && o.length > 1) {
          w.shift();
          if (o === "-w" || o === "--wait" || o === "--timeout" || o === "-E" || o === "--conflict-exit-code") {
            w.shift();
          }
          continue;
        }
        if (!lock) {
          lock = true;
          w.shift(); // ロックファイル
          continue;
        }
        break;
      }
      continue;
    }
    if (v === "watch") {
      // watch は残りを sh -c で繰り返し実行する（-x なら exec）
      w.shift();
      let execMode = false;
      while (w.length > 0 && /^-/.test(w[0].v) && w[0].v !== "--") {
        const o = w.shift().v;
        if (o === "-x" || o === "--exec") {
          execMode = true;
        } else if (o === "-n" || o === "--interval" || o === "-q" || o === "--equexit") {
          w.shift();
        }
      }
      if (w.length > 0 && w[0].v === "--") {
        w.shift();
      }
      if (!execMode) {
        if (w.length > 0) walk(wordsText(w), depth + 1, ctx, nest(where, "watch"));
        return;
      }
      continue;
    }
    if (v === "su") {
      for (let k = 1; k < w.length; k += 1) {
        const o = w[k].v;
        if ((o === "-c" || o === "--command") && k + 1 < w.length) {
          if (onlyExpansion(w[k + 1])) add(ctx, { label: "su -c", where, notes: ["-c の中身が変数・置換で、測れない"] });
          return walk(w[k + 1].v, depth + 1, ctx, nest(where, "su -c"));
        }
        if (o.startsWith("--command=")) {
          return walk(o.slice("--command=".length), depth + 1, ctx, nest(where, "su -c"));
        }
      }
      return; // -c なし＝対話シェル
    }
    if (v === "trap") {
      const a = w.slice(1);
      const k = a.length > 0 && a[0].v === "--" ? 1 : 0;
      if (a.length > k && !/^-[lp]?$/.test(a[k].v)) {
        walk(a[k].v, depth + 1, ctx, nest(where, "trap"));
        ctx.cwd = null; // trap の中の cd（DEBUG なら各コマンドの前に走る）＝作業フォルダを確定しない
        ctx.cwdChain = null;
      }
      return;
    }
    if (v === "env") {
      w.shift();
      while (w.length > 0 && (/^-/.test(w[0].v) || ASSIGN.test(w[0].lead))) {
        const x2 = w[0];
        const o = w.shift().v;
        if (ASSIGN.test(x2.lead)) {
          const name = x2.lead.slice(0, x2.lead.indexOf("=")).replace(/\+$/, "");
          if (CMD_ENV.has(name)) walk(o.slice(o.indexOf("=") + 1), depth + 1, ctx, nest(where, `${name}=`));
          continue;
        }
        let s = null;
        if (o === "-S" || o === "--split-string") {
          s = w.length > 0 ? w.shift().v : "";
        } else if (/^-S./.test(o)) {
          s = o.slice(2);
        } else if (o.startsWith("--split-string=")) {
          s = o.slice("--split-string=".length);
        }
        if (s !== null) {
          // env -S 'rm -rf x' は文字列を分割して実行する
          walk([s, ...w.map((y) => y.v)].join(" "), depth + 1, ctx, nest(where, "env -S"));
          return;
        }
        if (o === "-u" || o === "-C" || o === "-P" || o === "--unset" || o === "--chdir") {
          w.shift();
        }
      }
      continue;
    }
    if (v === "time") {
      w.shift();
      while (w.length > 0 && /^-[a-z]+$/.test(w[0].v)) {
        w.shift();
      }
      continue;
    }
    if (v === "nice") {
      w.shift();
      while (w.length > 0 && /^-/.test(w[0].v) && w[0].v !== "--") {
        const o = w.shift().v;
        if (o === "-n" || o === "--adjustment") {
          w.shift(); // -n 10・--adjustment 10（-n10・-10・--adjustment=10 は 1 語）
        }
      }
      if (w.length > 0 && w[0].v === "--") {
        w.shift();
      }
      continue;
    }
    if (v === "ionice") {
      w.shift();
      while (w.length > 0 && /^-/.test(w[0].v)) {
        if (/^-[cnpPu]$/.test(w.shift().v)) {
          w.shift();
        }
      }
      continue;
    }
    if (v === "script") {
      // macOS: script [-q…] [file [command …]] ／ Linux: script [-q] -c 'command' [file]（-qc のように束ねても -c）
      w.shift();
      while (w.length > 0 && /^-/.test(w[0].v)) {
        const o = w.shift().v;
        if ((/^-[a-zA-Z]*c$/.test(o) || o === "--command") && w.length > 0) {
          walk(w.shift().v, depth + 1, ctx, nest(where, "script -c"));
        } else if (o.startsWith("--command=")) {
          walk(o.slice("--command=".length), depth + 1, ctx, nest(where, "script -c"));
        } else if (/^-[a-zA-Z]*[FtTIOBEm]$/.test(o)) {
          w.shift();
        }
      }
      w.shift(); // 記録ファイル
      continue;
    }
    if (v === "timeout" || v === "gtimeout") {
      w.shift();
      while (w.length > 0 && /^-/.test(w[0].v) && w[0].v !== "--") {
        const o = w.shift().v;
        if (o === "-s" || o === "-k" || o === "--signal" || o === "--kill-after") {
          w.shift();
        }
      }
      if (w.length > 0 && w[0].v === "--") {
        w.shift();
      }
      w.shift(); // 時間
      continue;
    }
    break;
  }
  // 前置き（sudo・env・nohup・VAR=値・command など。if/then/{ などの予約語は除く）を外したか。rm -f 単一相対の緩和にだけ使う
  const lead = seg.words.length - w.length;
  const prefixed = lead > 0 && seg.words.slice(0, lead).some((x) => x.q || !KEYWORDS.has(x.v));
  while (w.length > 0 && !w[w.length - 1].q && (w[w.length - 1].v === "}" || w[w.length - 1].v === "]]")) {
    w.pop();
  }
  const at = where;

  // リダイレクトだけで中身を空にする: `> file`・`: > file`・`true > file`・`cat /dev/null > file`・`printf '' > file` など
  const trunc = seg.redirs.find((r) => (r.kind === ">" || r.kind === ">|") && r.word && !/^\/dev\//.test(r.word.v));
  if (trunc !== undefined && !closerOnly && truncatesOnly(w, seg)) {
    ctx.deletes.push(`truncate ${trunc.word.v}`);
    return add(ctx, { label: `> ${trunc.word.v}`, where: at, targets: [trunc.word.v], notes: ["ファイルの中身を空にする（中身を書かないリダイレクト）"] });
  }
  if (w.length === 0) {
    return;
  }
  const head = w[0];
  const cmd = base(head.v);
  const args = w.slice(1);
  if (ctx.vars !== null && VAR_RESET.has(cmd)) {
    resetVars(ctx, cmd, args, assignMode(seg, ctx));
  }
  if (SUBSCRIPT_CMDS.has(cmd)) {
    subscriptRule(cmd, args, depth, ctx, at);
  }

  // cd / pushd: 同じコマンド行の後段（git checkout <名前> の実在確認）の基準フォルダを追う。パイプの中の cd は効かない
  if (cmd === "cd" || cmd === "pushd" || cmd === "popd") {
    ctx.cwdMoved = true; // 行のどこかで作業フォルダが動く（ループで rm より後ろの cd も効きうる）
    // 追うのは「cd X && …」（&& で次へつなぐ・分岐/ループ/パイプ/& の外）だけ。その cd 先は同じ鎖の中だけ確か（walk が鎖の外で null に戻す）。
    // ;・||・|・&・if/for/while の中の cd は、失敗・不実行・サブシェルがありうる＝作業フォルダを確定しない（null）
    if (cdTracked(seg)) {
      ctx.cwd = cdTarget(cmd, args, ctx);
      ctx.cwdChain = ctx.chain;
    } else {
      ctx.cwd = null;
      ctx.cwdChain = null;
    }
    return;
  }

  // コマンド位置の語に $'…' の難読化・glob・ブレース展開 → 何が走るか測れない
  if (head.ansi && !/^[A-Za-z0-9._/+@%:=-]+$/.test(head.v)) {
    add(ctx, { label: "コマンド名が $'…'", where: at, targets: args.map((a) => a.v), notes: ["コマンド名が ANSI-C 引用で組み立てられている（復号後に空白・制御文字を含む）"] });
  }
  if (head.glob && head.v !== "[" && head.v !== "[[" && !ARRAY_ELEM.test(head.v)) {
    add(ctx, { label: "コマンド名に glob・ブレース展開", where: at, targets: args.map((a) => a.v), notes: [`${head.v}: シェルが展開した結果を実行する＝何が走るか測れない`] });
  }

  // コマンド名そのものが変数・置換 → 何が走るか測れない。
  let maybePrefix = false;
  if (head.exp || cmd === "source" || cmd === ".") {
    ctx.cwdMoved = true; // 名前が測れないコマンド・source は cd でありうる
    ctx.cwd = null;
    ctx.cwdChain = null;
  }
  if (head.exp) {
    ctx.dropVars = true; // 名前が測れないコマンドは declare・read などでありうる（walk がこの後の変数追跡を止める）
    let why = null;
    if (head.subs.length > 0) {
      if (args.length === 0 && onlyExpansion(head)) {
        why = "コマンド名が置換の結果（置換の出力をそのまま実行する）";
      } else if (!locatorHead(head, args)) {
        why = "コマンド名が置換の結果（何を実行するか測れない）";
      }
    } else if (args.length === 0 && onlyExpansion(head)) {
      why = "コマンド行が変数の中身だけ（何を実行するか測れない）";
    } else if (destrName(head.v) || scriptDanger(base(head.v))) {
      why = "変数のコマンド名が削除・巻き戻し系の名前（実行されるコマンドを測れない）";
    } else if (onlyExpansion(head)) {
      maybePrefix = true; // $SUDO rm -rf x のように前置きかもしれない＝残りも同じ規則で読む
    }
    if (why !== null) {
      add(ctx, { label: "コマンド名が変数展開", where: at, targets: args.map((a) => a.v), notes: [why] });
    }
  }
  // x='rm -rf'; $x y: 同じコマンド内で確実に代入した値なら、引用なしの $x は単語分割した語として読む
  // 引用つきの "$x"（第5R B3）は 1 語のまま＝値が空白・glob・展開・引用文字を含まない確定値（rm・/bin/rm・git）の時だけ埋める
  const known = maybePrefix && head.refs.length === 1 && ctx.vars !== null ? ctx.vars.get(head.refs[0].name) : undefined;
  const knownOk = known !== undefined && typeof known.value === "string" && (known.chain === null || known.chain === ctx.chain) && known.value.trim() !== "" && (!head.refs[0].q || PLAIN_VALUE.test(known.value));
  if (knownOk) {
    const words = known.value.trim().split(/\s+/).map((t) => ({ ...newWord(), v: t, lit: t, unq: t, glob: /[*?[]/.test(t) }));
    analyze({ words: words.concat(args), redirs: seg.redirs, piped: seg.piped, pd: seg.pd }, depth + 1, ctx, nest(at, `${head.v}（同じコマンド内の代入）`));
  } else if (maybePrefix && args.length > 0) {
    // 値が追えない変数頭でも、第 1 引数がコード引数（-c・-e・--eval 等）なら中身を名前不明のまま読む（第5R B4・止める方向だけ）
    unknownHeadRule(head, args, seg, depth, ctx, at);
    analyze({ words: args, redirs: [], piped: seg.piped, pd: seg.pd }, depth + 1, ctx, nest(at, head.v));
  }

  // どのコマンドでも: 引数の中の「sh -c '…'」は中身を読む（知らない包み: nice・chronic など）。
  // 中のコマンドを丸ごと読む規則があるもの（docker・kubectl・find・xargs・npx 等・変数の前置き）は二重に数えないよう飛ばす
  for (let k = 0; k + 2 < w.length; k += 1) {
    if (k === 0 && (SHELLS.has(cmd) || NESTED_RULES.has(cmd) || maybePrefix)) {
      break; // 先頭がシェル・入れ子を読む規則のあるコマンドなら下で読む
    }
    if (SHELLS.has(base(w[k].v)) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w[k + 1].v)) {
      const j = shCodeIndex(w, k + 1);
      if (j < 0) continue;
      if (w[j].exp) {
        add(ctx, { label: `${base(w[k].v)} -c`, where: at, notes: ["-c の中身が変数・置換を含み、測れない"] });
      }
      walk(w[j].v, depth + 1, ctx, nest(at, `${base(w[k].v)} -c`));
    }
  }

  // 起動子越し: npx / npm exec / bunx / pnpm dlx / yarn dlx / uv run / poetry run / pipx run / pdm run など
  const launched = launcherRest(cmd, args, depth, ctx, at);
  if (launched !== null) {
    if (launched.words.length > 0) {
      analyze({ words: launched.words, redirs: seg.redirs, piped: seg.piped, pd: seg.pd }, depth + 1, ctx, nest(at, launched.label));
    }
    return;
  }

  if (cmd === "rm") {
    return rmRule(args, sudo, ctx, at, depth === 0 && !prefixed);
  }
  if (RM_LIKE.has(cmd)) {
    const targets = args.filter((a) => !a.v.startsWith("-")).map((a) => a.v);
    targets.forEach((t) => ctx.deletes.push(`rm ${t}`));
    return add(ctx, { label: cmd, where: at, targets, notes: ["rm -rf と同じ（再帰・強制で消す）"] });
  }
  if (cmd === "unlink" || cmd === "shred" || cmd === "srm" || cmd === "truncate") {
    const targets = args.filter((a) => !a.v.startsWith("-")).map((a) => a.v);
    targets.forEach((t) => ctx.deletes.push(`${cmd} ${t}`));
    return add(ctx, { label: cmd, where: at, targets, notes: cmd === "truncate" ? ["ファイルの中身を切り詰める"] : ["ファイルを消す（ゴミ箱を経由しない）"] });
  }
  if (cmd === "git") {
    return gitRule(args, depth, ctx, at);
  }
  if (cmd === "find") {
    return findRule(args, depth, ctx, at);
  }
  if (cmd === "xargs" || cmd === "parallel") {
    return xargsRule(cmd, args, depth, ctx, at);
  }
  if (cmd === "rsync") {
    const del = args.find((a) => /^--(del|delete|delete-[a-z-]+|remove-source-files)$/.test(a.v));
    if (del !== undefined) {
      const pos = args.filter((a) => !a.v.startsWith("-")).map((a) => a.v);
      return add(ctx, { label: `rsync ${del.v}`, where: at, targets: pos.slice(-1), notes: ["コピー先にしか無いファイルを消す"] });
    }
    return;
  }
  if (SHELLS.has(cmd)) {
    return shellRule(cmd, args, seg, depth, ctx, at);
  }
  if (cmd === "eval") {
    if (args.length === 1 && args[0].subs.length === 1 && onlyExpansion(args[0]) && envSetup(args[0].subs[0])) {
      return; // eval "$(pyenv init -)" など: 環境設定ツール自身の出力を読み込む定型（置換の中身は walk 済み）
    }
    if (args.some((a) => a.exp)) {
      add(ctx, { label: "eval", where: at, targets: [], notes: ["eval の中身が変数・置換で、測れない"] });
    }
    walk(wordsText(args), depth + 1, ctx, nest(at, "eval"));
    ctx.cwd = null; // eval の中の cd は今のシェルに効く＝作業フォルダを確定しない
    ctx.cwdChain = null;
    return;
  }
  if (cmd === "source" || cmd === ".") {
    return sourceRule(cmd, args, seg, depth, ctx, at);
  }
  if (cmd === "ssh" || cmd === "autossh") {
    return sshRule(args, depth, ctx, at);
  }
  if (INTERPRETER.test(cmd)) {
    return interpreterRule(cmd, args, seg, depth, ctx, at);
  }
  if (cmd === "awk" || cmd === "gawk" || cmd === "mawk" || cmd === "nawk") {
    return awkRule(cmd, args, depth, ctx, at);
  }
  if (cmd === "sed" || cmd === "gsed") {
    return sedRule(cmd, args, ctx, at);
  }
  if (cmd === "dd" && args.some((a) => a.v.startsWith("of="))) {
    return add(ctx, { label: "dd of=", where: at, targets: args.filter((a) => a.v.startsWith("of=")).map((a) => a.v.slice(3)), notes: ["書き込み先を上書きする"] });
  }
  if (cmd === "cp") {
    const pos = args.filter((a) => !a.v.startsWith("-"));
    if (pos.length >= 2 && pos[0].v === "/dev/null") {
      return add(ctx, { label: "cp /dev/null", where: at, targets: pos.slice(1).map((a) => a.v), notes: ["ファイルの中身を空にする"] });
    }
    return;
  }
  if (cmd === "mv") {
    const pos = args.filter((a) => !a.v.startsWith("-"));
    if (pos.length >= 2 && pos[pos.length - 1].v === "/dev/null") {
      return add(ctx, { label: "mv … /dev/null", where: at, targets: pos.slice(0, -1).map((a) => a.v), notes: ["移動先が /dev/null＝消える"] });
    }
    return;
  }
  if (/^(mkfs|newfs)/.test(cmd) || (cmd === "diskutil" && args.length > 0 && /^(erase|zero|secureErase|partitionDisk|reformat)/i.test(args[0].v)) || (cmd === "diskutil" && args.length > 1 && args[0].v === "apfs" && /^delete/i.test(args[1].v))) {
    return add(ctx, { label: `${cmd} ${args.slice(0, 2).map((a) => a.v).join(" ")}`.trim(), where: at, notes: ["ディスク・ボリュームを消す"] });
  }
  if (cmd === "crontab" && (args.some((a) => /^-[a-zA-Z]*r/.test(a.v)) || args.some((a) => a.v === "/dev/null"))) {
    return add(ctx, { label: args.some((a) => a.v === "/dev/null") ? "crontab /dev/null" : "crontab -r", where: at, notes: ["crontab を丸ごと消す"] });
  }
  if (cmd === "docker" || cmd === "podman" || cmd === "docker-compose" || cmd === "podman-compose") {
    return dockerRule(cmd, args, depth, ctx, at);
  }
  if (cmd === "kubectl" || cmd === "oc") {
    return kubectlRule(cmd, args, depth, ctx, at);
  }
  if (cmd === "terraform" || cmd === "tofu") {
    const pos = args.filter((a) => !a.v.startsWith("-"));
    if (pos.length > 0 && (pos[0].v === "destroy" || (pos[0].v === "apply" && args.some((a) => /^-destroy(=true)?$/.test(a.v))))) {
      return add(ctx, { label: `${cmd} ${pos[0].v === "destroy" ? "destroy" : "apply -destroy"}`, where: at, notes: ["管理しているインフラを破棄する（外部サービス）"] });
    }
    return;
  }
  if (cmd === "aws") {
    const k = args.findIndex((a) => a.v === "s3");
    if (k >= 0 && args[k + 1] !== undefined && args[k + 1].v === "rm" && args.some((a) => a.v === "--recursive")) {
      return add(ctx, { label: "aws s3 rm --recursive", where: at, targets: args.slice(k + 2).filter((a) => !a.v.startsWith("-")).map((a) => a.v), notes: ["S3 の接頭辞の下を全部消す（外部サービス）"] });
    }
    return;
  }
  if (cmd === "gh") {
    const k = args.findIndex((a) => a.v === "repo");
    if (k >= 0 && args[k + 1] !== undefined && args[k + 1].v === "delete") {
      return add(ctx, { label: "gh repo delete", where: at, targets: args.slice(k + 2).filter((a) => !a.v.startsWith("-")).map((a) => a.v), notes: ["GitHub のリポジトリを消す（外部サービス）"] });
    }
    return;
  }
  if (DB_CLI.test(cmd)) {
    const texts = args.map((a) => a.v).concat(seg.redirs.map((r) => (r.kind === "<<<" ? r.word.v : r.body ?? "")));
    const hit = texts.find((t) => DB_DROP.test(t));
    if (hit !== undefined) {
      return add(ctx, { label: `${cmd} DROP`, where: at, notes: [`SQL の「${DB_DROP.exec(hit)[0]}」＝テーブル・データベースを消す`] });
    }
    return;
  }
  if (MIGRATE_TOOLS.has(cmd)) {
    const down = args.find((a) => MIGRATE_DOWN.test(a.v));
    if (down !== undefined) {
      return add(ctx, { label: `${cmd} … ${down.v}`, where: at, notes: ["マイグレーションの巻き戻し・作り直し（データが消えうる）"] });
    }
    return;
  }
  if (/^(npm|pnpm|yarn|bun|make|just|task)$/.test(cmd)) {
    const target = args.find((a) => scriptDanger(a.v));
    if (target !== undefined) {
      add(ctx, { label: `${cmd} … ${target.v}`, where: at, notes: ["名前が巻き戻し・消去系のタスク。中身は読んでいない"] });
    }
    return;
  }
  if (scriptDanger(cmd)) {
    add(ctx, { label: head.v, where: at, notes: ["名前が巻き戻し・消去系のスクリプト。中身は読んでいない"] });
  }
}

/** unset 'a[$(cmd)]'・printf -v 'a[$(cmd)]'・[[ -v 'a[$(cmd)]' ]] など: 添字は算術として展開され、中の $( ) が走る。 */
function subscriptRule(cmd, args, depth, ctx, at) {
  let cand = args;
  if (cmd === "printf") {
    cand = [];
    args.forEach((a, k) => {
      if (a.v === "-v" && args[k + 1] !== undefined) cand.push(args[k + 1]);
      else if (a.v.startsWith("-v") && a.v.length > 2) cand.push({ ...a, v: a.v.slice(2) });
    });
  } else if (cmd === "test" || cmd === "[" || cmd === "[[") {
    cand = args.filter((_a, k) => k > 0 && args[k - 1].v === "-v");
  }
  for (const a of cand) {
    if (!a.v.includes("[") || !SUBSCRIPT_SUB.test(a.v)) continue;
    add(ctx, { label: `${cmd} の添字内のコマンド置換`, where: at, targets: [a.v], notes: ["配列の添字 a[…] は算術として展開される＝中の $( )・` ` が走る（測れない）"] });
    if (a.subs.length === 0) {
      // 引用の中の文字どおりの $( ) も、添字の評価で実行される＝中身を同じ規則で読む
      for (const sub of extractSubs(a.v)) walk(sub, depth + 1, ctx, nest(at, `${cmd} の添字`));
    }
  }
}

function nest(at, label) {
  return at ? `${at} › ${label}` : `${label} の中`;
}

/** 中身を書かずに出力先を空にするコマンドか（`> f` の前の部分）。 */
function truncatesOnly(w, seg) {
  if (w.length === 0) return true;
  const c = base(w[0].v);
  const rest = w.slice(1);
  if (w.length === 1 && !w[0].q && (c === ":" || c === "true")) return true;
  if (c === "cat") {
    if (rest.length === 0) {
      return !seg.piped && !seg.redirs.some((r) => r.kind === "<" || r.kind === "<<" || r.kind === "<<-" || r.kind === "<<<" || r.kind === "<>");
    }
    return rest.every((a) => a.v === "/dev/null");
  }
  if (c === "printf") return rest.length === 1 && rest[0].v === "" && !rest[0].exp;
  if (c === "echo") return rest.every((a) => !a.exp && (a.v === "" || a.v === "-n")) && !seg.piped;
  return false;
}

/** cd を作業フォルダとして追ってよい形か: && で次へつなぎ、前が || でなく、パイプ・分岐・ループの外。 */
function cdTracked(seg) {
  return seg.next === "&&" && !seg.piped && seg.ctl === 0 && seg.contNL !== true && seg.prev !== "||" && seg.prev !== "|" && seg.prev !== "|&" && seg.prev !== "&";
}

/** cd / pushd / popd の後の作業フォルダ。確かめられない（変数・~・cd -・引数なし・CDPATH を代入した行の相対）なら null。 */
function cdTarget(cmd, args, ctx) {
  const cwd = ctx.cwd;
  if (cmd === "popd") return null;
  const pos = args.filter((a) => !/^-[LPe@]+$/.test(a.v) && a.v !== "--");
  if (pos.length === 0) return null; // cd だけ＝ホーム
  const t = pos[0];
  const v = resolveWord(t, ctx); // cd "$S"（S を同じコマンド内で確実に代入）も追う
  if (v === null || t.glob || t.tilde || v === "-" || /^[+-]\d+$/.test(v) || (!t.q && /\s/.test(v))) return null;
  if (!v.startsWith("/") && ctx.cdpath) return null; // CDPATH があると相対の cd 先はそこから探される
  const next = v.startsWith("/") ? v : cwd === null ? null : joinPath(cwd, v);
  return next !== null && next.length > 4096 ? null : next; // PATH_MAX を超える連鎖は確かめられない扱い（線形に保つ）
}

// 置換をコマンド名にする定型のうち、場所を探すだけのもの（which・brew --prefix・cat 設定ファイル など）
function locatorHead(head, args) {
  if (head.subs.length !== 1) return false;
  if (args.some((a) => FLAG_DESTR.test(a.v))) return false;
  if (destrName(head.lit) || scriptDanger(base(head.v))) return false;
  const segs = split(lex(head.subs[0]));
  if (segs.length !== 1) return false;
  const ws = segs[0].words.map((x) => x.v);
  if (ws.length === 0 || segs[0].words.some((x) => x.exp)) return false;
  const c = base(ws[0]);
  const a1 = ws[1] ?? "";
  const finder = c === "which" || (c === "command" && /^-[vV]$/.test(a1)) || (c === "type" && /^-[pP]+$/.test(a1)) || (c === "xcrun" && /^(-f|--find)$/.test(a1)) || (/^(pyenv|rbenv|nodenv|asdf|mise|rustup)$/.test(c) && /^(which|where)$/.test(a1));
  if (finder) {
    return !ws.slice(1).some((x) => destrName(x)); // $(which rm) x は止める
  }
  return (c === "brew" && a1 === "--prefix") || (c === "npm" && /^(bin|prefix|root)$/.test(a1)) || (/^(pyenv|rbenv|nodenv|asdf|mise|rustup)$/.test(c) && /^(prefix|root)$/.test(a1)) || (c === "go" && a1 === "env") || (c === "git" && a1 === "rev-parse") || c === "realpath" || c === "readlink" || c === "dirname" || (c === "xcode-select" && /^(-p|--print-path)$/.test(a1)) || (c === "cat" && ws.length === 2);
}

// eval "$(…)" で読み込む定型の環境設定ツール
function envSetup(sub) {
  const segs = split(lex(sub));
  if (segs.length !== 1) return false;
  const ws = segs[0].words.map((x) => x.v);
  const c = base(ws[0] ?? "");
  const a1 = ws[1] ?? "";
  return (/^(pyenv|rbenv|nodenv|jenv|goenv|plenv|zoxide|starship|mise|rtx|fnm|direnv|thefuck)$/.test(c) && /^(init|activate|env|hook|export|--alias)$/.test(a1)) || c === "ssh-agent" || (c === "opam" && a1 === "env") || (c === "brew" && a1 === "shellenv") || (c === "conda" && /^shell\./.test(a1)) || c === "keychain" || c === "gpg-agent" || (c === "luarocks" && a1 === "path") || (c === "dircolors");
}

// ---- 起動子（npx・uv run など） ---------------------------------------------

const LAUNCH_VALUE_OPTS = new Set(["-p", "--package", "--with", "--python", "--project", "--directory", "--env-file", "--extra", "--group", "--spec", "--from", "--cwd", "-w", "--workspace", "--filter", "-F"]);

/** 起動子なら { words: 実行される側の語, label } を返す。違えば null。 */
function launcherRest(cmd, args, depth, ctx, at) {
  let k;
  let label;
  if (cmd === "npx" || cmd === "bunx" || cmd === "pnpx" || cmd === "uvx") {
    k = 0;
    label = cmd;
  } else if ((cmd === "npm" && args.length > 0 && (args[0].v === "exec" || args[0].v === "x")) || ((cmd === "pnpm" || cmd === "yarn") && args.length > 0 && (args[0].v === "dlx" || args[0].v === "exec")) || (cmd === "bun" && args.length > 0 && args[0].v === "x")) {
    k = 1;
    label = `${cmd} ${args[0].v}`;
  } else if (/^(uv|poetry|pipx|pdm|hatch|rye)$/.test(cmd) && args.length > 0 && args[0].v === "run") {
    k = 1;
    label = `${cmd} run`;
  } else {
    return null;
  }
  while (k < args.length && args[k].v.startsWith("-") && args[k].v !== "--") {
    const o = args[k].v;
    if ((o === "-c" || o === "--call") && args[k + 1] !== undefined) {
      // npx -c '…' はシェル文字列を実行する
      walk(args[k + 1].v, depth + 1, ctx, nest(at, `${cmd} -c`));
      k += 2;
      continue;
    }
    k += LAUNCH_VALUE_OPTS.has(o) ? 2 : 1;
  }
  if (k < args.length && args[k].v === "--") {
    k += 1;
  }
  return { words: args.slice(k), label };
}

// ---- docker / kubectl ----------------------------------------------------------

const DOCKER_GLOBAL_VALUED = new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]);
const DOCKER_EXEC_VALUED = new Set(["-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "--detach-keys", "--index"]);
const DOCKER_RUN_VALUED = new Set(["--add-host", "--annotation", "-a", "--attach", "--blkio-weight", "--cap-add", "--cap-drop", "--cgroup-parent", "--cgroupns", "--cidfile", "--cpu-period", "--cpu-quota", "--cpus", "--cpuset-cpus", "--cpuset-mems", "--cpu-shares", "-c", "--device", "--dns", "--dns-option", "--dns-search", "--domainname", "--entrypoint", "-e", "--env", "--env-file", "--expose", "--gpus", "--group-add", "--health-cmd", "--health-interval", "--health-retries", "--health-start-period", "--health-timeout", "-h", "--hostname", "--ip", "--ip6", "--ipc", "--isolation", "-l", "--label", "--label-file", "--link", "--log-driver", "--log-opt", "--mac-address", "-m", "--memory", "--memory-reservation", "--memory-swap", "--mount", "--name", "--network", "--net", "--network-alias", "--pid", "--platform", "--pids-limit", "-p", "--publish", "--pull", "--restart", "--runtime", "--security-opt", "--shm-size", "--stop-signal", "--stop-timeout", "--storage-opt", "--sysctl", "--tmpfs", "--ulimit", "-u", "--user", "--userns", "--uts", "-v", "--volume", "--volume-driver", "--volumes-from", "-w", "--workdir", "--detach-keys", "--service-ports", "--project-name"]);

/** オプション（値つきは valued）を飛ばした位置。 */
function skipOpts(args, k, valued) {
  while (k < args.length && args[k].v.startsWith("-") && args[k].v !== "--") {
    k += valued.has(args[k].v) ? 2 : 1;
  }
  if (k < args.length && args[k].v === "--") k += 1;
  return k;
}

function dockerRule(cmd, args, depth, ctx, at) {
  const v = args.map((a) => a.v);
  const s = skipOpts(args, 0, DOCKER_GLOBAL_VALUED);
  const isCompose = cmd.endsWith("-compose") || v[s] === "compose";
  const vflag = (xs) => xs.some((a) => a === "-v" || a === "--volumes" || (/^-[a-zA-Z]+$/.test(a) && a.includes("v")));
  const inside = (words, label) => {
    if (words.length === 0) return;
    withNote(ctx, "コンテナの中で実行される（-v で手元のフォルダを見せていれば手元が消える）", () => analyze({ words, redirs: [], piped: false, pd: 0 }, depth + 1, ctx, nest(at, label)));
  };
  if (isCompose) {
    let c = cmd.endsWith("-compose") ? 0 : s + 1;
    c = skipOpts(args, c, new Set(["-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--profile", "--ansi", "--parallel"]));
    const csub = v[c];
    if (csub === "down" && vflag(v.slice(c + 1))) {
      return add(ctx, { label: `${cmd}${cmd.endsWith("-compose") ? "" : " compose"} down -v`, where: at, notes: ["名前付きボリューム（DB などのデータ）も消す"] });
    }
    if (csub === "rm" && vflag(v.slice(c + 1))) {
      return add(ctx, { label: `${cmd}${cmd.endsWith("-compose") ? "" : " compose"} rm -v`, where: at, notes: ["サービスのコンテナと匿名ボリュームを消す"] });
    }
    if (csub === "exec" || csub === "run") {
      const k = skipOpts(args, c + 1, csub === "exec" ? DOCKER_EXEC_VALUED : DOCKER_RUN_VALUED);
      inside(args.slice(k + 1), `compose ${csub} ${v[k] ?? ""}`.trim());
    }
    return;
  }
  const sub = v[s];
  const sub2 = v[s + 1];
  if (sub === "exec" || (sub === "container" && sub2 === "exec")) {
    const k = skipOpts(args, s + (sub === "exec" ? 1 : 2), DOCKER_EXEC_VALUED);
    return inside(args.slice(k + 1), `${cmd} exec ${v[k] ?? ""}`.trim());
  }
  if (sub === "run" || (sub === "container" && sub2 === "run")) {
    let k = s + (sub === "run" ? 1 : 2);
    let entry = null;
    while (k < args.length && v[k].startsWith("-") && v[k] !== "--") {
      if (v[k] === "--entrypoint") entry = args[k + 1] ?? null;
      else if (v[k].startsWith("--entrypoint=")) entry = { ...args[k], v: v[k].slice("--entrypoint=".length) };
      k += DOCKER_RUN_VALUED.has(v[k]) ? 2 : 1;
    }
    if (v[k] === "--") k += 1;
    const words = (entry !== null ? [entry] : []).concat(args.slice(k + 1));
    return inside(words, `${cmd} run ${v[k] ?? ""}`.trim());
  }
  if (v.length > s + 1 && ((sub === "volume" && /^(rm|prune)$/.test(sub2)) || (sub === "system" && sub2 === "prune") || (sub === "container" && sub2 === "prune"))) {
    return add(ctx, { label: `${cmd} ${sub} ${sub2}`, where: at, notes: ["コンテナのデータを消す"] });
  }
  const rmAt = sub === "rm" ? s + 1 : sub === "container" && sub2 === "rm" ? s + 2 : -1;
  if (rmAt > 0 && vflag(v.slice(rmAt))) {
    return add(ctx, { label: `${cmd} rm -v`, where: at, targets: v.slice(rmAt).filter((a) => !a.startsWith("-")), notes: ["コンテナの匿名ボリュームも消す"] });
  }
}

function kubectlRule(cmd, args, depth, ctx, at) {
  const valued = new Set(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server", "-c", "--container", "-f", "--filename", "-l", "--selector"]);
  const k = skipOpts(args, 0, valued);
  const sub = args[k] !== undefined ? args[k].v : "";
  if (sub === "delete") {
    return add(ctx, { label: `${cmd} delete`, where: at, targets: args.slice(k + 1).filter((a) => !a.v.startsWith("-")).map((a) => a.v), notes: ["クラスタのリソースを消す（外部サービス）"] });
  }
  if (sub === "exec") {
    const dd = args.findIndex((a, j) => j > k && a.v === "--");
    let words;
    if (dd >= 0) {
      words = args.slice(dd + 1);
    } else {
      const p = skipOpts(args, k + 1, valued);
      words = args.slice(p + 1);
    }
    if (words.length > 0) {
      withNote(ctx, "Pod の中で実行される", () => analyze({ words, redirs: [], piped: false, pd: 0 }, depth + 1, ctx, nest(at, `${cmd} exec`)));
    }
  }
}

// ---- rm --------------------------------------------------------------------

// rm -f 単一相対の緩和: フラグは -f/-v/-i の組合せ（1 語に束ねても別々でも）と --force だけ。-r/-R/-d/--recursive 等は不可
function softFlags(fv) {
  return fv.every((f) => f === "--force" || /^-[fvi]+$/.test(f));
}

// 引数がどれも文字どおり: 変数・置換・glob・ブレース・~・$'…' を含まない（引用はリテラル扱い）。
// extglob（!( )・@( )・+( )・?( )・*( )）とヒストリ展開の ! も含まない（( ) と ! を丸ごと外す）
function literalArg(a) {
  return !a.exp && !a.glob && !a.tilde && !a.ansi && a.subs.length === 0 && !/[*?[\]{}~$`\\\x00-\x1f]/.test(a.v) && !/[!()]/.test(a.v);
}

// 対象: 相対（/ で始まらない）・.. を含まない・空でない・- で始まらない・危険名（先頭ドットを含む）に当たらない
function softTarget(t) {
  return t.v !== "" && !t.v.startsWith("/") && !t.v.startsWith("-") && !t.v.includes("..") && dangerOf(t) === null;
}

// GNU rm の長オプション（正式名）
const RM_LONG = ["--force", "--interactive", "--one-file-system", "--no-preserve-root", "--preserve-root", "--recursive", "--dir", "--verbose", "--help", "--version"];

/** rm の長オプションを正式名へ（一意な接頭辞）。曖昧・未知は null。 */
function rmLong(f) {
  const eq = f.indexOf("=");
  const name = eq < 0 ? f : f.slice(0, eq);
  if (RM_LONG.includes(name)) return f;
  const hits = RM_LONG.filter((t) => t.startsWith(name));
  return hits.length === 1 ? hits[0] + (eq < 0 ? "" : f.slice(eq)) : null;
}

function rmRule(args0, sudo, ctx, at, bare = false) {
  // 対象の $X は、同じコマンド内で確実に代入された文字どおりの値なら埋める（S=/private/tmp/…/scratchpad; rm -rf "$S/x"）
  const resolvedFrom = [];
  const args = args0.map((a) => {
    if (!a.exp) return a;
    const r = resolveWord(a, ctx);
    if (r === null) return a;
    resolvedFrom.push(`${a.v}→${r}`);
    return { ...a, v: r, exp: false };
  });
  const flags = [];
  const targets = [];
  let ended = false;
  if (args.length === 0) {
    return; // 引数なしの rm は使い方を出すだけ
  }
  for (const a of args) {
    if (!ended && a.v === "--") {
      ended = true;
      continue;
    }
    if (!ended && a.v.startsWith("-") && a.v.length > 1) {
      flags.push(a);
    } else {
      targets.push(a);
    }
  }
  // GNU rm は長オプションの一意な接頭辞を受け付ける（--rec＝--recursive）。正式名へ直し、曖昧・未知の -- フラグは止める
  const unknownLong = [];
  for (let k = 0; k < flags.length; k += 1) {
    const f = flags[k];
    if (f.exp || !f.v.startsWith("--")) continue;
    const full = rmLong(f.v);
    if (full === null) unknownLong.push(f.v);
    else flags[k] = { ...f, v: full };
  }
  // --help/--version は対象が無い時だけ通す（BSD rm は最初のオペランドでオプション解析をやめる＝rm -rf x --help は x を消す）
  if (unknownLong.length === 0 && targets.length === 0 && flags.some((f) => !f.exp && (f.v === "--help" || f.v === "--version"))) {
    return;
  }
  const fv = flags.map((f) => f.v);
  const recursive = fv.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
  const force = fv.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
  const notes = [];
  const reasons = [];
  if (recursive) reasons.push("再帰");
  if (force) reasons.push("強制");
  if (targets.length > 1) reasons.push("複数対象");
  if (targets.length === 0) {
    reasons.push("対象なし");
    notes.push("対象が見えない（xargs・置換経由など）");
  }
  if (unknownLong.length > 0) {
    reasons.push("不明な長オプション");
    notes.push(`曖昧・未知の長オプション（何を意味するか確定できない）: ${unknownLong.join(" ")}`);
  }
  const expFlags = flags.filter((f) => f.exp);
  if (expFlags.length > 0) {
    reasons.push("変数展開");
    notes.push(`フラグが変数展開を含み、-rf などになりうる（測れない）: ${expFlags.map((f) => f.v).join(" ")}`);
  }
  if (flags.some((f) => f.v === "--help" || f.v === "--version")) {
    notes.push("--help/--version は対象の後ろでは効かない（BSD rm は対象を消す）");
  }
  const unmeasured = targets.filter((t) => t.exp);
  const globbed = targets.filter((t) => t.glob);
  if (unmeasured.length > 0) {
    reasons.push("変数展開");
    notes.push(`変数・置換を含む対象は測れない: ${unmeasured.map((t) => t.v).join(" ")}`);
  }
  if (globbed.length > 0) {
    reasons.push("glob");
    notes.push(`glob・ブレース展開の対象は何件に広がるか測っていない: ${globbed.map((t) => t.v).join(" ")}`);
  }
  for (const t of targets) {
    const d = dangerOf(t);
    if (d !== null) {
      reasons.push("危険名");
      notes.push(`${t.v}: ${d}`);
    }
  }
  if (sudo) reasons.push("sudo");
  targets.forEach((t) => ctx.deletes.push(`rm ${t.v}`));
  if (reasons.length === 0) {
    return; // 単一ファイル・フラグなし・glob/変数なし・危険名なし
  }
  const label = `rm ${fv.join(" ")}`.trim();
  // 緩和（設計変更）: 単一の相対ファイルへの rm -f は通す＝損害が小さく、git 管理下なら戻せる。
  // 条件は全部 AND（どれか 1 つでも外れたら従来どおり HOLD）。cd の有無は行全体を見てから classify の最後で確かめる
  if (bare && targets.length === 1 && softFlags(fv) && args0.every(literalArg) && targets.every(softTarget)) {
    ctx.softRm.push({ label, where: at, targets: targets.map((t) => t.v), notes: ["単一の相対ファイルへの rm -f は通す設計だが、同じ行で作業フォルダが動く（cd・pushd・popd・source・名前が測れないコマンド）"] });
    return;
  }
  // /tmp 例外: 理由が「再帰・強制・複数対象・危険名」だけで、対象が全て /tmp 配下の確定した絶対パス
  const onlyBenign = reasons.every((r) => r === "再帰" || r === "強制" || r === "複数対象" || r === "危険名");
  if (onlyBenign && targets.length > 0 && targets.every((t) => isTmpLiteral(t))) {
    for (const t of targets) {
      ctx.tmpChecks.push({ path: t.v, label, where: at });
    }
    return;
  }
  if (resolvedFrom.length > 0) {
    notes.push(`変数は同じコマンド内の代入から読んだ: ${resolvedFrom.slice(0, 3).join(" ")}`);
  }
  const rel = targets.some((t) => !t.v.startsWith("/") && !t.tilde);
  if (rel) {
    notes.push("相対パスは作業フォルダ（前段の cd 先）基準。実在・件数は測っていない");
  }
  add(ctx, { label, where: at, targets: targets.map((t) => t.v), notes });
}

function isTmpLiteral(t) {
  if (t.exp || t.glob || t.tilde || t.q && /[*?[]/.test(t.v)) {
    return false;
  }
  const p = t.v;
  if (!p.startsWith("/") || p.endsWith("/") || p.includes("//")) {
    return false;
  }
  const parts = p.split("/").slice(1);
  if (parts.some((s) => s === "" || s === "." || s === "..")) {
    return false;
  }
  if (parts[0] === "tmp") {
    return parts.length >= 2;
  }
  if (parts[0] === "private" && parts[1] === "tmp") {
    return parts.length >= 3;
  }
  return false;
}

/** 消すと困る名前・広すぎる範囲を返す（静的）。 */
export function dangerOf(t) {
  const p = t.v;
  if (t.tilde && (p === "~" || p === "~/")) return "ホームフォルダ全体";
  if (p === "/" || p === "/*") return "ルート";
  if (p === "." || p === ".." || p === "./" || p === "../" || p === "*" || p === ".*") return "今いるフォルダ全体";
  if (/^\/(Users|home)\/[^/]+\/?$/.test(p) || /^\/(Users|home|System|Library|Applications|private|var|etc|usr|bin|opt)\/?$/.test(p)) return "システム・ホーム直下";
  const parts = p.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
  const hits = [];
  for (const s of parts) {
    if (/^\.(git|env(\..*)?|ssh|gnupg|aws|config|claude|astro|next|nuxt|svelte-kit|cache|local|npmrc|netrc|docker|kube)$/i.test(s)) hits.push(s);
    else if (s === "node_modules") hits.push(s);
    else if (/session|auth|token|cookie|credential|secret|keychain|password|login/i.test(s)) hits.push(s);
    else if (/\.(sqlite3?|db|db-wal|db-shm|db-journal|kdbx|pem|key|p12|pfx|jks|keystore)$/i.test(s)) hits.push(s);
    else if (/^id_|^known_hosts|^authorized_keys|tfstate|^wallet\.dat$|^master\.key$/i.test(s)) hits.push(s); // 鍵・状態ファイル（APFS は大文字小文字を区別しない）
    else if (/^\.[^.]/.test(s)) hits.push(s);
  }
  if (hits.length === 0) return null;
  return `消すと困る名前（${[...new Set(hits)].join(", ")}）＝ログイン状態・DB・設定・履歴の同居がありうる`;
}

// ---- git -------------------------------------------------------------------

// git は長オプションの「一意な接頭辞」を受け付ける（--har = --hard）。判定に使う長オプションだけを並べ、
// 一意に解ければ正式名へ直す。表は git の部分集合なので、git で一意な接頭辞はここでも一意。
// 各表は破壊系を先頭に並べる（曖昧な接頭辞は先頭へ倒す）。
const GIT_LONG = {
  reset: ["--hard", "--soft", "--mixed", "--merge", "--keep"],
  clean: ["--force", "--dry-run", "--interactive"],
  push: ["--force", "--force-with-lease", "--force-if-includes", "--delete", "--prune", "--mirror", "--follow-tags", "--tags", "--set-upstream", "--no-verify"],
  checkout: ["--force", "--pathspec-from-file", "--orphan", "--track", "--detach", "--merge", "--patch", "--ours", "--theirs"],
  restore: ["--pathspec-from-file", "--source", "--staged", "--worktree"],
  switch: ["--discard-changes", "--force", "--force-create", "--create", "--detach"],
  branch: ["--delete", "--force", "--move", "--copy", "--list"],
  rm: ["--force", "--cached"],
  gc: ["--prune", "--aggressive"],
  prune: ["--expire", "--dry-run"],
  tag: ["--delete", "--force", "--list"],
  worktree: ["--force"],
  stash: ["--quiet"],
};

function expandLong(sub, a) {
  const table = GIT_LONG[sub];
  if (table === undefined || !a.startsWith("--") || a === "--") return a;
  const eq = a.indexOf("=");
  const name = eq < 0 ? a : a.slice(0, eq);
  if (table.includes(name)) return a;
  const hits = table.filter((t) => t.startsWith(name));
  // 曖昧なら表の先頭（破壊系を先に並べてある）へ倒す。git 側では曖昧＝エラーなので、止めても害はない
  return hits.length >= 1 ? hits[0] + (eq < 0 ? "" : a.slice(eq)) : a;
}

const GIT_REV_LIKE = /[~^]|@\{|^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$|^[0-9a-f]{7,40}$/;
// 消す・巻き戻す・上書きしうるサブコマンド（引数に変数があれば測れない）
const GIT_DESTR_SUBS = new Set(["reset", "push", "checkout", "clean", "branch", "switch", "restore", "tag", "stash", "rm", "update-ref", "worktree", "gc", "reflog", "prune", "filter-branch", "filter-repo", "submodule"]);
// 値（説明文・名前）を取るオプション: その値の変数は判定に関わらない
const GIT_TEXT_OPTS = new Set(["-m", "--message", "-F", "--file", "--author", "--date", "-b", "-c", "--orphan", "--create"]);
// 値が命令として実行される git の設定キー（-c KEY=VAL・git config KEY VAL）
const GIT_CMD_KEY = /^(?:core\.(?:sshcommand|pager|editor|askpass|fsmonitor|hookspath|gitproxy)|sequence\.editor|diff\.external|gpg\.(?:[a-z0-9]+\.)?program|credential\.helper|pager\.[^.]+|interactive\.difffilter|uploadpack\.packobjectshook|(?:diff|merge|filter|difftool|mergetool)\..+\.(?:command|cmd|textconv|driver|clean|smudge|process|path))$/i;

/**
 * 語が「git がコミット ID・ブランチ名だけを出す置換」か: $(git rev-parse HEAD)・$(git branch --show-current) など。
 * 出力はフラグ・pathspec にならないので、I4/C4 の「変数」に数えない。
 */
function refGenerator(w) {
  if (!onlyExpansion(w) || w.subs.length !== 1 || w.refs.length > 0) return false;
  const segs = split(lex(w.subs[0]));
  if (segs.length !== 1) return false;
  const ws = segs[0].words.filter((x, k, a) => !(x.v === "-C" || (k > 0 && a[k - 1].v === "-C")));
  if (ws.length < 2 || base(ws[0].v) !== "git" || ws.some((x) => x.exp)) return false;
  const sub = ws[1].v;
  const opts = ws.slice(2).map((x) => x.v);
  if (sub === "rev-parse") return !opts.some((o) => /^--(show|git-|absolute|sq|parseopt|local-env|path-format|resolve-git-dir|since|until|after|before)/.test(o) || o === "--");
  if (sub === "branch") return opts.length === 1 && opts[0] === "--show-current";
  if (sub === "symbolic-ref") return opts.includes("--short");
  return sub === "merge-base" || sub === "describe";
}

/** git の設定（KEY=VAL）を読む: alias.X は aliases へ、命令になるキーは値を walk。 */
function gitConfigValue(key, val, w, aliases, depth, ctx, at) {
  const k = key.toLowerCase();
  if (k.startsWith("alias.")) {
    if (aliases !== null) aliases[key.slice("alias.".length)] = val;
    if (val.startsWith("!")) {
      walk(val.slice(1), depth + 1, ctx, nest(at, `git ${key}`));
    } else {
      walk(`git ${val}`, depth + 1, ctx, nest(at, `git ${key}`));
    }
    return;
  }
  if (GIT_CMD_KEY.test(k)) {
    if (w !== null && w.exp) {
      add(ctx, { label: `git ${key}`, where: at, notes: [`${key} の値（命令として実行される）が変数・置換で、測れない`] });
    }
    if (k === "core.hookspath") {
      add(ctx, { label: `git ${key}`, where: at, targets: [val], notes: ["フックの置き場所を差し替える（フックの中身は読んでいない）"] });
      return;
    }
    walk(val.replace(/^!/, ""), depth + 1, ctx, nest(at, `git ${key}`));
  }
}

function gitRule(args, depth, ctx, at) {
  let i = 0;
  let repoW = null;
  const aliases = {};
  while (i < args.length && args[i].v.startsWith("-")) {
    const o = args[i].v;
    if ((o === "-C" || o === "-c" || o === "--git-dir" || o === "--work-tree" || o === "--namespace" || o === "--config-env") && i + 1 < args.length) {
      if (o === "-C") repoW = args[i + 1];
      if (o === "-c") {
        const kv = args[i + 1].v;
        const eq = kv.indexOf("=");
        if (eq > 0) gitConfigValue(kv.slice(0, eq), kv.slice(eq + 1), args[i + 1], aliases, depth, ctx, at);
      }
      i += 2;
    } else {
      i += 1;
    }
  }
  if (i >= args.length) return;
  const subW = args[i];
  const repo = repoW !== null ? repoW.v : "";
  const where = repo ? `${at ? `${at} ` : ""}git -C ${repo}` : at;
  if (subW.exp) {
    return add(ctx, { label: "git のサブコマンドが変数", where, targets: args.slice(i).map((a) => a.v), notes: [`サブコマンド ${subW.v} が変数・置換で、何を実行するか測れない`] });
  }
  const sub = subW.v;
  const restW = args.slice(i + 1).map((a) => ({ ...a, v: expandLong(sub, a.v) }));
  const rest = restW.map((a) => a.v);
  if (Object.hasOwn(aliases, sub)) {
    return; // -c alias.X=… で定義した別名: 定義の時点で中身を読んだ（gitConfigValue）
  }
  if (sub === "config") {
    const pos = [];
    for (let k = 0; k < restW.length; k += 1) {
      if (restW[k].v.startsWith("-")) {
        if (/^(-f|--file|--blob|--type|--default|--comment)$/.test(restW[k].v)) k += 1;
        continue;
      }
      pos.push(restW[k]);
    }
    if (pos.length >= 2) gitConfigValue(pos[0].v, pos[1].v, pos[1], null, depth, ctx, where);
    return;
  }
  if (sub === "bisect" && rest[0] === "run" && restW.length > 1) {
    return analyze({ words: restW.slice(1), redirs: [], piped: false, pd: 0 }, depth + 1, ctx, nest(where, "git bisect run"));
  }
  if (sub === "submodule") {
    const p = restW.findIndex((a) => !a.v.startsWith("-"));
    if (p >= 0 && restW[p].v === "foreach") {
      const code = restW.slice(p + 1).filter((a) => !/^(--recursive|-q|--quiet)$/.test(a.v));
      if (code.length > 0) walk(wordsText(code), depth + 1, ctx, nest(where, "git submodule foreach"));
      return;
    }
    if (p >= 0 && restW[p].v === "deinit" && restW.some((a) => a.v === "-f" || a.v === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a.v))) {
      ctx.deletes.push(`git ${repo}:submodule deinit`);
      return add(ctx, { label: "git submodule deinit -f", where, targets: restW.slice(p + 1).filter((a) => !a.v.startsWith("-")).map((a) => a.v), notes: ["サブモジュールの作業ツリーを未コミット変更ごと消す"] });
    }
    return;
  }
  if (GIT_DESTR_SUBS.has(sub) && !(sub === "worktree" && !/^(remove|prune|move)$/.test(rest[0] ?? ""))) {
    const detach = sub === "checkout" && (rest.includes("--detach") || rest.includes("-d"));
    const hidden = restW.filter((a, k) => a.exp && a.injected !== true && !refGenerator(a) && !refSafeWord(a, ctx) && !(detach && !a.v.startsWith("-")) && !(k > 0 && GIT_TEXT_OPTS.has(restW[k - 1].v)) && !/^--(message|file|author|date)=/.test(a.v));
    if (hidden.length > 0) {
      ctx.deletes.push(`git ${repo}:${sub}`);
      return add(ctx, { label: `git ${sub} の引数が変数`, where, targets: hidden.map((a) => a.v), notes: [`git ${sub} のフラグ・ref・パスが変数・置換を含み、--hard・-f・+ref・pathspec などになりうる（測れない）`] });
    }
  }
  const short = (ch) => rest.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(ch));
  const has = (...xs) => rest.some((a) => xs.includes(a) || xs.some((x) => x.endsWith("=") && a.startsWith(x)));
  const key = (label) => ctx.deletes.push(`git ${repo}:${label}`);
  const pos = rest.filter((a) => !a.startsWith("-"));

  if (sub === "reset" && has("--hard", "--merge", "--keep")) {
    key("reset");
    return add(ctx, { label: `git reset ${rest.find((a) => /^--(hard|merge|keep)$/.test(a))}`, where, targets: pos, notes: ["コミットしていない変更を捨てる（戻せない）"] });
  }
  if (sub === "clean") {
    if (has("-n", "--dry-run") || short("n")) return;
    key("clean");
    return add(ctx, { label: `git clean ${rest.filter((a) => a.startsWith("-")).join(" ")}`.trim(), where, targets: pos, notes: ["追跡していないファイルを消す（git に無いので戻せない）"] });
  }
  if (sub === "push") {
    const notes = [];
    if (has("--force", "--force-with-lease", "--force-with-lease=", "--force-if-includes") || short("f")) notes.push("強制 push＝リモートのコミットを上書きで捨てうる");
    if (has("--delete", "--prune", "--mirror") || short("d")) notes.push("リモートのブランチ・タグを消す");
    if (pos.some((a) => a.startsWith("+"))) notes.push("+refspec＝その ref だけ強制 push");
    if (pos.some((a) => a.startsWith(":") && a.length > 1)) notes.push(":branch＝リモートのブランチを消す");
    if (notes.length === 0) return;
    key(`push ${pos.join(" ")}`);
    return add(ctx, { label: "git push（強制・削除）", where, targets: pos, notes });
  }
  if (sub === "checkout") {
    // 実在確認の基準: -C（絶対ならそれ・相対なら cd 先から）／無ければ cd 先
    let b = ctx.cwd;
    if (repoW !== null) {
      b = repoW.exp || repoW.tilde ? null : repoW.v.startsWith("/") ? repoW.v : b === null ? null : joinPath(b, repoW.v);
    }
    return checkoutRule(restW, b, where, ctx, key, short, has);
  }
  if (sub === "restore") {
    if (has("--pathspec-from-file") || rest.some((a) => a.startsWith("--pathspec-from-file="))) {
      key("restore --pathspec-from-file");
      return add(ctx, { label: "git restore --pathspec-from-file", where, notes: ["戻すパスの一覧をファイル・標準入力から読む（件数を測れない）＝作業ツリーの未コミット変更を捨てうる"] });
    }
    const stagedOnly = has("--staged", "-S") && !has("--worktree", "-W") && !(short("W"));
    const paths = rest.filter((a, k) => !a.startsWith("-") && !(k > 0 && (rest[k - 1] === "-s" || rest[k - 1] === "--source")));
    if (!stagedOnly && paths.length > 0) {
      key(`restore ${paths.join(" ")}`);
      return add(ctx, { label: "git restore", where, targets: paths, notes: ["作業ツリーの未コミット変更を捨てる（戻せない）"] });
    }
    return;
  }
  if (sub === "switch") {
    if (has("--discard-changes", "-f", "--force") || short("f")) {
      key("switch");
      return add(ctx, { label: "git switch --discard-changes", where, notes: ["作業ツリーの未コミット変更を捨てる"] });
    }
    if (has("-C", "--force-create") || short("C")) {
      key("switch -C");
      return add(ctx, { label: "git switch -C", where, targets: pos, notes: ["同名の既存ブランチを付け替える（元のコミットは reflog にしか残らない）"] });
    }
    return;
  }
  if (sub === "branch") {
    const force = has("-D", "--force", "-f") || short("D") || short("f");
    const del = has("-D", "-d", "--delete") || short("D") || short("d");
    if (del && force) {
      key(`branch ${pos.join(" ")}`);
      return add(ctx, { label: "git branch -D", where, targets: pos, notes: ["マージしていないブランチも消す"] });
    }
    if (!del && (has("-f", "--force") || short("f")) && !has("-m", "-M", "-c", "-C", "--move", "--copy") && pos.length > 0) {
      key(`branch -f ${pos.join(" ")}`);
      return add(ctx, { label: "git branch -f", where, targets: pos, notes: ["既存ブランチを別のコミットへ付け替える（元のコミットは reflog にしか残らない）"] });
    }
    return;
  }
  if (sub === "tag" && (has("-d", "--delete") || short("d"))) {
    key(`tag -d ${pos.join(" ")}`);
    return add(ctx, { label: "git tag -d", where, targets: pos, notes: ["タグを消す"] });
  }
  if (sub === "stash") {
    const action = pos[0];
    if (action === "drop" || action === "clear") {
      key(`stash ${pos.join(" ")}`);
      return add(ctx, { label: `git stash ${action}`, where, targets: pos.slice(1), notes: ["退避した変更を消す"] });
    }
    return;
  }
  if (sub === "rm" && (short("r") || short("f") || has("--force"))) {
    if (has("--cached") && !short("f") && !has("--force")) return;
    key(`rm ${pos.join(" ")}`);
    return add(ctx, { label: `git rm ${rest.filter((a) => a.startsWith("-")).join(" ")}`.trim(), where, targets: pos, notes: ["作業ツリーからも消す（-f は未コミット変更ごと）"] });
  }
  if ((sub === "reflog" && rest.length > 0 && (rest[0] === "expire" || rest[0] === "delete")) || (sub === "gc" && rest.some((a) => /^--prune=(now|all)$/.test(a)))) {
    key(sub);
    return add(ctx, { label: `git ${sub} ${rest.join(" ")}`.trim(), where, notes: ["復旧の手がかり（reflog・到達不能オブジェクト）を消す"] });
  }
  if (sub === "prune" && !has("-n", "--dry-run") && !short("n")) {
    key("prune");
    return add(ctx, { label: `git prune ${rest.join(" ")}`.trim(), where, notes: ["到達不能オブジェクトを消す（復旧の手がかり）"] });
  }
  if (sub === "update-ref" && (rest.includes("-d") || rest.includes("--delete"))) {
    key("update-ref");
    return add(ctx, { label: "git update-ref -d", where, targets: pos, notes: ["ref を消す"] });
  }
  if (sub === "filter-branch" || sub === "filter-repo") {
    key(sub);
    return add(ctx, { label: `git ${sub}`, where, notes: ["履歴を書き換える"] });
  }
  if (sub === "worktree" && rest[0] === "remove" && (rest.includes("-f") || rest.includes("--force"))) {
    key("worktree remove");
    return add(ctx, { label: "git worktree remove --force", where, targets: rest.slice(1).filter((a) => !a.startsWith("-")), notes: ["未コミット変更ごと worktree を消す"] });
  }
}

/**
 * git checkout:
 *  - `--` の後にパス／`-f`／`.`／`-B`／`--pathspec-from-file` → 止める（静的）
 *  - `-b`・`--orphan`・`-t` → ブランチを作るだけ＝通す
 *  - 位置引数に glob（引用されていても git が pathspec として展開）・変数・`:` 始まり（pathspec magic）・`./` 始まり → 止める（静的）
 *  - 位置引数が 2 個以上 → `<rev> <path>…`＝パスの中身を rev の版で上書き → 止める（静的）
 *  - 位置引数 1 個 → 実在パスなら止める（後段 existChecks で $.fs.stat。cd 先・-C を基準に足す。基準が分からなければ止める）
 */
function checkoutRule(restW, b, where, ctx, key, short, has) {
  const NOTE = "作業ツリーの未コミット変更を捨てる（戻せない）";
  const rest = restW.map((a) => a.v);
  if (has("--pathspec-from-file") || rest.some((a) => a.startsWith("--pathspec-from-file="))) {
    key("checkout --pathspec-from-file");
    return add(ctx, { label: "git checkout --pathspec-from-file", where, notes: [`上書きするパスの一覧をファイル・標準入力から読む（件数を測れない）＝${NOTE}`] });
  }
  const dd = rest.indexOf("--");
  const before = dd >= 0 ? rest.slice(0, dd) : rest;
  const beforeW = dd >= 0 ? restW.slice(0, dd) : restW;
  const after = dd >= 0 ? rest.slice(dd + 1) : [];
  if (has("-B") || before.some((a) => /^-[a-zA-Z]*B[a-zA-Z]*$/.test(a))) {
    key("checkout -B");
    return add(ctx, { label: "git checkout -B", where, targets: before.filter((a) => !a.startsWith("-")), notes: ["同名の既存ブランチを付け替える（元のコミットは reflog にしか残らない）"] });
  }
  if (after.length > 0) {
    key(`checkout ${after.join(" ")}`);
    return add(ctx, { label: "git checkout -- <path>", where, targets: after, notes: [NOTE] });
  }
  const branchOnly = dd >= 0; // `git checkout main --`＝-- の前は rev と明示（パスは無い）
  if (has("-f", "--force") || short("f")) {
    key("checkout -f");
    return add(ctx, { label: "git checkout -f", where, targets: before.filter((a) => !a.startsWith("-")), notes: [NOTE] });
  }
  if (before.includes(".")) {
    key("checkout .");
    return add(ctx, { label: "git checkout .", where, targets: ["."], notes: [NOTE] });
  }
  if (before.some((a) => a === "-b" || a === "--orphan" || a === "-t" || a === "--track" || a.startsWith("--track=") || /^-[a-zA-Z]*b$/.test(a))) {
    return; // ブランチを作るだけ
  }
  if (has("-p", "--patch")) {
    return; // 1 件ずつ聞く対話形式
  }
  const VALUED = new Set(["--conflict"]);
  const posW = beforeW.filter((a, k) => !a.v.startsWith("-") && !(k > 0 && VALUED.has(before[k - 1])));
  const pos = posW.map((a) => a.v);
  // ブランチ名に * ? [ : は使えず、. で始まる要素も使えない＝これらは pathspec
  const detach = has("--detach", "-d");
  const odd = posW.filter((a) => (a.exp && !refGenerator(a) && !detach) || a.glob || /[*?[]/.test(a.v) || a.v.startsWith(":") || /^\.\.?(\/|$)/.test(a.v));
  if (odd.length > 0) {
    key(`checkout ${pos.join(" ")}`);
    return add(ctx, { label: "git checkout <pathspec>", where, targets: odd.map((a) => a.v), notes: [`glob・変数・置換・:(magic)・./ はパスとして展開される（何件か測れない）＝${NOTE}`] });
  }
  if (pos.length >= 2) {
    key(`checkout ${pos.slice(1).join(" ")}`);
    return add(ctx, { label: "git checkout <rev> <path>", where, targets: pos.slice(1), notes: [`${pos[0]} の版でパスの中身を上書き＝${NOTE}`] });
  }
  if (pos.length === 1 && !branchOnly && !detach && !GIT_REV_LIKE.test(pos[0]) && !refGenerator(posW[0])) {
    const p = pos[0];
    key(`checkout ${p}`);
    if (!p.startsWith("/") && b === null) {
      ctx.existChecks.push({ path: null, name: p, unknown: "作業フォルダ（cd 先・git -C）が変数・~ などで、基準を確かめられない", label: "git checkout <path>", where, note: NOTE });
      return;
    }
    ctx.existChecks.push({ path: p.startsWith("/") ? p : joinPath(b, p), name: p, label: "git checkout <path>", where, note: NOTE });
  }
}

// ---- find / xargs / shell / ssh / interpreter --------------------------------

function findRule(args, depth, ctx, at) {
  const roots = [];
  for (const a of args) {
    if (a.v.startsWith("-") || a.v === "(" || a.v === "!") break;
    roots.push(a.v);
  }
  const targets = roots.length > 0 ? roots : ["."];
  if (args.some((a) => a.v === "-delete")) {
    roots.forEach((r) => ctx.deletes.push(`find ${r}`));
    return add(ctx, { label: "find -delete", where: at, targets, notes: ["条件に合うものを全部消す。件数は測っていない"] });
  }
  // -exec … ; ／ -exec … + の語を全部、同じ規則で読む（{} は「find が見つけたもの」＝測れない対象）
  for (let k = 0; k < args.length; k += 1) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(args[k].v)) continue;
    let e = k + 1;
    while (e < args.length && args[e].v !== ";" && args[e].v !== "+") e += 1;
    const inner = args.slice(k + 1, e).map((x) => (x.v === "{}" ? injectedWord("{}（find が見つけたもの）") : x));
    if (inner.length > 0) {
      const before = ctx.risks.length;
      withNote(ctx, "find の条件に合うもの全部に実行する。件数は測っていない", () => analyze({ words: inner, redirs: [], piped: false, pd: 0 }, depth + 1, ctx, nest(at, `find ${args[k].v}`)));
      if (ctx.risks.length > before) {
        roots.forEach((r) => ctx.deletes.push(`find ${r}`));
        for (const r of ctx.risks.slice(before)) {
          if (r.targets.length === 0 || r.targets.every((t) => t.startsWith("{}"))) r.targets = targets;
        }
      }
    }
    k = e;
  }
}

function xargsRule(cmd, args, depth, ctx, at) {
  const valued = cmd === "xargs"
    ? new Set(["-n", "-I", "-i", "-L", "-l", "-P", "-d", "-s", "-E", "-e", "-a", "-R", "-S", "-J", "--max-args", "--max-lines", "--max-procs", "--delimiter", "--arg-file", "--eof", "--max-chars", "--process-slot-var"])
    : new Set(["-j", "-J", "-N", "-n", "-P", "-S", "-a", "-d", "-I", "-L", "--jobs", "--colsep", "--arg-file", "--delimiter", "--sshlogin", "--joblog", "--results", "--tmpdir", "--timeout", "--retries", "--load", "--memfree"]);
  let k = 0;
  let repl = null; // xargs -I {} ／ -i ／ --replace: 入力は末尾でなく {} の位置に入る
  while (k < args.length && args[k].v.startsWith("-") && args[k].v !== "--") {
    const o = args[k].v;
    if (cmd === "xargs" && o === "-I" && args[k + 1] !== undefined) repl = args[k + 1].v;
    else if (cmd === "xargs" && /^-I./.test(o)) repl = o.slice(2);
    else if (cmd === "xargs" && (o === "-i" || o === "--replace")) repl = "{}";
    else if (cmd === "xargs" && /^(-i|--replace=)./.test(o)) repl = o.replace(/^(-i|--replace=)/, "");
    k += valued.has(o) ? 2 : 1;
  }
  if (k < args.length && args[k].v === "--") {
    k += 1;
  }
  let inner = args.slice(k);
  if (repl !== null && repl !== "" && inner.some((a) => a.v === repl)) {
    // 語そのものが {} なら入力に置き換える（xargs -I{} mv {} /dev/null）。sh -c '… {} …' のような語の一部は文字どおり読む
    const input = injectedWord(`（${cmd} の入力）`);
    inner = inner.map((a) => (a.v === repl ? input : a));
    return analyze({ words: inner, redirs: [], piped: false, pd: 0 }, depth + 1, ctx, nest(at, cmd));
  }
  const sep = inner.findIndex((a) => a.v === ":::" || a.v === "::::" || a.v === ":::+" || a.v === "::::+");
  if (sep >= 0) {
    inner = inner.slice(0, sep);
  }
  if (inner.length === 0) return;
  analyze({ words: [...inner, injectedWord(`（${cmd} の入力）`)], redirs: [], piped: false, pd: 0 }, depth + 1, ctx, nest(at, cmd));
}

/** 標準入力として流し込まれる本文（ヒアドキュメント・here-string）。 */
function stdinBodies(seg) {
  return seg.redirs.filter((r) => r.kind === "<<<" || r.kind === "<<" || r.kind === "<<-").map((r) => (r.kind === "<<<" ? r.word.v : r.body ?? ""));
}

function shellRule(cmd, args, seg, depth, ctx, at) {
  if (cmd === "busybox") {
    if (args.length > 0 && SHELLS.has(args[0].v)) {
      return shellRule(args[0].v, args.slice(1), seg, depth, ctx, at); // busybox sh -c '…'
    }
    if (args.length > 0) {
      // busybox rm -rf x など
      analyze({ words: args, redirs: seg.redirs, piped: false, pd: seg.pd }, depth + 1, ctx, nest(at, "busybox"));
    }
    return;
  }
  let k = 0;
  let code = null;
  let stdin = false;
  while (k < args.length && /^[-+]/.test(args[k].v) && args[k].v !== "-" && args[k].v !== "--") {
    const o = args[k].v;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(o) || o === "--command") {
      // コードは -c の後の最初の「オプションでない引数」（bash -c -x '…'・bash -c -- '…'）
      const j = shCodeIndex(args, k);
      code = j >= 0 ? args[j] : null;
      if (code === null) return;
      break;
    }
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(o)) stdin = true;
    if (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(o)) return; // -n（noexec）は構文を見るだけで実行しない
    if (o === "-o" || o === "+o" || o === "-O" || o === "+O" || o === "--rcfile" || o === "--init-file") k += 1;
    k += 1;
  }
  if (code !== null) {
    if (code.exp) {
      // 二重引用でも "$X"・"$(cat run.sh)" の中身はシェルが命令として読む＝測れない
      add(ctx, { label: `${cmd} -c`, where: at, notes: ["-c の中身が変数・置換を含み、測れない"] });
    }
    walk(code.v, depth + 1, ctx, nest(at, `${cmd} -c`));
    return;
  }
  if (k < args.length && args[k].v === "--") {
    k += 1; // bash -- script ／ bash --（スクリプト無し＝標準入力）
  }
  let script = k < args.length ? args[k] : null;
  if (script !== null && (script.v === "-" || script.v === "/dev/stdin" || script.v === "/dev/fd/0")) {
    script = null; // 標準入力を実行する
  }
  if (script !== null && !stdin) {
    if (/^\/dev\/fd\/\d+$/.test(script.v)) {
      return add(ctx, { label: `${cmd} ${script.v}`, where: at, notes: ["別の入力（ファイル記述子）の中身をシェルが実行する＝測れない"] });
    }
    if (script.subs.length > 0 && /^[<>]\(/.test(script.v)) {
      return add(ctx, { label: `${cmd} <( … )`, where: at, notes: ["プロセス置換の出力をシェルが実行する＝中身を測れない"] });
    }
    if (onlyExpansion(script)) {
      return add(ctx, { label: `${cmd} ${script.v}`, where: at, notes: ["スクリプト名が変数・置換で、何を実行するか測れない"] });
    }
    return shellScript(script, ctx, at);
  }
  // スクリプト無し＝標準入力を実行する
  const bodies = stdinBodies(seg);
  for (const b of bodies) {
    walk(b, depth + 1, ctx, nest(at, `${cmd} の標準入力`));
  }
  if (seg.piped) {
    add(ctx, { label: `… | ${cmd}`, where: at, notes: ["パイプで流した文字列をシェルが実行する＝中身を測れない"] });
  } else if (bodies.length === 0 && seg.redirs.some((r) => r.kind === "<")) {
    const f = seg.redirs.find((r) => r.kind === "<").word;
    if (f.subs.length > 0 && /^[<>]\(/.test(f.v)) {
      add(ctx, { label: `${cmd} < <( … )`, where: at, notes: ["プロセス置換の出力をシェルが実行する＝中身を測れない"] });
    } else if (scriptDanger(base(f.v))) {
      add(ctx, { label: `${cmd} < ${f.v}`, where: at, notes: ["名前が巻き戻し・消去系のスクリプト。中身は読んでいない"] });
    }
  }
}

function shellScript(script, ctx, at) {
  if (scriptDanger(base(script.v))) {
    add(ctx, { label: `${script.v}`, where: at, notes: ["名前が巻き戻し・消去系のスクリプト。中身は読んでいない"] });
  }
}

function sourceRule(cmd, args, seg, depth, ctx, at) {
  const script = args.find((a) => !a.v.startsWith("-"));
  if (script === undefined) return;
  if (script.subs.length > 0 && /^[<>]\(/.test(script.v)) {
    return add(ctx, { label: `${cmd} <( … )`, where: at, notes: ["プロセス置換の出力を今のシェルで実行する＝中身を測れない"] });
  }
  if (script.v === "/dev/stdin" || script.v === "/dev/fd/0" || script.v === "-") {
    for (const b of stdinBodies(seg)) {
      walk(b, depth + 1, ctx, nest(at, `${cmd} の標準入力`));
    }
    if (seg.piped) {
      add(ctx, { label: `… | ${cmd} ${script.v}`, where: at, notes: ["パイプで流した文字列を今のシェルで実行する＝中身を測れない"] });
    }
    return;
  }
  if (scriptDanger(base(script.v))) {
    add(ctx, { label: `${cmd} ${script.v}`, where: at, notes: ["名前が巻き戻し・消去系のスクリプト。中身は読んでいない"] });
  }
}

function sshRule(args, depth, ctx, at) {
  const valued = new Set(["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-m", "-O", "-Q", "-S", "-W", "-w", "-B", "-I"]);
  let k = 0;
  while (k < args.length && args[k].v.startsWith("-")) {
    const o = args[k].v;
    if (o === "-o" && k + 1 < args.length) {
      // -o ProxyCommand=… / LocalCommand=… は手元で実行される
      const m = /^\s*(ProxyCommand|LocalCommand|KnownHostsCommand)\s*[= ]\s*(.*)$/is.exec(args[k + 1].v);
      if (m !== null) walk(m[2], depth + 1, ctx, nest(at, `ssh -o ${m[1]}`));
    }
    k += valued.has(o) ? 2 : 1;
  }
  const host = args[k];
  const remote = args.slice(k + 1);
  if (host === undefined || remote.length === 0) return;
  withNote(ctx, "リモート側で実行される（ローカルでは測れない）", () => walk(wordsText(remote), depth + 1, ctx, nest(at, `ssh ${host.v}`)));
}

/** インタプリタのコード文字列に削除の呼び出し・削除コマンドの起動があれば危険（risk）を返す。無ければ null。 */
function codeDanger(cmd, code, isPwsh, at) {
  const m = DANGER_CALL.exec(code);
  if (m !== null) {
    return { label: `${cmd} のコード内で削除`, where: at, targets: [], notes: [`コード内に「${m[0].trim()}」＝ファイル削除などの呼び出し。対象は測っていない`] };
  }
  const s = SHELL_STR.exec(code);
  if (s !== null && (isPwsh || SPAWN.test(code))) {
    return { label: `${cmd} のコード内で削除`, where: at, targets: [], notes: [`コード内で外部コマンドとして「${s[0].trim()}」を起動しうる。対象は測っていない`] };
  }
  return null;
}

// 値が追えない変数頭の第 1 引数がこれなら、次の語はコード（python/node/perl/ruby -c/-e/-E/-r・--eval・sh -c）。-m はモジュール名
const UNKNOWN_CODE_FLAG = /^(?:-[ceErpm]|--eval|--print|--command)$/;
// 引用つき "$x" を埋めてよい値（1 語・空白/glob/展開/引用文字なし）
const PLAIN_VALUE = /^[A-Za-z0-9._/+@%:,=-]+$/;

/**
 * 値が追えない変数頭（$PY・"$SH"・$F など）の読み（第5R B4・止める方向だけ）:
 *  - 第 1 引数がコード引数 → コードを名前不明のまま読む（削除の呼び出し・-c はシェルとしても）。コードも変数だけなら読めない＝従来どおり
 *  - 引数に find 型の -delete → 止める
 */
function unknownHeadRule(head, args, seg, depth, ctx, at) {
  const name = `${head.v}（名前不明）`;
  if (args.some((a) => !a.q && a.v === "-delete")) {
    add(ctx, { label: `${head.v} … -delete`, where: at, targets: args.filter((a) => !a.v.startsWith("-")).map((a) => a.v), notes: ["名前が測れないコマンドに -delete（find なら条件に合うものを全部消す）"] });
  }
  const o = args[0];
  if (o.q || o.exp || !UNKNOWN_CODE_FLAG.test(o.v) || args[1] === undefined || onlyExpansion(args[1])) {
    return;
  }
  const code = args[1];
  if (o.v === "-m") {
    if (scriptDanger(code.v)) add(ctx, { label: `${head.v} -m ${code.v}`, where: at, notes: ["名前が巻き戻し・消去系のモジュール。中身は読んでいない"] });
    return;
  }
  const hit = codeDanger(name, code.v, false, at);
  if (hit !== null) add(ctx, hit);
  if (o.v === "-c") {
    // シェル（$SH -c）でありうるので、シェルとしても読む。ただしこれは推測の読み（python のコードかもしれない）なので、
    // 「コマンド名が測れない」類の所見（print(x[0]) の [0] を glob と読む等）は捨て、削除・巻き戻しの所見だけ残す
    const before = ctx.risks.length;
    walk(code.v, depth + 1, ctx, nest(at, `${head.v} -c`));
    const kept = ctx.risks.slice(before).filter((r) => !SPECULATIVE_NOISE.has(r.label));
    ctx.risks.splice(before, ctx.risks.length - before, ...kept);
  }
}

// 推測で読んだ -c のコードから捨てる所見（コマンド名が測れないだけで、削除の形ではない）
const SPECULATIVE_NOISE = new Set(["コマンド名に glob・ブレース展開", "コマンド名が変数展開", "コマンド名が $'…'"]);

function interpreterRule(cmd, args, seg, depth, ctx, at) {
  const codes = []; // { text, w }
  let script = null;
  let module = false;
  let k0 = 0;
  const isPwsh = cmd === "pwsh" || cmd === "powershell";
  const isPerl = /^perl/.test(cmd);
  if (cmd === "deno" && args.length > 1 && args[0].v === "eval") {
    codes.push({ text: args[1].v, w: args[1] });
    k0 = args.length;
  }
  for (let k = k0; k < args.length; k += 1) {
    const o = args[k].v;
    if (isPwsh && PWSH_ENC.test(o)) {
      return add(ctx, { label: `${cmd} ${o}`, where: at, notes: ["エンコードされたコマンド（Base64）＝中身を測れない"] });
    }
    if (/^-[A-Za-z]*[cerp]$/.test(o) || (isPerl && /^-[A-Za-z]*E$/.test(o)) || o === "--eval" || o === "--print" || o === "-Command" || o === "-command") {
      if (args[k + 1] !== undefined) codes.push({ text: args[k + 1].v, w: args[k + 1] });
      k += 1;
      continue;
    }
    if (o.startsWith("--eval=") || o.startsWith("--print=")) {
      codes.push({ text: o.slice(o.indexOf("=") + 1), w: { ...args[k], lit: args[k].lit.slice(args[k].lit.indexOf("=") + 1) } });
      continue;
    }
    // -c"code"・-e'code' のように値を続けて書いた形（python・perl・ruby・php）
    const glued = /^(?:python|pypy|perl|ruby|php)/.test(cmd) ? /^-[A-Za-z]*?[cerE](.+)$/s.exec(o) : null;
    if (glued !== null && !o.startsWith("--")) {
      codes.push({ text: glued[1], w: { ...args[k], lit: args[k].lit.replace(/^-[A-Za-z]*?[cerE]/, "") } });
      continue;
    }
    if (o === "-m" && script === null && codes.length === 0) {
      module = true;
      break;
    }
    if (o.startsWith("-")) continue;
    if (script === null && codes.length === 0) script = args[k];
  }
  for (const c of codes) {
    if (onlyExpansion(c.w)) {
      return add(ctx, { label: `${cmd} のコードが変数`, where: at, notes: [`${cmd} に渡すコードが変数・置換だけで、中身を測れない`] });
    }
  }
  if (script !== null && script.subs.length > 0 && /^[<>]\(/.test(script.v)) {
    return add(ctx, { label: `${cmd} <( … )`, where: at, notes: ["プロセス置換の出力をコードとして実行する＝中身を測れない"] });
  }
  const bodies = stdinBodies(seg);
  for (const b of bodies) codes.push({ text: b, w: null });
  if (seg.piped && codes.length === 0 && !module && (script === null || script.v === "-")) {
    return add(ctx, { label: `… | ${cmd}`, where: at, notes: ["パイプで流した文字列をコードとして実行する＝中身を測れない"] });
  }
  for (const { text: code } of codes) {
    const hit = codeDanger(cmd, code, isPwsh, at);
    if (hit !== null) {
      return add(ctx, hit);
    }
    if (isPwsh) {
      const p = PWSH_DEL.exec(code);
      if (p !== null) {
        return add(ctx, { label: `${cmd} のコード内で削除`, where: at, targets: [], notes: [`PowerShell の削除コマンド「${p[0].trim()}」`] });
      }
    }
    if (cmd === "osascript") {
      const f = FINDER_DEL.exec(code);
      if (f !== null) {
        return add(ctx, { label: `${cmd} のコード内で削除`, where: at, targets: [], notes: [`Finder の「${f[0].trim()}」`] });
      }
    }
  }
  if (script !== null && (scriptDanger(base(script.v)) || (base(script.v) === "artisan" && args.some((a) => MIGRATE_DOWN.test(a.v))))) {
    add(ctx, { label: `${cmd} ${script.v}`, where: at, notes: ["名前が巻き戻し・消去系のスクリプト・タスク。中身は読んでいない"] });
  }
}

/** awk のプログラム内の system("…")・"…" | getline・print | "sh" を読む。 */
function awkRule(cmd, args, depth, ctx, at) {
  let k = 0;
  while (k < args.length && args[k].v.startsWith("-") && args[k].v !== "--") {
    if (/^-[fFv]$/.test(args[k].v)) {
      if (args[k].v === "-f") return; // プログラムはファイル（読まない）
      k += 1;
    }
    k += 1;
  }
  if (k < args.length && args[k].v === "--") k += 1;
  const prog = args[k] !== undefined ? args[k].v : "";
  const calls = /\bsystem\s*\(/g;
  let m;
  while ((m = calls.exec(prog)) !== null) {
    const lit = /^\s*"((?:\\.|[^"\\])*)"\s*\)/.exec(prog.slice(m.index + m[0].length));
    if (lit === null) {
      return add(ctx, { label: `${cmd} system()`, where: at, notes: ["system() の引数が組み立てられていて、実行するコマンドを測れない"] });
    }
    walk(lit[1].replace(/\\(.)/g, "$1"), depth + 1, ctx, nest(at, `${cmd} system()`));
  }
  if (/\|\s*"\s*(?:\/bin\/)?(?:ba|z|da|k)?sh\b/.test(prog) || /\|&\s*"/.test(prog)) {
    return add(ctx, { label: `${cmd} | "sh"`, where: at, notes: ["awk が出力をシェルへ流し込む＝実行される中身を測れない"] });
  }
  const getl = /"((?:\\.|[^"\\])*)"\s*\|\s*getline/g;
  while ((m = getl.exec(prog)) !== null) {
    walk(m[1].replace(/\\(.)/g, "$1"), depth + 1, ctx, nest(at, `${cmd} getline`));
  }
}

/** sed の s///e（置換結果をシェルで実行）と e コマンド（GNU sed）。線形に読む。 */
function sedRule(cmd, args, ctx, at) {
  const scripts = [];
  let sawE = false;
  for (let k = 0; k < args.length; k += 1) {
    const o = args[k].v;
    if (o === "-e" || o === "--expression") {
      if (args[k + 1] !== undefined) scripts.push(args[k + 1].v);
      sawE = true;
      k += 1;
      continue;
    }
    if (o.startsWith("--expression=")) {
      scripts.push(o.slice("--expression=".length));
      sawE = true;
      continue;
    }
    if (o === "-f" || o === "--file") {
      k += 1;
      sawE = true;
      continue;
    }
    if (o.startsWith("-")) continue;
    if (!sawE) {
      scripts.push(o);
      break;
    }
  }
  for (const s of scripts) {
    if (sedExec(s)) {
      return add(ctx, { label: `${cmd} の e`, where: at, notes: ["sed の e（置換結果・パターン空間をシェルで実行）＝実行される中身を測れない"] });
    }
  }
}

function sedExec(s) {
  if (/(?:^|[;\n{}])\s*(?:[0-9$]+\s*)?e(?:\s|;|$)/.test(s)) return true; // e コマンド
  let i = 0;
  const n = s.length;
  while (i < n) {
    const p = i === 0 ? "" : s[i - 1];
    if (s[i] === "s" && i + 1 < n && !/[A-Za-z0-9_\\]/.test(p) && !/[\sA-Za-z0-9\\\n;]/.test(s[i + 1])) {
      const d = s[i + 1];
      let j = i + 2;
      let parts = 0;
      while (j < n && parts < 2) {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === d) parts += 1;
        j += 1;
      }
      if (parts < 2) return false; // 閉じない＝以降は本文の中（線形に保つため打ち切る）
      let f = j;
      while (f < n && /[gpiImMeEw0-9]/.test(s[f])) {
        if (s[f] === "e") return true;
        if (s[f] === "w") break;
        f += 1;
      }
      i = f;
      continue;
    }
    i += 1;
  }
  return false;
}
