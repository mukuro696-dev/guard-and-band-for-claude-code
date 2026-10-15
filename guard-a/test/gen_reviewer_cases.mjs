// 【一度きりの生成スクリプト。入力元ファイル（独立レビュー担当が出した入力）は公開物に含まれないため、このリポジトリ単体では実行できない。生成結果は reviewer_cases.mjs に取り込み済み】
// 一度だけ使う生成器: Reviewer の adversarial.mjs / extra.mjs の入力を、本文のまま test/reviewer_cases.mjs へ写す。
// 写した後、止めない判断をしたものを別リストへ移し、理由を 1 行ずつ付ける（下の EXCLUDE / KEEP_HOLD）。
import { readFileSync, writeFileSync } from "node:fs";
const SRC = "./reviewer_input/" /* 元の入力ファイルは公開しない。再生成には不要 */;
const adv = readFileSync(SRC + "adversarial.mjs", "utf8");
const extra = readFileSync(SRC + "extra.mjs", "utf8");

function block(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker);
  if (a < 0 || text.indexOf(startMarker, a + 1) >= 0) throw new Error(`marker ${startMarker}`);
  const b = text.indexOf(endMarker, a);
  return text.slice(a + startMarker.length, b).split("\n").filter((l) => l.trim() !== "");
}
const strOf = (line) => {
  const t = line.trim();
  if (t.startsWith("//")) return null;
  return Function(`return ${t.replace(/,$/, "")}`)();
};

// 止めなくてよい（素通りを許す）と判断したもの: [入力, 理由]
const EXCLUDE = new Map([
  ["git rm file", "git rm は未コミット変更があると拒否する。消えた中身は HEAD/index から戻せる"],
  ["git rebase --onto main HEAD~3", "履歴の書き換えは reflog で戻せる。削除・巻き戻しガードの対象外"],
  ["git commit --amend --no-edit", "同上（reflog で戻せる）"],
  ["tee file </dev/null", "現実にはほぼ使われない形。tee の通常用途と区別する価値が薄い"],
  ["tmutil deletelocalsnapshots /", "対象外(C2): システム管理コマンド。permission rules の deny で守る"],
  ["security delete-generic-password -s svc", "対象外(C2): キーチェーン操作"],
  ["defaults delete com.example.app", "対象外(C2): 設定ドメイン操作"],
  ["terraform destroy -auto-approve", "対象外(C2): 外部サービスの破棄"],
  ["aws s3 rm s3://bucket --recursive", "対象外(C2): 外部サービスの削除"],
  ["gh repo delete owner/repo --yes", "対象外(C2): 外部サービスの削除"],
  ["kubectl delete ns prod", "対象外(C2): 外部サービスの削除"],
  ["npm run clean", "ビルド生成物の掃除＝作り直せる。Reviewer の雑音側にも同じ入力がある"],
  ["make clean", "同上"],
  ["cargo clean", "同上"],
  ["python3 -c \"open('x','w').close()\"", "書き込みでの切り詰めは通常の書き込みと区別できない"],
  ["node -e \"require('fs').writeFileSync('x','')\"", "書き込みでの切り詰めは通常の書き込みと区別できない"],
  ["python3 -c \"import sqlite3; sqlite3.connect('a.db').execute('DELETE FROM users')\"", "対象外(C2): SQL のデータ削除は WHERE の有無まで読まないと区別できない"],
  ["sqlite3 a.db 'DROP TABLE x'", "対象外(C2): DB CLI"],
  ["sqlite3 a.db 'DELETE FROM users'", "対象外(C2): DB CLI"],
  ["psql -c 'DROP DATABASE prod'", "対象外(C2): DB CLI"],
  ["mysql -e 'DROP TABLE x'", "対象外(C2): DB CLI"],
]);
// Reviewer が「止めなくてよい」とした入力のうち、止め続けると判断したもの: [入力, 理由]
const KEEP_HOLD = new Map([
  ["rm file1 file2", "複数対象の rm は止める設計（対象が 1 つに見えない時は確認する）"],
  ["rm -f .DS_Store", "-f は確認なしで消す意図。単一でも止める設計（公式と同じ）"],
  ["rm -rf node_modules && npm i", "rm -rf は止める。node_modules は作り直せるが、静的には中身を区別しない"],
  ["git push --force-with-lease origin main", "Reviewer の束で HOLD 側にも同じ入力がある＝矛盾。強制 push は止める"],
  ["git checkout main -- file.txt", "main の版で file.txt を上書き＝未コミット変更を捨てる。止めるべき"],
]);

