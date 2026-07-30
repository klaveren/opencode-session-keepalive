# session-keepalive

> An opencode plugin that keeps idle sessions' prompt caches alive with minimal pings — and knows
> exactly when to stop, because keeping warm forever costs more than letting the cache die.

**~200 lines. Zero dependencies. Pure JS.**

---

## TL;DR

A cached prefix survives only as long as its TTL past the last read. Walk away from a session and
the cache dies; come back and you re-pay the entire history at write price.

This plugin arms a timer when a session goes idle, sends a no-op ping just under the TTL, and
**closes the window once pinging stops being cheaper than re-warming**. That break-even isn't a
guess — it's a division.

```
14:00  last real turn → session.idle → ARM (deadline = now + windowMs)
14:50  ping #1  ✓   read renews the TTL
15:40  ping #2  ✓
  …
18:00  ping #5  ✗   past the deadline → DISARM, let the cache die
```

---

## The Problem

We profiled a real agent session and found that **idle time, not work, was the expensive part**:

| Gap | Cost of the re-warm | Model |
| --- | --- | --- |
| 8 minutes | 162,474 tokens = **$1.01** | Opus 4.8 |
| 3.5 hours | 214,936 tokens = **$1.34** | Opus 4.8 |
| 6.9 min (subagent wait) | 150,372 tokens = **$0.94** | Opus 4.8 |

Every gap past the TTL means the *whole* prefix gets re-written — and the prefix only grows. In one
25-minute session we watched it go from **116k → 215k tokens (+84%)**. The later the re-warm, the
more it costs.

A cache **read** costs `0.1×` the base input price. A **write** costs `1.25×` (5m TTL) or `2.0×`
(1h TTL). So a ping — which is just a read — is roughly **an order of magnitude cheaper** than
letting the cache lapse. Up to a point.

---

## The Math (this is the whole design)

### Why the interval must sit *just under* the TTL

Each read renews the TTL. Ping too late and you're re-warming instead of refreshing; ping too often
and you pay for reads you didn't need. The interval wants to be as long as possible while staying
safely inside the window:

| Provider TTL | Interval | Margin | Pings/hour |
| --- | --- | --- | --- |
| 5 min (Anthropic default) | **4.5 min** | 30s for jitter/latency | 13.3 |
| 1 h (with `cache-ttl`) | **50 min** | 10 min | 1.2 |

That single row is why `cache-ttl` matters so much here: **11× fewer pings for the same coverage.**

### Why the window must close — the break-even coefficient

Pinging is not free. `N` pings cost `N × 0.1×` the prefix. A re-warm costs `1.25×` or `2.0×`.
Keeping a session warm only pays while the accumulated ping cost stays under one re-warm:

```
        re-warm cost
N_max = ────────────
         ping cost

5m TTL:  1.25 / 0.1 = 12.5 pings  ×  4.5 min  ≈   55 minutes
1h TTL:  2.00 / 0.1 = 20.0 pings  ×  50 min   ≈  16.7 hours
```

**Past `N_max`, pinging costs more than letting the cache die.** So the window closes, we accept the
re-warm, and the session goes cold. Without that ceiling, a session left open on a Friday would ping
all weekend: ~640 pings ≈ **64× the cost of the single re-warm it was avoiding.**

### Economic ceiling vs. operational ceiling

16.7 hours is *arithmetically* correct and *operationally* silly — a session idle that long has been
abandoned. Two ceilings apply, and **the tighter one wins**:

| Ceiling | 5m TTL | 1h TTL |
| --- | --- | --- |
| **Economic** (the math above) | 55 min | 16.7 h |
| **Operational** (is this session still real?) | — | ~4 h |
| **Effective `windowMs`** | **55 min** | **4 h** |

With a 5-minute TTL the economics bind first, so no operational ceiling is needed. With a 1-hour TTL
the economics go slack, so judgment takes over: 4 hours covers a working day with lunch and meetings,
and auto-disarms anything forgotten.

### Where the value actually is

The net gain is front-loaded. Measured against a 215k prefix on Opus 4.8, where one re-warm is worth
$1.34:

