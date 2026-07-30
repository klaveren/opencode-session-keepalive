/**
 * SessionKeepalive Plugin — opencode
 * ---------------------------------------------------------------------------
 * Keeps the prompt cache of INTERACTIVE sessions warm during idle periods by sending
 * minimal no-op pings — and closes the window once pinging stops being cheaper than
 * letting the cache die.
 *
 * THE PROBLEM (measured, 2026-07-29):
 * A cached prefix only survives as long as its TTL past the last read. Walk away from a
 * session and the cache dies; come back and you re-pay the entire history at write price.
 * Real measurements (session ses_0500b1602ffe…, Opus 4.8): a 3.5 h gap cost a re-warm of
 * 214,936 tokens = US$ 1.34. An 8 min gap cost 162k = US$ 1.01. Every READ renews the TTL —
 * hence the ping.
 *
 * ✅ 1-HOUR TTL — ACTIVE (via the `cache-ttl` plugin, verified 2026-07-30):
 *     10:00:54  turn 1 → write 104,743  read       0
 *     10:16:00  turn 2 → write      14  read 104,743   ← 15 min gap: CACHE ALIVE
 * History: the CONFIG route failed twice (provider.options never reaches the request;
 * models.<id>.options does but creates a top-level marker that COLLIDES with the inline 5m
 * ones, HTTP 400). The fix was to stamp `ttl` onto the existing markers via a fetch wrapper.
 * Details and the captured body map: see the `cache-ttl` plugin.
 *
 * THE WINDOW IS NOT ARBITRARY (why this cannot run forever):
 * A ping costs 0.1x the prefix (cache read); a re-warm costs 2.0x (1h write). So pinging only
 * pays until the accumulated cost reaches one re-warm:
 *     2.0 / 0.1 = 20 pings  x  50 min  ≈  16 h   (ECONOMIC break-even)
 * 16 h is arithmetically right but operationally silly, so a 4 h OPERATIONAL ceiling applies —
 * see `windowMs`. Without any ceiling, a session left open on a Friday would ping all weekend:
 * ~640 pings ≈ 64x the cost of the single re-warm it was avoiding.
 *
 * SCOPE — INTERACTIVE SESSIONS ONLY, AND THAT IS THE RIGHT SCOPE (measured 2026-07-30):
 * This plugin lives INSIDE the opencode process, so it only reaches sessions of a long-lived
 * process (`opencode serve` / TUI) = interactive conversations. Sessions dispatched by
 * `opencode run` are DETACHED and one-shot — the process exits after the turn, no timer survives.
 *
 * ⛔ DO NOT build an external service to warm those. It was built, measured and DELETED:
 *   · NO VALUE — 405 inter-turn gaps across 34 durable pipeline sessions: 98.8% under 5 min,
 *     0.0% in the 1h-3h band a warmer could serve, 0.7% over 3h. The profile is BIMODAL (burst
 *     or hours of silence); the pipeline has NO medium idleness. Total saving over that entire
 *     history: ~US$2.70. Cache warming is a HUMAN-channel problem — which is this plugin.
 *   · ACTIVE DANGER — the only way to touch a detached session from outside is a second
 *     `opencode run --session <same>`, and two of those CORRUPT the session IRREVERSIBLY: they
 *     do not serialize, the contexts cross, the session accumulates consecutive `assistant`
 *     messages and every later request fails with HTTP 400 (assistant-prefill). A durable
 *     session carries 120k+ tokens — corrupting it is a total, unrecoverable loss.
 *
 * ✅ THIS plugin is NOT exposed to that: it pings through the SERVER API
 * (`ctx.client.session.prompt` → POST /session/:id/message), and the server SERIALIZES concurrent
 * turns on one session. Verified: two simultaneous prompts produced a clean user/assistant/user/
 * assistant sequence and the session stayed healthy. Corruption is specific to spawning a SECOND
 * PROCESS, not to concurrency itself. Never route a ping through `opencode run`.
 *
 * (Note that ../cache-ttl DOES work in detached runs, because wrapping `fetch` acts during the
 * request rather than after it.)
 *
 * HOOK CONTRACTS (source @opencode-ai/plugin):
 *     (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>
 *     "event":               (input: { event: { type, properties } }) => Promise<void>
 *     "tool.execute.before": (input: { tool, sessionID, callID }) => Promise<void>
 *
 * `options` arrive as the 2nd argument — which requires EXPLICIT registration using the tuple
 * form in opencode.json (an auto-discovered plugin has nowhere to receive config):
 *     "plugin": [["./.opencode/custom/plugin/session-keepalive/session-keepalive.js", { "windowMs": 14400000 }]]
 *
 * ⚠️ WHY THIS FILE DOES **NOT** LIVE IN `.opencode/plugins/`: that directory is AUTO-DISCOVERED
 * (`ConfigPlugin.load` globs `{plugin,plugins}/*.{ts,js}` and registers each as a bare STRING,
 * without options). Since auto-discovery is merged AFTER config files and the `file://` URL dedup
 * keeps the LAST occurrence (`deduplicatePluginOrigins`), a file present in both places would have
 * its `options` SILENTLY DISCARDED — the auto-discovered, config-less version would win. Outside
 * the globbed directory there is a single registration and options are guaranteed.
 *
 * Pure JS, no static imports: `.opencode/package.json` is gitignored, so the plugin must not
 * depend on node_modules. That keeps it working on any machine or clone. *
 * ---
 * Author:  Henrique Van Klaveren
 * License: MIT — see LICENSE
 */

