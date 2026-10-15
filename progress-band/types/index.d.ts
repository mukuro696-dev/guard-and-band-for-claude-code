// progress-band の $.state 契約: タスク（id → status と作成順の連番）と、文脈使用量（0〜100・未取得は null）。
export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type BandTasks = { map: { [id: string]: TaskStatus }; seq: number }

declare module 'claude-code' {
  interface PluginState {
    'progress-band': { tasks: BandTasks; percent: number | null }
  }
}
