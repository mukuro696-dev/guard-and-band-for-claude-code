import { describe, expect, test } from 'claude-code/testing'

import {
  applyCreate,
  applySnapshot,
  guard,
  hasContext,
  applyUpdate,
  compose,
  contextColor,
  segments,
  createdIdOf,
  percentOf,
  renderContext,
  snapshotToMap,
  succeeded,
  summarize,
} from '../hooks/band'

const mk = (n: number, s: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), s]))

describe('summarize', () => {
  test('0 件は空文字', async () => {
    expect(summarize({}).text).toBe('')
    expect(summarize(undefined).text).toBe('')
  })
  test('全完了は ✓ n/n 完了', async () => {
    expect(summarize(mk(7, 'completed')).text).toBe('✓ 7/7 完了')
  })
  test('deleted と不明 status は数えない', async () => {
    const r = summarize({ 1: 'completed', 2: 'deleted', 3: 'weird', 4: 'pending' })
    expect([r.done, r.total]).toEqual([1, 2])
  })
  test('進行中は 進行N を付ける・未完了で満タンにしない', async () => {
    expect(summarize({ 1: 'completed', 2: 'in_progress', 3: 'pending' }).text).toBe('▓▓▓░░░░░ 1/3 ・進行1')
    expect(summarize({ ...mk(99, 'completed'), 100: 'pending' }).text.startsWith('▓▓▓▓▓▓▓░')).toBe(true)
  })
  test('不正入力（null・文字列・数・巨大）で例外を出さない', async () => {
    expect(summarize(null).text).toBe('')
    expect(summarize('abc').text).toBe('')
    expect(summarize(42).text).toBe('')
    expect(summarize(mk(5000, 'completed')).text).toBe('✓ 5000/5000 完了')
  })
})

describe('percentOf / renderContext', () => {
  test('percent があればそれを使う', async () => {
    expect(percentOf({ context: { window: 200000, percent: 24.4 } })).toBe(24)
  })
  test('percent 無しは tokens/window から計算', async () => {
    expect(percentOf({ context: { window: 200000, tokens: 50000 } })).toBe(25)
  })
  test('取れなければ null', async () => {
    expect(percentOf({ context: { window: 200000 } })).toBeNull()
    expect(percentOf({ context: { window: 0, tokens: 5 } })).toBeNull()
    expect(percentOf(null)).toBeNull()
    expect(percentOf('x')).toBeNull()
    expect(percentOf({ context: { window: 100, percent: Number.NaN } })).toBeNull()
  })
  test('範囲外は 0〜100 に丸める', async () => {
    expect(percentOf({ context: { window: 100, percent: 250 } })).toBe(100)
    expect(percentOf({ context: { window: 100, percent: -5 } })).toBe(0)
  })
  test('85% 以上で要 compact 検討', async () => {
    expect(renderContext(84)).not.toContain('compact')
    expect(renderContext(85)).toContain('（要 compact 検討）')
    expect(renderContext('x')).toBe('')
  })
})

describe('compose', () => {
  test('タスクあり + 文脈', async () => {
    expect(compose({ 1: 'completed', 2: 'pending' }, 24)).toBe('▓▓▓▓░░░░ 1/2 ｜ 文脈 24%')
  })
  test('全完了 + 文脈', async () => {
    expect(compose(mk(7, 'completed'), 24)).toBe('✓ 7/7 完了 ｜ 文脈 24%')
  })
  test('タスク無し + 文脈', async () => {
    expect(compose({}, 24)).toBe('文脈 ▓▓░░░░░░ 24%')
  })
  test('タスクあり・文脈なし', async () => {
    expect(compose({ 1: 'pending' }, null)).toBe('░░░░░░░░ 0/1')
  })
  test('何も無ければ undefined', async () => {
    expect(compose({}, null)).toBeUndefined()
  })
  test('85% 以上は末尾に要 compact 検討', async () => {
    expect(compose({ 1: 'pending' }, 90)).toContain('文脈 90%（要 compact 検討）')
  })
})