| You come back after | Pings sent | Spent | Saved | **Net** |
| --- | --- | --- | --- | --- |
| 5 min | 1 | $0.11 | $1.34 | **+$1.24** |
| 10 min | 2 | $0.21 | $1.34 | **+$1.13** |
| 30 min | 6 | $0.65 | $1.34 | **+$0.70** |
| 45 min | 10 | $1.07 | $1.34 | **+$0.27** |
| 55 min | 12 | $1.29 | $1.34 | **+$0.05** |
| **never** | 12 | $1.29 | — | **−$1.29** ← bounded by the window |

Coffee breaks are where this shines. The last row is the point of `windowMs`: it caps the maximum
possible waste. *(Figures shown for a 5m TTL, where the curve is steepest; with `cache-ttl` active
the same shape holds over a 4-hour window at ~1/11th the cost.)*

---

## The Solution

```
session.idle          → check eligibility (once per session, cached) → arm a timer
every intervalMs      → if now < deadline: send a no-op ping (a cache read renews the TTL)
                        if now ≥ deadline: disarm and let the cache lapse
real user turn        → disarm (a new window opens on the next idle)
session.deleted       → disarm and forget
```

Eligibility is deliberately narrow. Warming everything would burn pings on sessions that will never
be resumed:

- **By agent** — only the expensive, long-lived, ad-hoc conversations
- **By provider** — only providers with a prompt cache worth preserving
- **Not child sessions** — subagent sessions are ephemeral by design

---

## Install

```bash
npm install opencode-session-keepalive
```

```jsonc
// opencode.json
{ "plugin": [["opencode-session-keepalive", { "windowMs": 14400000 }]] }
```

Or vendor the single file into your project and register it by path. Restart the opencode server
afterwards — config is cached.

---

## Configuration

Register **explicitly** with the tuple form. The file must live **outside** `.opencode/plugins/`
(see *Plugin registration* under Caveats):

