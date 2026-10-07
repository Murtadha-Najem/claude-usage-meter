/** One measurement of a session: its cost so far and the account's limits as it saw them. */
export type Point = {
  t: number
  usd: number
  p5?: number
  r5?: number
  p7?: number
  r7?: number
}

/** What one point of a limit costs in dollars of usage at API prices. */
export type Rate = {
  usdPerPoint: number
  /** Points of the owner's own use that have adjusted the plan's starting figure. */
  observedPoints: number
}

/** One request of a session: when it was sent, how it began, what it cost, and the reply row it is drawn under. */
export type Request = { t: number; label: string; usd: number; row?: string }

/** The request still running or last sent: what the next turn's cost is counted against. */
export type OpenRequest = { t: number; label: string }

/** A session's cost on one account, at that account's own rates. */
export type Share = {
  account: number
  plan: string | null
  usd: number
  rate5: Rate | null
  rate7: Rate | null
}

/**
 * Where the one-time plan measurement stands for the account in use:
 * `waiting` before it has started, `running` while it measures, `done` after.
 */
export type SetupState = 'waiting' | 'running' | 'done'

export type View = {
  requestUsd: number
  sessionUsd: number
  /** This session's cost on each account it ran on. */
  split: Share[]
  /** Cost from before the meter watched, where no account could be assigned. */
  earlierUsd: number
  rate5: Rate | null
  rate7: Rate | null
  account5: number | null
  account7: number | null
  /** The account's reset-time key, and the name shown for it. */
  accountKey: number | null
  plan: string | null
  setup: SetupState
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      view: View | null
      baseUsd: number | null
      open: OpenRequest | null
      stamps: Record<string, number>
    }
  }
}
