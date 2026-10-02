/** Status a view reports to the app shell's top-bar pill. */
export interface ViewStatus {
  text: string
  ready?: boolean
  live?: boolean
  error?: boolean
}

export type AppView = 'studio' | 'clips'
