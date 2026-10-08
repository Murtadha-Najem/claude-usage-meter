import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionRateLimit } from 'claude-code'

import type { Point, Rate, Request, SetupState, Share, View } from '../types'

const view = atom({ plugin: 'usage-meter', key: 'view' } as const, null)
const baseUsd = atom({ plugin: 'usage-meter', key: 'baseUsd' } as const, null)
const open = atom({ plugin: 'usage-meter', key: 'open' } as const, null)
const stamps = atom({ plugin: 'usage-meter', key: 'stamps' } as const, {})

// Store keys. One file is shared by every session on the machine, so each
// session writes only the keys that carry its own id, and the per-account
// keys hold facts that are the same whoever writes them.
const TIMELINE = 'tl:'
const REQUESTS = 'rq:'
const SUM = 'sum:'
const NAME = 'name:'
const PLAN = 'plan:'
const SETUP = 'setup:'
const WARNED = 'warned:'
const UUID = 'uuid:'
// The account that usage from before the meter is counted on: the first one set up.
const EARLIER = 'earlier-account'
// The account last seen in a plain terminal, where nothing names it before the first reply.
const TERMINAL = 'terminal-account'

const MAX_REQUESTS = 100
const SHOWN_REQUESTS = 10
const MAX_POINTS = 200
const KEEP_MS = 15 * 24 * 60 * 60 * 1000
const SAME_WINDOW_MS = 5 * 60 * 1000
// Readings further apart than this had no session reporting in between.
const QUIET_MS = 30 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const TEN_MINUTES = 10 * 60 * 1000
const REFRESH_MS = 2 * 60 * 1000
// How full a limit must be before the meter says so, once per window.
const WARN_FIVE_HOUR = 90
const WARN_WEEK = 95

// What one point of each limit costs on each plan, in dollars of usage at API
// prices. Measured on a Pro and a Max 5x account over three days of ordinary
// use in October 2026; the Max 20x row is the 5x row times four, not measured.
// These are starting figures only: each account's own use adjusts them.
const PLANS = {
  pro: { label: 'Pro', five: 0.28, week: 2.2 },
  max5: { label: 'Max 5x', five: 1.7, week: 17 },
  max20: { label: 'Max 20x', five: 6.8, week: 68 },
} as const
type PlanId = keyof typeof PLANS
// A measured 5-hour point below the first figure reads as Pro, above the
// second as Max 20x: the midpoints between neighbouring plans, on a ratio scale.
const PRO_BELOW = 0.69
const MAX20_ABOVE = 3.4
// How many points of real use the starting figure counts as. Past that much
// use of an account's own, its own figure outweighs the starting one.
const PRIOR_POINTS = { five: 20, week: 8 } as const
// A stretch of use is believed only if it moved a limit this many points and
// lands within this factor of the plan's figure: a stretch far below it is
// usage the meter did not see, such as the phone app.
const MIN_POINTS = 3
const BELIEVED_WITHIN = 3
// With this many points seen, an account whose own figure sits nearer another
// plan is moved to that plan.
const RECLASSIFY_POINTS = 25

// The one-time measurement: how much usage each stage adds, the size of one
// test call, and how full the 5-hour limit may be for the test to start.
const STAGE_USD = { 1: 1.2, 2: 5.2 } as const
const TEST_CALL_USD = 0.4
const TEST_NOT_ABOVE = 85

type Setup = { stage: 1 | 2; p5: number; r5: number; usd: number }
type Reading = { t: number; p: number; r: number }
type Measured = { usd: number; rateLimits: readonly SessionRateLimit[] }
type Kind = 'five' | 'week'

// The API names no account to a mod, but each account's weekly limit resets
// at its own time of the week, which stays put from one week to the next.
const accountOf = (r7: number | undefined) =>
  r7 === undefined || r7 === 0 ? undefined : Math.round((r7 % WEEK_MS) / TEN_MINUTES) % 1008

const windowOf = (limits: readonly SessionRateLimit[], kind: string) => {
  const found = limits.find(limit => limit.kind === kind)

  if (found === undefined) {
    return {}
  }

  return { p: found.percentUsed, r: found.resetsAt ? Date.parse(found.resetsAt) : 0 }
}