/** Defaults — every one overridable through the `options` in opencode.json. */
const DEFAULTS = {
  /** Master switch. Defaults to TRUE. */
  enabled: true,
  /**
   * Time between pings (ms). MUST stay under the provider's TTL — today 1h (via cache-ttl).
   * ⚠️ COUPLED to cache-ttl: if that plugin is disabled the TTL drops back to 5 min and THIS
   * must go back to 270_000 (4.5 min) — otherwise the cache dies before every single ping.
   */
  intervalMs: 3_000_000, // 50 min
  /**
   * How long to keep warming after the last real turn (ms).
   * With a 1h TTL the ECONOMIC break-even is ~16 h (1 ping = 0.1x the prefix, 1 re-warm = 2.0x
   * → 20 pings x 50 min). Too slack in practice: a session idle that long has been abandoned.
   * 4 h is an OPERATIONAL ceiling — it covers a working day with breaks and auto-disarms whatever
   * was forgotten.
   */
  windowMs: 14_400_000, // 4 h
  /**
   * Eligible agent names. EMPTY (the default) means every agent is eligible.
   * Narrow this to the expensive, long-lived, ad-hoc conversations if you run a large agent
   * fleet — warming a session that will never be resumed is pure waste.
   */
  agents: [],
  /** Eligible providers (substring match on providerID). */
  providers: ['anthropic'],
  /** Warm child (subagent) sessions too? They are ephemeral — not worth it. */
  includeChildSessions: false,
  /** Log to stderr. NEVER stdout: that would corrupt the TUI protocol. */
  debug: false,
}

/**
 * The ping. It is a REAL agent turn (there is no `--no-reply`), so this text is the ONLY guard
 * against side effects — the `tool.execute.before` hook is the backstop.
 * Deliberately constant: the cached prefix is the PREVIOUS history, so a fixed text does not
 * disturb it.
 */
const PING_PROMPT =
  'KEEPALIVE (automated cache maintenance — this is not work). ' +
  'Do NOT use any tool. Do NOT read state, files, MCP or git. Do NOT take any action. ' +
  'Do NOT resume or continue anything. Reply with exactly: ok'

