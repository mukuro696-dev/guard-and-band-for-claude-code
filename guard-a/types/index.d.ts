// guard-a の $.state 契約: 同一セッションでの削除の試みを対象ごとに数える。
export type GuardASeen = { [target: string]: number };

declare module "claude-code" {
  interface PluginState {
    "guard-a": { seen: GuardASeen };
  }
}