// A session can change account part way (a sign-in to another plan), so each
// point is filed under the account last seen, and a timeline is split by it.
const byAccount = (line: Point[]) => {
  let account: number | undefined
  const runs: { account: number; points: Point[] }[] = []

  for (const point of line) {
    account = accountOf(point.r7) ?? account

    if (account === undefined) {
      continue
    }

    const last = runs.at(-1)

    if (last !== undefined && last.account === account) {
      last.points.push(point)
    } else {
      runs.push({ account, points: [point] })
    }
  }

  return runs
}

// Halve the older half rather than cut it off: the span a timeline covers is
// what a window's spend is read from.
const thin = (points: Point[]) => {
  if (points.length <= MAX_POINTS) {
    return points
  }

  const half = Math.floor(points.length / 2)

  return [...points.slice(0, half).filter((_, i) => i % 2 === 0), ...points.slice(half)]
}

const usdAt = (line: Point[], t: number) => {
  let usd = line[0]?.usd ?? 0

  for (const point of line) {
    if (point.t > t) {
      break
    }

    usd = point.usd
  }

  return usd
}

const totalAt = (lines: Point[][], t: number) =>
  lines.reduce((sum, line) => sum + usdAt(line, t), 0)

// The stretches of use a limit was watched over: how many points it moved
// and what every session on the account spent meanwhile. A window is every
// reading that shares one reset time; within it a limit only rises, so a
// reading below one already seen is a stale one from another session and is
// left out. A window is cut where nothing reported for a while, since use
// across such a gap may never have been metered. A limit moves in whole
// points, so where inside a point it was first seen is unknown: each stretch
// runs from the first move seen to the last, never from the first reading.
const stretches = (lines: Point[][], kind: Kind) => {
  const readings: Reading[] = lines
    .flatMap(line =>
      line.map(point =>
        kind === 'five'
          ? { t: point.t, p: point.p5, r: point.r5 ?? 0 }
          : { t: point.t, p: point.p7, r: point.r7 ?? 0 },
      ),
    )
    .filter((reading): reading is Reading => reading.p !== undefined && reading.r !== 0)
    .sort((a, b) => a.t - b.t)
  const windows = new Map<number, Reading[]>()

  for (const reading of readings) {
    const key = Math.round(reading.r / SAME_WINDOW_MS)
    const rising = windows.get(key) ?? []
    const last = rising.at(-1)

    if (last === undefined || reading.p >= last.p) {
      rising.push(reading)
    }

    windows.set(key, rising)
  }

  const spans: { from?: Reading; to?: Reading }[] = []

  for (const rising of windows.values()) {
    let span: { from?: Reading; to?: Reading } = {}

    rising.forEach((reading, i) => {
      const before = rising[i - 1]

      if (before === undefined) {
        return
      }

      if (reading.t - before.t > QUIET_MS) {
        spans.push(span)
        span = {}
      } else if (reading.p > before.p) {
        span.from ??= reading
        span.to = reading
      }
    })
    spans.push(span)
  }

  return spans
    .flatMap(span =>
      span.from === undefined || span.to === undefined
        ? []
        : [
            {
              points: span.to.p - span.from.p,
              usd: totalAt(lines, span.to.t) - totalAt(lines, span.from.t),
            },
          ],
    )
    .filter(span => span.points >= MIN_POINTS && span.usd > 0)
}

// The plan's starting figure, pulled toward what the account's own use shows
// as that use adds up. Nothing here is announced: the figure simply follows.
const rateFor = (plan: PlanId, lines: Point[][], kind: Kind): Rate => {
  const prior = PLANS[plan][kind]
  const believed = stretches(lines, kind).filter(span => {
    const seen = span.usd / span.points

    return seen > prior / BELIEVED_WITHIN && seen < prior * BELIEVED_WITHIN
  })
  const points = believed.reduce((sum, span) => sum + span.points, 0)
  const usd = believed.reduce((sum, span) => sum + span.usd, 0)
  const weight = PRIOR_POINTS[kind]

  return { usdPerPoint: (prior * weight + usd) / (weight + points), observedPoints: points }
}

const classify = (usdPerPoint: number): PlanId =>
  usdPerPoint < PRO_BELOW ? 'pro' : usdPerPoint > MAX20_ABOVE ? 'max20' : 'max5'

// The plan an account's own use points at, once there is enough of it.
const planFromUse = (lines: Point[][]): PlanId | undefined => {
  const seen = stretches(lines, 'five')
  const points = seen.reduce((sum, span) => sum + span.points, 0)

  if (points < RECLASSIFY_POINTS) {
    return undefined
  }

  return classify(seen.reduce((sum, span) => sum + span.usd, 0) / points)
}