describe('状態の更新と取り込み', () => {
  test('Create → Update → deleted', async () => {
    let s = applyCreate(undefined, '1')
    s = applyCreate(s, '2')
    expect(Object.keys(s.map)).toEqual(['t:1', 't:2'])
    s = applyUpdate(s, '1', 'completed')
    expect(summarize(s.map).text).toContain('1/2')
    s = applyUpdate(s, '2', 'deleted')
    expect(summarize(s.map).text).toBe('✓ 1/1 完了')
  })
  test('id 無しの Create は連番、不正な Update は無視', async () => {
    const s = applyCreate(applyCreate(null, undefined), undefined)
    expect(Object.keys(s.map)).toEqual(['t:seq-1', 't:seq-2'])
    expect(applyUpdate(s, undefined, 'completed')).toBe(s)
    expect(applyUpdate(s, 't', 'completed')).toBe(s)
    expect(applyUpdate(s, '1', 'weird')).toBe(s)
    expect(applyUpdate(undefined, '99', 'completed').map).toEqual({})
  })
  test('スナップショットは全置換・配列以外は無視', async () => {
    const m = snapshotToMap([{ status: 'completed' }, { status: 'pending' }, null, { status: 'x' }])
    expect(m).toEqual({ '1': 'completed', '2': 'pending' })
    expect(snapshotToMap('abc')).toBeNull()
    expect(snapshotToMap(null)).toBeNull()
    expect(snapshotToMap([])).toEqual({})
  })
  test('succeeded は deny / isError / success:false を除く', async () => {
    expect(succeeded({ result: { success: true } })).toBe(true)
    expect(succeeded({ deny: 'x' })).toBe(false)
    expect(succeeded({ isError: true, result: {} })).toBe(false)
    expect(succeeded({ result: { success: false } })).toBe(false)
    expect(succeeded(null)).toBe(false)
  })
  test('createdIdOf', async () => {
    expect(createdIdOf({ result: { task: { id: '9' } } })).toBe('9')
    expect(createdIdOf({ result: null })).toBeUndefined()
  })
})

describe('陽性対照', () => {
  test('検査器が違反を捕まえる: 完了数を数え違えれば等価が崩れる', async () => {
    // 1 件完了/2 件の正しい出力と、全完了の出力が別物であること（常に同じ文字列を返す実装を弾く）
    expect(summarize({ 1: 'completed', 2: 'pending' }).text).not.toBe(summarize({ 1: 'completed', 2: 'completed' }).text)
    expect(compose({ 1: 'pending' }, 10)).not.toBe(compose({ 1: 'pending' }, 90))
  })
})

describe('配色（テーマ色キー）', () => {
  test('文脈色の境界 69/70/84/85/100', async () => {
    expect(contextColor(69)).toBe('claude')
    expect(contextColor(70)).toBe('warning')
    expect(contextColor(84)).toBe('warning')
    expect(contextColor(85)).toBe('warning')
    expect(contextColor(100)).toBe('warning')
  })
  test('進行中: バーと n/m は claude・進行n と区切り/ラベルは dim', async () => {
    const g = segments({ 1: 'completed', 2: 'in_progress', 3: 'pending' }, 24)
    expect(g[0]).toEqual({ text: '▓▓▓░░░░░ 1/3', color: 'claude' })
    expect(g[1]).toEqual({ text: ' ・進行1', dim: true })
    expect(g.slice(2).map(x => [x.text, x.dim, x.color])).toEqual([[' ｜ ', true, undefined], ['文脈 ', true, undefined], ['24%', undefined, 'claude']])
  })
  test('全完了は success', async () => {
    expect(segments(mk(7, 'completed'), null)).toEqual([{ text: '✓ 7/7 完了', color: 'success' }])
  })
  test('タスク無し: 文脈バーは境界で色が変わる・85% 以上は bold の注記', async () => {
    expect(segments({}, 69)[1]?.color).toBe('claude')
    expect(segments({}, 70)[1]?.color).toBe('warning')
    const g = segments({}, 85)
    expect(g[g.length - 1]).toEqual({ text: '（要 compact 検討）', color: 'warning', bold: true })
    expect(segments({}, 84).length).toBe(2)
  })
  test('text 連結は compose と一致・何も無ければ []', async () => {
    for (const [m, p] of [[{ 1: 'pending' }, 90], [{}, 24], [{ 1: 'completed' }, 50], [{ 1: 'in_progress' }, null]] as const) {
      expect(segments(m, p).map(x => x.text).join('')).toBe(compose(m, p))
    }
    expect(segments({}, null)).toEqual([])
  })
})

describe('guard（fail-open）', () => {
  test('例外を握って false を返し、投げない', async () => {
    expect(await guard(async () => { throw new Error('x') })).toBe(false)
    expect(await guard(async () => 1)).toBe(true)
  })
})

describe('applySnapshot / hasContext', () => {
  test('s: 系統だけ置換し t: 系統は残す', async () => {
    const base = { map: { 't:1': 'pending', 's:1': 'pending', 's:2': 'completed' }, seq: 3 } as const
    const r = applySnapshot(base as never, { '1': 'in_progress' })
    expect(r.map).toEqual({ 't:1': 'pending', 's:1': 'in_progress' })
    expect(r.seq).toBe(3)
  })
  test('hasContext は context が record の時だけ true', async () => {
    expect(hasContext({ context: { window: 1 } })).toBe(true)
    expect(hasContext({})).toBe(false)
    expect(hasContext(null)).toBe(false)
  })
})