```jsonc
{
  "plugin": [
    ["./.opencode/custom/plugin/session-keepalive/session-keepalive.js", {
      "intervalMs": 3000000,
      "windowMs": 14400000,
      "agents": ["my-expensive-agent"],
      "providers": ["anthropic"],
      "debug": false
    }]
  ]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Master switch. When `false`, no timers or hooks are registered. |
| `intervalMs` | `number` | `3_000_000` (50 min) | Time between pings. **Must stay under the provider's TTL.** |
| `windowMs` | `number` | `14_400_000` (4 h) | How long to keep warming after the last real turn. See *The Math*. |
| `agents` | `string[]` | `[]` (all) | Eligible agent names. Narrow this to your expensive, long-lived agents — warming a session that never gets resumed is pure waste. |
| `providers` | `string[]` | `["anthropic"]` | Eligible provider substrings. `[]` means all. |
| `includeChildSessions` | `boolean` | `false` | Warm subagent sessions too. Off — they're ephemeral. |
| `debug` | `boolean` | `false` | Log to **stderr** (never stdout — that corrupts the TUI). |

> ⚠️ **`intervalMs` is coupled to your provider's TTL.** The defaults above assume a **1-hour** TTL
> (via `cache-ttl`). On a stock 5-minute TTL, use `intervalMs: 270000` (4.5 min)
> and `windowMs: 3300000` (55 min) — a 50-minute interval against a 5-minute TTL means the cache
> dies before every single ping, which is **worse than no keepalive at all**.

With `debug: true`:

```
[session-keepalive] active — agents=[my-agent,my-other-agent] providers=[anthropic]
[session-keepalive] eligibility ses_a1b2…: true (agent=my-agent provider=anthropic child=false)
[session-keepalive] armed ses_a1b2… — 240min window, ping every 3000s
[session-keepalive] ping #1 ses_a1b2…: HIT read=214649 write=312
[session-keepalive] disarmed ses_a1b2… (real user turn) — 1 ping(s) sent
```

---

## Internals

### The Law of the Process

**A plugin lives inside the opencode process and does not outlive it.**

| Context | Process | Timer-based plugin |
| --- | --- | --- |
| `opencode serve` · TUI · web | long-lived | ✅ works |
| `opencode run` (detached, single turn) | **exits after one turn** | ❌ **no-op** |

In a one-shot run the sequence is: boot → load plugins → one turn → `session.idle` → *(timer armed)*
→ scope closes → `dispose` clears the timer → process exits. The ping never fires.

So if you dispatch agents via `opencode run`, **this plugin cannot help them** — only something in a
separate long-lived service can, by spawning a fresh process to touch the orphaned session. Note
that `cache-ttl` *does* work there, because `fetch` wrapping acts during the
request rather than after it.

### Guards

- **Overlap** — a session already mid-ping is skipped, so the `session.idle` our own ping emits can't
  re-arm the window and keep it alive forever.
- **Eligibility caching** — resolved once per session; the answer can't change.
- **Never pings without a session id** — a new session warms nothing and pays a full cold boot.
- **`dispose`** — clears every timer on shutdown. Not optional: a pending `setInterval` keeps the
  Node event loop alive and would hang the process.

### State is in memory — restarts start from zero

The plugin tracks armed sessions in a plain `Map`. A server restart wipes it, and the plugin only
learns a session exists when an event fires for it — and `session.idle` only fires **after a turn
completes**.

So: **a session that was idle before the restart and stays idle is never armed.** Nothing pings it,
and its cache lapses. Interact with it once and it arms normally on the next idle.

**This is deliberate, not an oversight.** Auto-arming recent sessions on boot looks like an easy
win, but it is a coin flip:

| Restart flavour | Cache state | Auto-arming would… |
| --- | --- | --- |
| Config unchanged | **alive** — it lives on the provider's side, not yours | help |
| Config/plugin/model changed | **already dead** — the prefix hash changed | pay a cold write at `2.0x` for nothing |

The plugin cannot tell the two apart *before* pinging — it only finds out from the HIT/MISS of the
ping it already paid for. And since a restart usually accompanies a config change, auto-arming
would tend to buy re-warms nobody asked for. On a 150k prefix that is roughly **$0.60 per session,
per restart**, spent on speculation.

The natural trigger is better: you come back, you send a message, the re-warm happens because there
is real work — not because a timer guessed there might be.

### The ping is a real turn

`opencode run` has no `--no-reply`. The ping is a genuine model turn, so the prompt text is the only
thing standing between a keepalive and an agent that decides to *do something*. Two layers:

1. The prompt explicitly forbids tools, state reads, and any action — it asks for `ok` and nothing else.
2. A `tool.execute.before` hook **blocks tool execution** while a ping is in flight (scoped per
   session, so real turns are untouched).

Output cost is ~10 tokens. The value is entirely in the *read* of the prefix, which is what renews
the TTL.

---

## Caveats

- **Pings enter the conversation history.** Each one adds ~50–100 permanent tokens to the prefix.
  Negligible, but not zero. (Some plugins revert the synthetic turn via `session.revert` — we
  deliberately don't: that API restores file snapshots, which is far too heavy for a keepalive.)
- **Plugin registration.** Lives in `.opencode/custom/plugin/session-keepalive/`, *not* `.opencode/plugins/`. Files in
  `{plugin,plugins}/` are auto-discovered as bare strings **without options**, and since
  auto-discovery merges after config files with last-one-wins dedup, a file in both places has its
  options silently dropped.
- **Interval/TTL coupling.** Repeated because it's the one setting that can make things worse: see
  the warning under Configuration.

---

## Verification

```bash
# is it arming?
grep "session-keepalive" server.log

# did a ping actually hit the cache? (HIT means the read renewed the TTL)
grep "ping #" server.log
```

The economics only work if pings register as reads. A ping logging `MISS` with a large `write` means
the interval is longer than the real TTL — check that `intervalMs` matches your provider's TTL.

---

## Credits

Written by **Henrique Van Klaveren**, from a measured investigation into opencode's prompt-cache
behaviour. Every number in this README came from a real session — nothing is estimated.

## License

MIT — see [`LICENSE`](./LICENSE). Use it however you like.
