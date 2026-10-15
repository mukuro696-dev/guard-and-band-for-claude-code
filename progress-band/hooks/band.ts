// progress-band の純関数群（モデル・ネットワーク・ファイル書込なし）。
import type { BandTasks, TaskStatus } from '../types'

const VALID = new Set<string>(['pending', 'in_progress', 'completed'])
export const BAR_WIDTH = 8
export const COMPACT_AT = 85

export const EMPTY: BandTasks = { map: {}, seq: 0 }

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))

export function summarize(map: unknown): { done: number; doing: number; total: number; text: string } {
  let done = 0
  let doing = 0
  let total = 0
  if (isRecord(map)) {
    for (const status of Object.values(map)) {
      if (typeof status !== 'string' || !VALID.has(status)) continue
      total += 1
      if (status === 'completed') done += 1
      else if (status === 'in_progress') doing += 1
    }
  }
  if (total === 0) return { done, doing, total, text: '' }
  if (done === total) return { done, doing, total, text: `✓ ${done}/${total} 完了` }
  const filled = Math.min(Math.round((done / total) * BAR_WIDTH), BAR_WIDTH - 1) // 未完了のうちは満タンにしない
  const bar = '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
  const tail = doing > 0 ? ` ・進行${doing}` : ''
  return { done, doing, total, text: `${bar} ${done}/${total}${tail}` }
}

export function renderContext(percent: unknown): string {
  if (!isFiniteNumber(percent)) return ''
  const p = clampPct(percent)
  const filled = Math.min(BAR_WIDTH, Math.round((p / 100) * BAR_WIDTH))
  const bar = '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
  return `文脈 ${bar} ${p}%${p >= COMPACT_AT ? '（要 compact 検討）' : ''}`
}

/** usage() / session.measure の入力（どちらも `.context` を持つ）から 0〜100 を取る。取れなければ null。 */
export function percentOf(usage: unknown): number | null {
  const c = isRecord(usage) ? usage.context : undefined
  if (!isRecord(c)) return null
  if (isFiniteNumber(c.percent)) return clampPct(c.percent)
  if (isFiniteNumber(c.tokens) && isFiniteNumber(c.window) && c.window > 0) {
    return clampPct((c.tokens / c.window) * 100)
  }
  return null
}

/** 1 行の合成。表示するものが無ければ undefined。 */
export function compose(map: unknown, percent: unknown): string | undefined {
  const t = summarize(map)
  const hasPct = isFiniteNumber(percent)
  if (t.total > 0) {
    if (!hasPct) return t.text
    const p = clampPct(percent)
    return `${t.text} ｜ 文脈 ${p}%${p >= COMPACT_AT ? '（要 compact 検討）' : ''}`
  }
  return hasPct ? renderContext(percent) : undefined
}

export type Seg = { text: string; color?: 'claude' | 'success' | 'warning'; dim?: boolean; bold?: boolean }

/** 文脈使用量の色キー: 70% 未満 claude / 70% 以上 warning。 */
export function contextColor(p: number): 'claude' | 'warning' {
  return p >= 70 ? 'warning' : 'claude'
}

/** 帯の部品列。text を連結すると compose と同じ 1 行になる。無ければ []。 */
export function segments(map: unknown, percent: unknown): Seg[] {
  const t = summarize(map)
  const hasPct = isFiniteNumber(percent)
  const out: Seg[] = []
  if (t.total > 0) {
    if (t.done === t.total) {
      out.push({ text: t.text, color: 'success' })
    } else {
      out.push({ text: `${t.text.split(' ・')[0]}`, color: 'claude' })
      if (t.doing > 0) out.push({ text: ` ・進行${t.doing}`, dim: true })
    }
    if (hasPct) {
      const p = clampPct(percent)
      out.push({ text: ' ｜ ', dim: true }, { text: '文脈 ', dim: true })
      out.push({ text: `${p}%`, color: contextColor(p) })
      if (p >= COMPACT_AT) out.push({ text: '（要 compact 検討）', color: 'warning', bold: true })
    }
    return out
  }
  if (!hasPct) return out
  const p = clampPct(percent)
  const filled = Math.min(BAR_WIDTH, Math.round((p / 100) * BAR_WIDTH))
  out.push({ text: '文脈 ', dim: true })
  out.push({ text: `${'▓'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)} ${p}%`, color: contextColor(p) })
  if (p >= COMPACT_AT) out.push({ text: '（要 compact 検討）', color: 'warning', bold: true })
  return out
}

