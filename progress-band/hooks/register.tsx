import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BandTasks } from '../types'
import {
  EMPTY,
  applyCreate,
  applySnapshot,
  applyUpdate,
  createdIdOf,
  guard,
  hasContext,
  percentOf,
  segments,
  snapshotToMap,
  succeeded,
} from './band'

const tasks = atom({ plugin: 'progress-band', key: 'tasks' } as const, EMPTY)
const percent = atom({ plugin: 'progress-band', key: 'percent' } as const, null)

// 観測は fail-open: 例外は guard が握り、常に next の結果をそのまま返す（deny も書き換えもしない）。
// メインエージェントの呼び出しのみ数える: agentId 付き（サブエージェント／チームメイト）は記録しない。
export const register: Register = on => {
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    await guard(async () => {
      if (e.agentId === undefined && succeeded(ran)) {
        const id = createdIdOf(ran)
        await update($, tasks, (s: BandTasks) => applyCreate(s, id))
      }
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    await guard(async () => {
      if (e.agentId === undefined && succeeded(ran)) {
        await update($, tasks, (s: BandTasks) => applyUpdate(s, e.taskId, e.status))
      }
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    await guard(async () => {
      const snap = e.agentId === undefined && succeeded(ran) ? snapshotToMap(e.todos) : null
      if (snap !== null) await update($, tasks, (s: BandTasks) => applySnapshot(s, snap))
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /(^|__)update_plan$/ }, async ($, e, next) => {
    const ran = await next(e)
    await guard(async () => {
      const snap = e.agentId === undefined && succeeded(ran) ? snapshotToMap((e as { plan?: unknown }).plan) : null
      if (snap !== null) await update($, tasks, (s: BandTasks) => applySnapshot(s, snap))
    })
    return ran
  }).catch(($, e, next) => next(e))

  // 文脈使用量はこの 1 本だけで取る（turn.complete での $.session.usage() は同じ値の重複なので置かない）。
  // compact 直後は percent/tokens が無い: context は在るので null（未取得）にして古い % を残さない。
  on('session.measure', async ($, e, next) => {
    await guard(async () => {
      if (hasContext(e)) {
        const p = percentOf(e)
        await update($, percent, () => p)
      }
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear（と resume）で会話が替わる: 件数と使用量をリセットする。
  on('session.end', async ($, e, next) => {
    await guard(async () => {
      if (e.reason === 'clear' || e.reason === 'resume') {
        await update($, tasks, () => EMPTY)
        await update($, percent, () => null)
      }
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const state = await read($, tasks)
      const pct = await read($, percent)
      const segs = segments(state.map, pct)
      if (segs.length === 0) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          {segs.map((g, i) => (
            <Text key={String(i)} color={g.color} dimColor={g.dim} bold={g.bold}>
              {g.text}
            </Text>
          ))}
        </Box>
      )
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))
}