const out = [];
const usedEx = new Set();
const usedKeep = new Set();
const emit = (name, lines, expectHold) => {
  const main = [];
  const moved = [];
  for (const l of lines) {
    const s = strOf(l);
    if (s === null) {
      main.push(l);
      continue;
    }
    if (expectHold && EXCLUDE.has(s)) {
      usedEx.add(s);
      moved.push(`  ${JSON.stringify(s)}, // ${EXCLUDE.get(s)}`);
      continue;
    }
    if (!expectHold && KEEP_HOLD.has(s)) {
      usedKeep.add(s);
      moved.push(`  ${JSON.stringify(s)}, // ${KEEP_HOLD.get(s)}`);
      continue;
    }
    main.push(l);
  }
  return { main, moved };
};

const advB = emit("BYPASS", block(adv, "const BYPASS = [\n", "\n];"), true);
const advN = emit("NOISE", block(adv, "const NOISE = [\n", "\n];"), false);
const exHold = (() => {
  const a = extra.indexOf("## 追加: 展開経路の穴");
  return extra.slice(extra.indexOf("await show([\n", a) + "await show([\n".length, extra.indexOf("\n], true);", a)).split("\n").filter((l) => l.trim() !== "");
})();
const exNoise = (() => {
  const a = extra.indexOf("## 追加: 誤止め");
  return extra.slice(extra.indexOf("await show([\n", a) + "await show([\n".length, extra.indexOf("\n], false);", a)).split("\n").filter((l) => l.trim() !== "");
})();
const exH = emit("EXH", exHold, true);
const exN = emit("EXN", exNoise, false);

for (const k of EXCLUDE.keys()) if (!usedEx.has(k)) throw new Error(`EXCLUDE unused: ${k}`);
for (const k of KEEP_HOLD.keys()) if (!usedKeep.has(k)) throw new Error(`KEEP_HOLD unused: ${k}`);

out.push("// Reviewer（独立レビュー 2026-10-13）の入力を本文のまま写したもの。生成器 test/gen_reviewer_cases.mjs（一度だけ使用）。");
out.push("// 判断の基準は『現実の事故に近いか』。HOLD 側は原則すべて止める（Reviewer の分類どおり・各節の見出しは Reviewer のもの）。");
out.push("// 例外は下の REVIEW_PASS_OK（止めない）と REVIEW_NOISE_HOLD（止め続ける）に 1 行ずつ理由を付けて分けた。");
out.push("");
out.push("// 現実の削除・巻き戻し事故の形＝止める（adversarial.mjs BYPASS から EXCLUDE を除いたもの）");
out.push("export const REVIEW_HOLD = [");
out.push(...advB.main);
out.push("  // extra.mjs: 展開経路の穴（ヒアドキュメント・${ }・$(( )) の中の $( ) は実行される）・scratchpad の親・checkout <path>");
out.push(...exH.main);
out.push("];");
out.push("");
out.push("// Reviewer が HOLD を期待したが、止めないと判断したもの（素通りの残件として数える）");
out.push("export const REVIEW_PASS_OK = [");
out.push(...advB.moved, ...exH.moved);
out.push("];");
out.push("");
out.push("// 日常の作業＝止めない（adversarial.mjs NOISE ＋ extra.mjs の誤止め探し。KEEP_HOLD を除く）");
out.push("export const REVIEW_NOISE = [");
out.push(...advN.main);
out.push("  // extra.mjs");
out.push(...exN.main);
out.push("];");
out.push("");
out.push("// Reviewer が PASS を期待したが、止め続けると判断したもの（誤止めの残件として数える）");
out.push("export const REVIEW_NOISE_HOLD = [");
out.push(...advN.moved, ...exN.moved);
out.push("];");
out.push("");
writeFileSync(new URL("./reviewer_cases.mjs", import.meta.url), out.join("\n"));
const mod = await import(new URL("./reviewer_cases.mjs", import.meta.url).href);
console.log("HOLD", mod.REVIEW_HOLD.length, "PASS_OK", mod.REVIEW_PASS_OK.length, "NOISE", mod.REVIEW_NOISE.length, "NOISE_HOLD", mod.REVIEW_NOISE_HOLD.length);
