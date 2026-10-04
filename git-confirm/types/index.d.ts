/** Files this session's file tools touched, by canonical path: true when the file was clean before. */
export type SessionFiles = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    'git-confirm': { sessionFiles: SessionFiles }
  }
}