export const SessionKeepalivePlugin = async (ctx, options) => {
  const cfg = { ...DEFAULTS, ...(options ?? {}) }

  if (!cfg.enabled) return {}

  /** sessionID → { timer, deadline, pinging, eligible, sent } */
  const sessions = new Map()

  const log = (...args) => {
    if (cfg.debug) console.error('[session-keepalive]', ...args)
  }

  /** Eligibility: resolved ONCE per session (the answer cannot change). */
  const isEligible = async (sessionID) => {
    const known = sessions.get(sessionID)
    if (known && known.eligible !== undefined) return known.eligible
    try {
      const res = await ctx.client.session.get({ path: { id: sessionID } })
      const info = res?.data ?? res
      const agent = info?.agent
      const provider = info?.model?.providerID ?? ''
      const isChild = Boolean(info?.parentID)

      const ok =
        (!isChild || cfg.includeChildSessions) &&
        (cfg.providers.length === 0 || cfg.providers.some((p) => provider.includes(p))) &&
        (cfg.agents.length === 0 || (agent && cfg.agents.includes(agent)))

      log(`eligibility ${sessionID}: ${ok} (agent=${agent} provider=${provider} child=${isChild})`)
      return ok
    } catch (err) {
      log(`eligibility ${sessionID} failed:`, err?.message ?? err)
      return false
    }
  }

  const disarm = (sessionID, reason) => {
    const s = sessions.get(sessionID)
    if (!s?.timer) return
    clearInterval(s.timer)
    s.timer = undefined
    log(`disarmed ${sessionID} (${reason}) — ${s.sent} ping(s) sent`)
  }

  const ping = async (sessionID) => {
    const s = sessions.get(sessionID)
    if (!s) return

    // Window expired: past the break-even, pinging costs more than a re-warm.
    if (Date.now() >= s.deadline) {
      disarm(sessionID, 'window expired')
      return
    }

    s.pinging = true
    s.sent += 1
    try {
      const res = await ctx.client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: 'text', text: PING_PROMPT }] },
      })
      const info = res?.data?.info ?? res?.info
      const cache = info?.tokens?.cache ?? {}
      const read = Number(cache.read ?? 0)
      log(`ping #${s.sent} ${sessionID}: ${read > 0 ? 'HIT' : 'MISS'} read=${read} write=${Number(cache.write ?? 0)}`)
    } catch (err) {
      // Best-effort: the session may be gone, the server down, the model erroring.
      // NOT a concern here: a real turn being in flight. The server SERIALIZES concurrent prompts
      // on one session (verified 2026-07-30) — the ping queues behind the real turn and both land
      // cleanly. That serialization is what makes this plugin safe; see the SCOPE note in the header.
      log(`ping ${sessionID} failed:`, err?.message ?? err)
    } finally {
      s.pinging = false
    }
  }

  const arm = async (sessionID) => {
    const existing = sessions.get(sessionID)
    // Ignore the `idle` emitted by OUR OWN ping — otherwise the window would never expire.
    if (existing?.pinging) return

    if (!(await isEligible(sessionID))) {
      sessions.set(sessionID, { eligible: false, sent: 0 })
      return
    }

    const s = sessions.get(sessionID) ?? { sent: 0 }
    s.eligible = true
    // The window counts from the last REAL turn — re-arming on idle does not extend it.
    if (!s.timer) {
      s.deadline = Date.now() + cfg.windowMs
      s.sent = 0
      s.timer = setInterval(() => void ping(sessionID), cfg.intervalMs)
      log(`armed ${sessionID} — ${Math.round(cfg.windowMs / 60000)}min window, ping every ${Math.round(cfg.intervalMs / 1000)}s`)
    }
    sessions.set(sessionID, s)
  }

  log(`active — agents=[${cfg.agents.join(',')}] providers=[${cfg.providers.join(',')}]`)

  return {
    event: async ({ event }) => {
      const type = event?.type
      const props = event?.properties ?? {}

      if (type === 'session.idle') {
        const sessionID = props.sessionID
        if (sessionID) await arm(sessionID)
        return
      }

      // A REAL user turn → disarm (a new window opens on the next idle).
      if (type === 'message.updated') {
        const info = props.info
        const sessionID = info?.sessionID ?? props.sessionID
        if (!sessionID) return
        const s = sessions.get(sessionID)
        if (s?.pinging) return // our own ping also emits message.updated
        if (info?.role === 'user') disarm(sessionID, 'real user turn')
        return
      }

      if (type === 'session.deleted') {
        const sessionID = props.sessionID ?? props.info?.id
        if (!sessionID) return
        disarm(sessionID, 'session deleted')
        sessions.delete(sessionID)
      }
    },

    // BACKSTOP: if the model ignores PING_PROMPT and tries to use a tool during a ping, block it.
    // The guard is PER SESSION — real turns are never affected.
    'tool.execute.before': async (input) => {
      if (sessions.get(input.sessionID)?.pinging) {
        throw new Error('session-keepalive: tools are disabled during a keepalive ping')
      }
    },

    dispose: async () => {
      for (const sessionID of sessions.keys()) disarm(sessionID, 'shutdown')
      sessions.clear()
    },
  }
}

export default SessionKeepalivePlugin