/** 系統ごとにキーを分ける: TaskCreate/Update は `t:<id>`、スナップショット（TodoWrite/update_plan）は `s:<n>`。 */
const T = 't:'
const S = 's:'

export function applyCreate(state: BandTasks | null | undefined, createdId: unknown): BandTasks {
  const map = { ...(state?.map ?? {}) }
  const seq = (state?.seq ?? 0) + 1
  const hasId = (typeof createdId === 'string' && createdId !== '') || isFiniteNumber(createdId)
  map[hasId ? `${T}${String(createdId)}` : `${T}seq-${seq}`] = 'pending'
  return { map, seq }
}

/** 既知のタスクにだけ適用する（未知 id は記録しない）。 */
export function applyUpdate(state: BandTasks | null | undefined, taskId: unknown, status: unknown): BandTasks {
  const base: BandTasks = state ?? EMPTY
  if (!((typeof taskId === 'string' && taskId !== '') || isFiniteNumber(taskId))) return base
  const key = `${T}${String(taskId)}`
  if (!(key in base.map)) return base
  const map = { ...base.map }
  if (status === 'deleted') {
    delete map[key]
  } else if (typeof status === 'string' && VALID.has(status)) {
    map[key] = status as TaskStatus
  } else {
    return base
  }
  return { map, seq: base.seq }
}

/** スナップショットで `s:` 系統だけを置換する（`t:` 系統は残す）。 */
export function applySnapshot(state: BandTasks | null | undefined, snap: BandTasks['map']): BandTasks {
  const base: BandTasks = state ?? EMPTY
  const map: BandTasks['map'] = {}
  for (const [k, v] of Object.entries(base.map)) if (!k.startsWith(S)) map[k] = v
  for (const [k, v] of Object.entries(snap)) map[`${S}${k}`] = v
  return { map, seq: base.seq }
}

/** スナップショット（TodoWrite.todos / update_plan.plan）→ {n: status}。配列でなければ null（無視）。 */
export function snapshotToMap(items: unknown): BandTasks['map'] | null {
  if (!Array.isArray(items)) return null
  const map: BandTasks['map'] = {}
  let n = 0
  for (const it of items) {
    n += 1
    const status = isRecord(it) ? it.status : undefined
    if (typeof status === 'string' && VALID.has(status)) map[String(n)] = status as TaskStatus
  }
  return map
}

/** 通った呼び出しだけ数える（deny / isError / result.success:false は数えない）。 */
export function succeeded(ran: unknown): boolean {
  if (!isRecord(ran)) return false
  if (ran.deny !== undefined || ran.isError === true) return false
  const r = ran.result
  if (isRecord(r) && r.success === false) return false
  return true
}

/** TaskCreate の戻りから作成 id を取る。 */
export function createdIdOf(ran: unknown): unknown {
  const r = isRecord(ran) ? ran.result : undefined
  const task = isRecord(r) ? r.task : undefined
  return isRecord(task) ? task.id : undefined
}

/** context が在るか（compact 直後は percent/tokens が無いが context は在る）。 */
export function hasContext(x: unknown): boolean {
  return isRecord(x) && isRecord(x.context)
}

/** 例外を握って false を返す（観測は fail-open: 帯が古くなるだけ）。 */
export async function guard(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work()
    return true
  } catch {
    return false
  }
}
