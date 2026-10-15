import { describe, expect, test } from 'claude-code/testing'

const AP = {
  plugin: 'progress-band',
  surface: 'terminal',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 30 },
} as const

// engine の $ に state は無い: 帯を実際に描かせ、その Text を読んで状態を検査する（端から端まで）。
async function band($: any, hasSurvey = false): Promise<{ text: string; colors: unknown[] }> {
  const ui = await $.ui.mount({ ...AP, props: { hasSurvey, isWorking: false } })
  const found = (await ui.findAll({ type: 'Text' })).filter((f: { text: string }) => f.text !== '(engine)')
  await ui.unmount()
  return {
    text: found.map((f: { text: string }) => f.text).join(''),
    colors: found.map((f: { props: { color?: unknown } }) => f.props.color),
  }
}

const bottom = (on: any) => {
  on('session.measure', async (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  // 帯が譲った時（next）の底: エンジン自身は何も描かない。
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine-bottom' }, '(engine)')
  })
  on('session.end', async (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
}
const idResult = (id: string) => ({ result: { task: { id, subject: 's' } } })
const ctx = (percent?: number) => ({
  context: percent === undefined ? { window: 200000 } : { window: 200000, percent },
  rateLimits: [],
  changed: ['context' as const],
})
const create = ($: any, extra: object = {}) => $.tool.call({ tool: 'TaskCreate', subject: 's', description: 'd', ...extra })

describe('register: 実際に発火させる', () => {
  test('Create → Update が数えられ、結果はそのまま返り、全完了は success 色', async ($, on) => {
    bottom(on)
    on('tool.call', { tool: 'TaskCreate' }, async () => idResult('7'))
    on('tool.call', { tool: 'TaskUpdate' }, async () => ({
      result: { success: true, taskId: '7', updatedFields: ['status'] },
    }))
    const c = await create($)
    expect(c).toMatchObject({ result: { task: { id: '7' } } })
    expect(c.deny).toBeUndefined()
    expect((await band($)).text).toBe('░░░░░░░░ 0/1')
    const u = await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' })
    expect(u).toMatchObject({ result: { success: true } })
    expect(await band($)).toEqual({ text: '✓ 1/1 完了', colors: ['success'] })
  })

  test('失敗した呼び出し（success:false / deny）は数えない', async ($, on) => {
    bottom(on)
    on('tool.call', { tool: 'TaskCreate' }, async () => idResult('1'))
    let mode = 'false'
    on('tool.call', { tool: 'TaskUpdate' }, async () =>
      mode === 'false'
        ? { result: { success: false, taskId: '1', updatedFields: [] } }
        : mode === 'deny'
          ? { deny: 'no' }
          : { result: { success: true, taskId: '1', updatedFields: [] } },
    )
    await create($)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    mode = 'deny'
    const d = await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    expect(d.deny).toBe('no')
    expect((await band($)).text).toBe('░░░░░░░░ 0/1')
    mode = 'ok'
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    expect((await band($)).text).toBe('░░░░░░░░ 0/1 ・進行1')
  })

  test('失敗した Create（deny）も数えない', async ($, on) => {
    bottom(on)
    on('tool.call', { tool: 'TaskCreate' }, async () => ({ deny: 'x' }))
    await create($)
    expect((await band($)).text).toBe('')
  })

  test('TodoWrite は e.todos を全置換し、TaskCreate の系統と衝突しない', async ($, on) => {
    bottom(on)
    on('tool.call', { tool: 'TaskCreate' }, async () => idResult('1'))
    on('tool.call', { tool: 'TodoWrite' }, async () => ({ result: { oldTodos: [], newTodos: [] } }))
    await create($)
    const todo = (status: 'pending' | 'in_progress' | 'completed') => ({ content: 'a', status, activeForm: 'a' })
    await $.tool.call({ tool: 'TodoWrite', todos: [todo('completed'), todo('pending')] })
    expect((await band($)).text).toBe('▓▓▓░░░░░ 1/3')
    await $.tool.call({ tool: 'TodoWrite', todos: [todo('in_progress')] })
    expect((await band($)).text).toBe('░░░░░░░░ 0/2 ・進行1')
  })

  test('update_plan は e.plan を読む', async ($, on) => {
    bottom(on)
    on('tool.call', { tool: /update_plan$/ }, async () => ({ result: {} }))
    await $.tool.call({
      tool: 'update_plan',
      plan: [{ step: 'x', status: 'completed' }, { step: 'y', status: 'pending' }],
    } as never) // update_plan は built-in の型表に無い（Codex 系ツール）
    expect((await band($)).text).toBe('▓▓▓▓░░░░ 1/2')
  })

  test('agentId 付き（サブエージェント）は数えない', async ($, on) => {
    bottom(on)
    on('tool.call', { tool: 'TaskCreate' }, async () => idResult('1'))
    on('tool.call', { tool: 'TodoWrite' }, async () => ({ result: { oldTodos: [], newTodos: [] } }))
    await create($, { agentId: 'sub-1' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [{ content: 'a', status: 'pending', activeForm: 'a' }],
      agentId: 'sub-1',
    } as never)
    expect((await band($)).text).toBe('')
    await create($) // 陽性対照: メインエージェントなら数える
    expect((await band($)).text).toBe('░░░░░░░░ 0/1')
  })

  test('未知 id の TaskUpdate は記録しない', async ($, on) => {
    bottom(on)
    on('tool.call', { tool: 'TaskUpdate' }, async () => ({
      result: { success: true, taskId: '9', updatedFields: [] },
    }))
    await $.tool.call({ tool: 'TaskUpdate', taskId: '9', status: 'completed' })
    expect((await band($)).text).toBe('')
  })

  test('session.measure: 文脈を出し、compact 後（percent 無し）は古い % を残さない', async ($, on) => {
    bottom(on)
    await $.session.measure(ctx(42))
    expect(await band($)).toEqual({ text: '文脈 ▓▓▓░░░░░ 42%', colors: [undefined, 'claude'] })
    await $.session.measure(ctx(90))
    expect((await band($)).text).toBe('文脈 ▓▓▓▓▓▓▓░ 90%（要 compact 検討）')
    await $.session.measure(ctx(undefined))
    expect((await band($)).text).toBe('')
  })

  test('session.end(clear) で件数と使用量をリセット・他の reason では残す', async ($, on) => {
    bottom(on)
    on('tool.call', { tool: 'TaskCreate' }, async () => idResult('1'))
    await create($)
    await $.session.measure(ctx(50))
    await $.session.end({ reason: 'other', sessionId: 'a', resume: { id: 'a' } as never })
    expect((await band($)).text).toBe('░░░░░░░░ 0/1 ｜ 文脈 50%')
    await $.session.end({ reason: 'clear', sessionId: 'a', resume: { id: 'a' } as never })
    expect((await band($)).text).toBe('')
  })

  test('hasSurvey の時は帯を譲る', async ($, on) => {
    bottom(on)
    await $.session.measure(ctx(50))
    expect((await band($, true)).text).toBe('')
    expect((await band($, false)).text).toBe('文脈 ▓▓▓▓░░░░ 50%')
  })
})
