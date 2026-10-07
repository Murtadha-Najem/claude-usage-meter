# Claude usage meter

A mod for Claude Code that tells you what each request and each conversation took of your plan's limits.

Claude shows how full your 5-hour and weekly limits are for the whole account. It does not say which request or which conversation filled them. This mod adds that, as one line above the prompt box:

```
Max 5x  |  Request 0.82% of 5h, 0.11% of week  |  Session 4.2% of 5h, 0.5% of week  |  Account 31% of 5h, 62% of week
```

- **Request** is what your last message cost, tool calls and subagents included.
- **Session** is what this conversation has cost on the account you are signed in to.
- **Account** is the account's own figure, as Claude reports it.

It works in the Claude Code terminal and in the Code tab of Claude Desktop, on Pro and Max plans.

## Install

### By asking Claude

Open Claude Code and say:

> Install the usage meter from https://github.com/Murtadha-Najem/claude-usage-meter

Claude follows the steps in [For Claude](#for-claude-installing-this-for-someone) below.

### By hand

Clone the repository into the folder Claude Code loads plugins from, then start a new session:

```bash
git clone https://github.com/Murtadha-Najem/claude-usage-meter ~/.claude/skills/usage-meter
```

On Windows the folder is `%USERPROFILE%\.claude\skills\usage-meter`.

Mods need a recent Claude Code (2.1.286 or later). Sessions that are already open pick the meter up the next time they start.

## The first run: one short measurement

The meter has to learn which plan you are on, because the same request takes a far larger share of a Pro limit than of a Max limit, and Claude does not tell a mod which plan it is running under.

So after your first reply in a new session, it runs one short test on its own. It sends filler text to the model and watches how far your 5-hour limit moves.

- **No money is charged.** The test uses a little of your plan's usage, the same usage your normal messages draw on. Nothing is billed.
- **How much it uses:** about 4 points of the 5-hour limit on a Pro plan, about 3 on Max 5x, and less than 1 on Max 20x.
- **How long it takes:** it finishes over your next reply or two. You can keep working while it runs. The line above the prompt says `measuring your plan` until it is done.
- It runs once per account. If you sign in to a second account, that account gets its own measurement.

For the cleanest result, do not use the same account in the Claude phone app or on claude.ai while it runs. If the result is off anyway, the meter corrects itself as you use it (see below).

## How the figures are reached

1. **Cost of a response.** Each model response reports its token counts. The meter prices them at Anthropic's published API rates for that model. The dollar figures you see are this: usage valued at API prices. They are not a bill.
2. **Dollars to percent.** Each plan has a starting figure for what one point of each limit is worth. These were measured on real accounts over two days of ordinary use:

   | Plan | 1% of the 5-hour limit | 1% of the weekly limit |
   |---|---|---|
   | Pro | $0.28 | $2.20 |
   | Max 5x | $1.70 | $17 |
   | Max 20x | $6.80 | $68 |

   The Max 20x row is the Max 5x row times four. It was not measured.
3. **It adjusts to your account.** The meter keeps comparing what it counted with how far your limits really moved, and pulls the figures toward what your own account shows. It does this quietly, with no prompt and no message. If your own use shows the account is on a different plan than the test concluded, it moves the account to that plan.

## How accurate it is

Good to about a fifth either way. A request shown as 5% took somewhere between 4% and 6%. That is enough to see which requests and conversations are heavy. It is not an exact reading.

The reasons it cannot be exact:

- Claude reports the limits in whole points, so small requests are estimated, not measured.
- Usage from places the meter does not run (the phone app, claude.ai, Claude Code sessions in the cloud) moves your limits without being counted.
- Anthropic does not publish how usage is weighed inside a subscription. The meter assumes it follows API prices. The two days of data behind the table above fit that assumption to within about a fifth.

## Commands

| Command | What it does |
|---|---|
| `/meter` | The detail: last request, this session, the rates in use, and the last ten requests with their cost |
| `/meter name <label>` | Rename the account you are signed in to, for example `/meter name Work` |

## More than one account

The meter tells accounts apart on its own and keeps their figures separate, each with its own plan and rates. A conversation that ran on two accounts shows, in each window, only what it took from that window's account. `/meter` shows the full split.

## Old conversations (optional)

The meter counts from the moment it is installed. To include what your existing conversations cost before that, run this once (it needs Python 3):

```bash
python ~/.claude/skills/usage-meter/backfill.py
```

It reads the conversations Claude Code keeps on your machine and writes their cost to `history.json` in the meter's folder. Nothing leaves your computer.

`check.py` in the same folder prints, for each account, what the meter counted against how far the limits really moved. Use it if you want to see the evidence behind your own rates.

## What it stores, and privacy

Everything stays on your machine. The meter keeps a small file in Claude Code's plugin store with, for each session, a running cost and the limit readings it saw, and the first 50 characters of each request so `/meter` can list them. It sends nothing anywhere. The only network use is the first-run test, which goes to Claude like any other message.

## Limits to know about

- The price table was read from Anthropic's pricing page on 5 October 2026. A new model or a price change needs an update here. A model the table does not know is priced as Claude Opus 5.5.
- Fast mode costs more per token and the meter cannot see that it is on, so fast mode usage is undercounted.
- The cost line under each reply depends on how the surface draws messages. If you do not see it, `/meter` lists the same figures.
- Mods are a new part of Claude Code. A future release may change the interface this is built on.
- A mod runs with full access to your machine, like any Claude Code plugin. Read `hooks/register.tsx` before you install one from someone you do not know. This one reads Claude Code's own usage figures and its own files, and nothing else.

## For Claude: installing this for someone

When a person asks you to install this:

1. Tell them, before you do anything, in plain words: after it is installed, the meter runs one short test the first time they use it, to learn which plan they are on. The test uses a little of their Claude usage (a few points of the 5-hour limit). No money is charged. Wait for them to agree.
2. Clone the repository into `~/.claude/skills/usage-meter` (on Windows, `%USERPROFILE%\.claude\skills\usage-meter`). If the folder exists, update it with `git pull` instead.
3. Run `claude plugin validate ~/.claude/skills/usage-meter` and confirm it passes.
4. If Python 3 is available, run `backfill.py` in that folder so their existing conversations show their past cost. If it is not, skip this: the meter works without it.
5. Tell them to start a new session (or close and reopen Claude Desktop). The meter appears above the prompt box, runs its test after their first reply, and shows percentages once the test is done.

Do not edit the plan figures in the code to match what the person tells you their plan is. The test and the meter's own adjustment settle that.

## License

MIT. See [LICENSE](LICENSE).
