/** An xcodebuild run the mod saw Claude start through the Bash tool. */
export type TrackedBuild = {
  /** The Bash call's tool_use_id, plus the build's index within that call. */
  id: string
  /** `build`, `test`, `test-without-building`, … */
  action: string
  scheme?: string
  /** Where its output went, absolute when it could be resolved; absent when nothing captured it. */
  logPath?: string
  startedAt: number
  isBackground: boolean
  /** Set when a foreground call returned (a background call returns at once, so it never is). */
  finishedAt?: number
  /** The Bash call came back as an error (non-zero exit) or was refused. */
  isError?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'dev-commands': { builds: TrackedBuild[] }
  }
}