// What each step of a session's own record cost goes to the account the
// reading after it names: the limits a reply reports are those of the account
// that answered it.
const spentByAccount = (line: Point[]) => {
  const spent = new Map<number, number>()
  let account: number | undefined

  for (let i = 0; i < line.length; i += 1) {
    const point = line[i] as Point
    account = accountOf(point.r7) ?? account
    const previous = line[i - 1]

    if (previous !== undefined && account !== undefined) {
      spent.set(account, (spent.get(account) ?? 0) + Math.max(0, point.usd - previous.usd))
    }
  }

  return spent
}

// Dollars per million tokens: input, output, cache read, 5-minute cache
// write, 1-hour cache write. From platform.claude.com/docs/en/about-claude/
// pricing as read on 5 Oct 2026. The first name a model id starts with wins,
// so a longer name stands before the shorter one it begins with.
const RATES: [string, number, number, number, number, number][] = [
  ['claude-fable-5-1', 10, 50, 0.25, 12.5, 20],
  ['claude-mythos-5-1', 10, 50, 0.25, 12.5, 20],
  ['claude-fable-5', 10, 50, 1, 12.5, 20],
  ['claude-mythos-5', 10, 50, 1, 12.5, 20],
  ['claude-opus-5-5', 4, 20, 0.2, 5, 8],
  ['claude-opus-5', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-1', 15, 75, 1.5, 18.75, 30],
  ['claude-opus-4-5', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-6', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-7', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-8', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4', 15, 75, 1.5, 18.75, 30],
  ['claude-sonnet-5', 2, 10, 0.2, 2.5, 4],
  ['claude-sonnet-4', 3, 15, 0.3, 3.75, 6],
  ['claude-haiku-4-5', 1, 5, 0.1, 1.25, 2],
  ['claude-haiku-3-5', 0.8, 4, 0.08, 1, 1.6],
]
// A model the table does not name is priced as this one.
const UNKNOWN = 'claude-opus-5-5'

const rateRow = (model: string) =>
  RATES.find(([name]) => model.startsWith(name)) ?? RATES.find(([name]) => name === UNKNOWN)

// What one response cost. The usage a hook reads does not say which cache a
// write went to: the main loop writes the 1-hour cache and a subagent the
// 5-minute one, as saved conversations show.
const priced = (usage: ModelUsage & { model: string }, isSubagent: boolean) => {
  const row = rateRow(usage.model)

  if (row === undefined) {
    return 0
  }

  const [, input, output, cacheRead, write5m, write1h] = row

  return (
    (usage.input_tokens * input +
      usage.output_tokens * output +
      usage.cache_read_input_tokens * cacheRead +
      usage.cache_creation_input_tokens * (isSubagent ? write5m : write1h)) /
    1_000_000
  )
}

const percent = (usd: number, rate: Rate) => {
  const value = usd / rate.usdPerPoint

  return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}%`
}

// A cost as a share of both limits, or in dollars while the plan is unknown.
const pair = (usd: number, rates: Pick<View, 'rate5' | 'rate7'>) =>
  rates.rate5 === null || rates.rate7 === null
    ? `$${usd.toFixed(2)}`
    : `${percent(usd, rates.rate5)} of 5h, ${percent(usd, rates.rate7)} of week`

const share = (one: Share) => `${one.plan ?? 'Account'} ${pair(one.usd, one)}`

// The line above the prompt shows the account this window is signed in to,
// and nothing of any other: what this session took from it.
const sessionText = (shown: View) =>
  pair(shown.split.find(one => one.account === shown.accountKey)?.usd ?? 0, shown)

const limits = (shown: View) =>
  [
    shown.account5 === null ? null : `${shown.account5}% of 5h`,
    shown.account7 === null ? null : `${shown.account7}% of week`,
  ]
    .filter(part => part !== null)
    .join(', ')

const clock = (t: number) => {
  const at = new Date(t)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

const explain = (label: string, rate: Rate | null) =>
  rate === null
    ? `${label}: not known until the plan is measured.`
    : `${label}: $${rate.usdPerPoint.toFixed(2)} of usage per 1%, the plan's starting figure adjusted by ${rate.observedPoints} points of your own use.`

// Text of about the asked length that no cache holds: the stamp differs each
// time, and the numbered lines keep it from collapsing into a few tokens.
const filler = (chars: number, stamp: number) => {
  const lines: string[] = []
  let length = 0

  for (let i = 0; length < chars; i += 1) {
    const line = `${stamp}-${i} measuring cup, harbour light, seven grey stones, a ledger left open.`
    lines.push(line)
    length += line.length + 1
  }

  return `Reply with the one word OK. The lines below are filler, ignore them.\n${lines.join('\n')}`
}

// What this conversation cost before the meter watched it, as backfill.py
// priced it from the saved conversation, and where the meter's own sum stood
// then: only what the sum adds after that is counted on top.
type Past = { usd: number; sumAt: number }
let before: Past = { usd: 0, sumAt: 0 }

// The account this process runs under. One conversation can be open in two
// windows signed in to different accounts, each with its own process over the
// same record, so the account a window shows is its own process's, never
// whoever wrote the record last.
let myAccount: number | undefined
let isSpending = false

const timelines = async ($: EngineInterface) => {
  const lines: Point[][] = []

  for (const key of (await $.store.keys()).filter(one => one.startsWith(TIMELINE))) {
    const line = (await $.store.get(key)) as Point[] | undefined

    if (line !== undefined && line.length > 0) {
      lines.push(line)
    }
  }

  return lines
}

const linesOf = (all: Point[][], account: number) =>
  all
    .flatMap(byAccount)
    .filter(run => run.account === account)
    .map(run => run.points)

const planOf = async ($: EngineInterface, account: number) =>
  (await $.store.get(`${PLAN}${account}`)) as PlanId | undefined

const nameOf = async ($: EngineInterface, account: number) =>
  ((await $.store.get(`${NAME}${account}`)) as string | undefined) ?? null

const ratesFor = async ($: EngineInterface, all: Point[][], account: number) => {
  const plan = await planOf($, account)
  const lines = linesOf(all, account)

  return plan === undefined
    ? { rate5: null, rate7: null }
    : { rate5: rateFor(plan, lines, 'five'), rate7: rateFor(plan, lines, 'week') }
}

// A session's sum starts where its timeline left off, so a record kept by an
// earlier version runs on without a step.
const sumOf = async ($: EngineInterface) => {
  const id = await $.session.id()
  const held = (await $.store.get(`${SUM}${id}`)) as number | undefined

  if (held !== undefined) {
    return held
  }

  const line = ((await $.store.get(`${TIMELINE}${id}`)) as Point[] | undefined) ?? []

  return line.at(-1)?.usd ?? 0
}

const addToSum = async ($: EngineInterface, usd: number) => {
  const total = (await sumOf($)) + usd
  await $.store.set(`${SUM}${await $.session.id()}`, total)

  return total
}

// What every session on an account has spent in all, this one counted from
// its live sum: its own record is only written when a reply lands.
const spentOn = async ($: EngineInterface, account: number) => {
  const own = `${TIMELINE}${await $.session.id()}`
  let total = await sumOf($)

  for (const key of (await $.store.keys()).filter(one => one.startsWith(TIMELINE) && one !== own)) {
    const line = ((await $.store.get(key)) as Point[] | undefined) ?? []

    if (byAccount(line).at(-1)?.account === account) {
      total += line.at(-1)?.usd ?? 0
    }
  }

  return total
}

// Claude Desktop tells each conversation's process which account it runs
// under. The limits a process reads before it has answered anything can be
// another account's, left from the last reply on the machine; the account id
// is what this window truly is. Absent in a plain terminal, where the limits
// read are always the session's own.
const signedInAs = async ($: EngineInterface) => {
  const id = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')

  return id === undefined
    ? undefined
    : { id, account: (await $.store.get(`${UUID}${id}`)) as number | undefined }
}

// Called only right after this process's own reply, when the limits it holds
// are surely its own account's.
const learnAccount = async ($: EngineInterface, own: readonly SessionRateLimit[]) => {
  const me = await signedInAs($)
  const seven = windowOf(own, 'seven_day')
  const account = accountOf(seven.p === undefined ? undefined : seven.r)

  if (me !== undefined && me.account === undefined && account !== undefined) {
    await $.store.set(`${UUID}${me.id}`, account)
  }
}

const measure = async ($: EngineInterface): Promise<Measured> => ({
  usd: await sumOf($),
  rateLimits: (await $.session.usage()).rateLimits,
})

// Writes this session's record and redraws its line. `write` false reads and
// redraws only: an idle window must not add points, since the sum it would
// stamp them with grows from another window's spending.
const record = async ($: EngineInterface, measured: Measured, write = true) => {
  const key = `${TIMELINE}${await $.session.id()}`
  const own = ((await $.store.get(key)) as Point[] | undefined) ?? []
  const five = windowOf(measured.rateLimits, 'five_hour')
  const seven = windowOf(measured.rateLimits, 'seven_day')
  const me = (await signedInAs($))?.account
  const readAs = accountOf(seven.p === undefined ? undefined : seven.r)
  // Limits that name another account than this window's are someone else's
  // leftovers: the cost is kept, the readings are not.
  const isOwn = me === undefined || readAs === undefined || readAs === me
  const point: Point = {
    t: await $.clock.now(),
    usd: measured.usd,
    ...(five.p === undefined || !isOwn ? {} : { p5: five.p, r5: five.r }),
    ...(seven.p === undefined || !isOwn ? {} : { p7: seven.p, r7: seven.r }),
  }
  myAccount = me ?? accountOf(point.r7) ?? myAccount

  // A terminal session learns its account from its first reply. Until then
  // it goes by the one the terminal used last, so a known account is not
  // treated as new at the top of every conversation.
  if ((await signedInAs($)) === undefined) {
    if (accountOf(point.r7) !== undefined && write) {
      await $.store.set(TERMINAL, myAccount)
    } else {
      myAccount ??= (await $.store.get(TERMINAL)) as number | undefined
    }
  }
  const last = own.at(-1)
  const hasMoved =
    write &&
    (last === undefined ||
      last.usd !== point.usd ||
      last.p5 !== point.p5 ||
      last.p7 !== point.p7)

  if (hasMoved) {
    await $.store.set(key, thin([...own, point]))
  }

  const ownLine = hasMoved ? [...own, point] : own
  const account = myAccount ?? byAccount(ownLine).at(-1)?.account
  const all = await timelines($)
  const { rate5, rate7 } =
    account === undefined ? { rate5: null, rate7: null } : await ratesFor($, all, account)
  const base = (await read($, baseUsd)) ?? measured.usd
  const sessionUsd = before.usd + Math.max(0, measured.usd - before.sumAt)
  const split: Share[] = []

  for (const [spender, usd] of spentByAccount(ownLine)) {
    const rates = spender === account ? { rate5, rate7 } : await ratesFor($, all, spender)
    split.push({ account: spender, plan: await nameOf($, spender), usd, ...rates })
  }

  let earlierUsd = Math.max(0, sessionUsd - split.reduce((sum, one) => sum + one.usd, 0))
  const earlierAccount = (await $.store.get(EARLIER)) as number | undefined

  if (earlierAccount !== undefined && earlierUsd > 0) {
    const held = split.find(one => one.account === earlierAccount)

    if (held !== undefined) {
      held.usd += earlierUsd
    } else {
      const rates =
        earlierAccount === account ? { rate5, rate7 } : await ratesFor($, all, earlierAccount)
      split.push({
        account: earlierAccount,
        plan: await nameOf($, earlierAccount),
        usd: earlierUsd,
        ...rates,
      })
    }

    earlierUsd = 0
  }

  // The notice about the measurement is for an account the meter has never
  // met. With no account known yet, it shows only on a machine where no
  // account has ever been set up.
  const hasPlan =
    account === undefined
      ? (await $.store.keys()).some(one => one.startsWith(PLAN))
      : (await planOf($, account)) !== undefined
  const setup: SetupState = hasPlan
    ? 'done'
    : isSpending || (account !== undefined && (await $.store.get(`${SETUP}${account}`)) !== undefined)
      ? 'running'
      : 'waiting'
  const shown: View = {
    requestUsd: Math.max(0, measured.usd - base),
    sessionUsd,
    split,
    earlierUsd,
    rate5,
    rate7,
    account5: isOwn ? (five.p ?? null) : null,
    account7: isOwn ? (seven.p ?? null) : null,
    accountKey: account ?? null,
    plan: account === undefined ? null : await nameOf($, account),
    setup,
  }
  await update($, view, () => shown)

  // Said once per window and account, whichever session sees it first.
  if (account !== undefined && isOwn) {
    const full =
      five.p !== undefined && five.p >= WARN_FIVE_HOUR
        ? { key: `5h:${Math.round(five.r / TEN_MINUTES)}`, text: `5-hour limit at ${five.p}%` }
        : seven.p !== undefined && seven.p >= WARN_WEEK
          ? { key: `week:${Math.round(seven.r / TEN_MINUTES)}`, text: `weekly limit at ${seven.p}%` }
          : undefined
    const mark = `${WARNED}${account}`

    if (full !== undefined && (await $.store.get(mark)) !== full.key) {
      await $.store.set(mark, full.key)
      $.ui.toast(`${shown.plan ?? 'This account'}: ${full.text}.`)
    }
  }
}

// An account the meter has already watched needs no measurement: its own use
// says which plan it is. Run as a session starts, so a known account never
// sees the notice.
const adoptKnownPlan = async ($: EngineInterface) => {
  const account = (await signedInAs($))?.account ?? ((await $.store.get(TERMINAL)) as number | undefined)

  if (account === undefined || (await planOf($, account)) !== undefined) {
    return
  }

  const known = planFromUse(linesOf(await timelines($), account))

  if (known === undefined) {
    return
  }

  await $.store.set(`${PLAN}${account}`, known)

  if ((await $.store.get(`${NAME}${account}`)) === undefined) {
    await $.store.set(`${NAME}${account}`, PLANS[known].label)
  }
}

const refresh = async ($: EngineInterface) => {
  await record($, await measure($), false)
}

// Sends filler to the model until about `target` dollars of usage are spent,
// counting each call into the session's sum as real usage.
const spend = async ($: EngineInterface, target: number, model: string) => {
  isSpending = true

  try {
    const input = rateRow(model)?.[1] ?? 4
    let spent = 0

    while (spent < target - 0.02) {
      const size = Math.min(TEST_CALL_USD, target - spent)
      const result = await $.model.complete({
        model,
        prompt: filler(Math.round((size / input) * 4_000_000), await $.clock.now()),
        maxTokens: 5,
        effort: 'low',
        timeoutMs: 180_000,
      })
      const cost = priced({ ...result.usage, model }, false)
      spent += cost
      await addToSum($, cost)
      $.ui.status(`Usage meter: measuring your plan, $${spent.toFixed(2)} of test usage so far`)

      // A call that failed or cost nothing will not get further by repeating.
      if (!result.isAnswered || cost <= 0) {
        break
      }
    }
  } finally {
    isSpending = false
    $.ui.status(undefined)
  }
}

const settle = async ($: EngineInterface, account: number, plan: PlanId, isQuiet: boolean) => {
  await $.store.set(`${PLAN}${account}`, plan)
  await $.store.delete(`${SETUP}${account}`)

  if ((await $.store.get(`${NAME}${account}`)) === undefined) {
    await $.store.set(`${NAME}${account}`, PLANS[plan].label)
  }

  if ((await $.store.get(EARLIER)) === undefined) {
    await $.store.set(EARLIER, account)
  }

  if (!isQuiet) {
    $.ui.toast(`Usage meter is ready. This account looks like ${PLANS[plan].label}.`)
  }

  await record($, await measure($), false)
}

// The one-time measurement, a step at a time. Called after each of this
// process's own replies, when the limits it reads are fresh and its own.
//
// It tells the plans apart by how far a known amount of usage moves the
// 5-hour limit. About $1.20 moves a Pro limit four points and a Max limit
// less than one, so Pro shows at the first stage. Otherwise $4 more separates
// Max 5x, which moves about three points over the two stages, from Max 20x,
// which moves less than one. Spending by other sessions that carry the meter
// is counted in; usage from places it does not run (the phone app, claude.ai)
// is not, and an account that reads wrong because of it is moved to the right
// plan later by its own use.
const setupStep = async ($: EngineInterface, own: readonly SessionRateLimit[], model: string) => {
  const account = myAccount

  if (account === undefined || isSpending || (await planOf($, account)) !== undefined) {
    return
  }

  const five = windowOf(own, 'five_hour')
  const seven = windowOf(own, 'seven_day')

  if (five.p === undefined || accountOf(seven.p === undefined ? undefined : seven.r) !== account) {
    return
  }

  // An account already used with the meter needs no test: its use says it.
  const known = planFromUse(linesOf(await timelines($), account))

  if (known !== undefined) {
    await settle($, account, known, true)

    return
  }

  const held = (await $.store.get(`${SETUP}${account}`)) as Setup | undefined
  const total = await spentOn($, account)

  // Begin, or begin again when the 5-hour window turned over mid-measurement.
  if (held === undefined || Math.abs(five.r - held.r5) > SAME_WINDOW_MS || five.p < held.p5) {
    if (five.p > TEST_NOT_ABOVE) {
      return
    }

    await $.store.set(`${SETUP}${account}`, { stage: 1, p5: five.p, r5: five.r, usd: total })
    $.ui.toast(
      'Usage meter: measuring your plan with a short test. It uses a little of your Claude usage. No money is charged.',
    )
    void spend($, STAGE_USD[1], model).catch(() => undefined)

    return
  }

  const usd = total - held.usd
  const moved = five.p - held.p5
  const needed = STAGE_USD[held.stage]

  // Short of the stage's amount (a call failed, or the app was closed): top up.
  if (usd < needed - 0.2) {
    void spend($, needed - usd, model).catch(() => undefined)

    return
  }

  if (held.stage === 1) {
    if (moved >= 3 || (moved === 2 && usd / moved < PRO_BELOW)) {
      await settle($, account, classify(usd / moved), false)

      return
    }

    await $.store.set(`${SETUP}${account}`, { ...held, stage: 2 })
    void spend($, STAGE_USD[2] - usd, model).catch(() => undefined)

    return
  }

  await settle($, account, moved >= 2 ? classify(usd / moved) : 'max20', false)
}

// An account whose own use has come to sit nearer another plan is moved to
// it, and renamed if its name was the meter's own label.
const reclassify = async ($: EngineInterface) => {
  const account = myAccount
  const plan = account === undefined ? undefined : await planOf($, account)

  if (account === undefined || plan === undefined) {
    return
  }

  const seen = planFromUse(linesOf(await timelines($), account))

  if (seen === undefined || seen === plan) {
    return
  }

  await $.store.set(`${PLAN}${account}`, seen)

  if ((await nameOf($, account)) === PLANS[plan].label) {
    await $.store.set(`${NAME}${account}`, PLANS[seen].label)
  }
}

export const register: Register = on => {
  let lastTextRow: string | undefined
  // The model the session last answered with: what the measurement spends on.
  let lastModel = UNKNOWN

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'meter',
      description: 'Show what this session took of your plan limits, and how the figure is reached',
      argumentHint: '[name <label>]',
    })

    // Records of sessions not touched for 15 days are dropped.
    const now = await $.clock.now()

    for (const key of await $.store.keys()) {
      if (!key.startsWith(TIMELINE) && !key.startsWith(REQUESTS)) {
        continue
      }

      const line = (await $.store.get(key)) as { t: number }[] | undefined
      const last = line?.at(-1)

      if (last === undefined || now - last.t > KEEP_MS) {
        await $.store.delete(key)
        await $.store.delete(key.replace(TIMELINE, SUM))
      }
    }

    // What backfill.py found this conversation cost before the meter.
    try {
      const all = JSON.parse(await $.fs.read(`${$.plugin.root}/history.json`)) as {
        sessions: Record<string, Past>
      }
      before = all.sessions[await $.session.id()] ?? before
    } catch {
      // No history file: the session counts from what the meter has seen.
    }

    await adoptKnownPlan($)
    await record($, await measure($), false)
    // An idle session would otherwise keep showing rates as they stood at its
    // last reply, while other sessions go on refining them.
    $.clock.every(REFRESH_MS, () => {
      void refresh($)
    })

    const key = `${REQUESTS}${await $.session.id()}`
    const past = ((await $.store.get(key)) as Request[] | undefined) ?? []
    const known = Object.fromEntries(
      past.flatMap(request => (request.row === undefined ? [] : [[request.row, request.usd]])),
    )
    await update($, stamps, () => known)

    return next(e)
  })

  // The last text block of a reply is the row its cost is drawn under.
  on('session.append', { door: 'response' }, ($, e, next) => {
    if (e.agentId === undefined && e.message.content.some(block => block.type === 'text')) {
      lastTextRow = e.uuid
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt typed over a running turn belongs to that turn's request.
    const isNewRequest =
      e.turnId === undefined && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')

    if (isNewRequest) {
      const measured = await measure($)
      const label = e.text.replace(/\s+/g, ' ').trim().slice(0, 50)
      const sent = { t: await $.clock.now(), label }
      await update($, baseUsd, () => measured.usd)
      await update($, open, () => sent)
      await record($, measured)
    }

    return next(e)
  })

  // Every model response, the main loop's and each subagent's, is priced from
  // its own tokens once it is whole.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage

    if (usage !== null) {
      await addToSum($, priced(usage, e.agentId !== undefined))

      if (e.agentId === undefined) {
        lastModel = usage.model
      }
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const sent = await read($, open)
    const base = await read($, baseUsd)

    if (e.agentId !== undefined || sent === null || base === null) {
      return done
    }

    const measured = await measure($)
    await record($, measured)

    const usd = Math.max(0, measured.usd - base)
    const key = `${REQUESTS}${await $.session.id()}`
    const past = ((await $.store.get(key)) as Request[] | undefined) ?? []
    const others = past.filter(request => request.t !== sent.t)
    const row = lastTextRow
    const entry: Request = row === undefined ? { ...sent, usd } : { ...sent, usd, row }
    await $.store.set(key, [...others, entry].slice(-MAX_REQUESTS))

    if (row !== undefined) {
      await update($, stamps, held => ({ ...held, [row]: usd }))
    }

    return done
  })

  // Raised after each of this process's own replies: the limits it carries
  // are fresh and its own, which is what the measurement needs.
  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) {
      await learnAccount($, e.rateLimits)
      await record($, { usd: await sumOf($), rateLimits: e.rateLimits })
      await setupStep($, e.rateLimits, lastModel)
      await reclassify($)
    }

    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    const shown = await read($, view)
    const named = /^name\s+(.+)$/i.exec(e.args.trim())?.[1]?.trim()

    if (shown === null) {
      return { text: 'No figures yet: the meter reads them after the first reply.' }
    }

    if (named !== undefined) {
      if (shown.accountKey === null) {
        return { text: 'The account is not known yet: send a message first, then name it.' }
      }

      await $.store.set(`${NAME}${shown.accountKey}`, named)
      await update($, view, held => (held === null ? held : { ...held, plan: named }))

      return { text: `This account is now shown as ${named}.` }
    }

    const key = `${REQUESTS}${await $.session.id()}`
    const past = ((await $.store.get(key)) as Request[] | undefined) ?? []

    return {
      text: [
        `Last request: $${shown.requestUsd.toFixed(2)} of usage, ${pair(shown.requestUsd, shown)}`,
        `This session: $${shown.sessionUsd.toFixed(2)} of usage in all`,
        ...shown.split.map(one => `  ${share(one)} ($${one.usd.toFixed(2)})`),
        ...(shown.earlierUsd >= 0.005
          ? [`  $${shown.earlierUsd.toFixed(2)} from before the meter, account not recorded`]
          : []),
        `Account${shown.plan === null ? '' : ` (${shown.plan})`} now: ${limits(shown) || 'no reading yet'}`,
        ...(shown.setup === 'done'
          ? [explain('5-hour limit', shown.rate5), explain('Weekly limit', shown.rate7)]
          : ['Your plan is still being measured: percentages appear when that is done.']),
        'Dollar figures are usage priced at API rates. Nothing is charged to you.',
        ...(past.length === 0 ? [] : ['', 'Recent requests in this session, newest last:']),
        ...past
          .slice(-SHOWN_REQUESTS)
          .map(
            request =>
              `  ${clock(request.t)}  ${pair(request.usd, shown)} ($${request.usd.toFixed(2)})  ${request.label}`,
          ),
      ].join('\n'),
    }
  })

  // The cost of a request, under the last text of its reply.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const usd = (await read($, stamps))[e.requestId]
    const shown = await read($, view)

    if (usd === undefined || shown === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Text dimColor>
          Cost: {pair(usd, shown)} (${usd.toFixed(2)})
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, view)

    if (e.props.hasSurvey || shown === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const parts =
      shown.setup === 'waiting'
        ? [
            'Usage meter: after your first reply it measures your plan with one short test. The test uses a little of your Claude usage. No money is charged.',
          ]
        : [`Request ${pair(shown.requestUsd, shown)}`, `Session ${sessionText(shown)}`]

    if (shown.setup === 'running') {
      parts.unshift('Usage meter: measuring your plan')
    } else if (shown.setup === 'done' && shown.plan !== null) {
      parts.unshift(shown.plan)
    }

    const whole = limits(shown)

    if (shown.setup === 'done' && whole !== '' && e.props.bodyColumns >= 100) {
      parts.push(`Account ${whole}`)
    }

    return (
      <Box>
        <Text dimColor>{parts.join('  |  ')}</Text>
      </Box>
    )
  })
}
