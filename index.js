/**
 * dsh-next-prompt — host half.
 *
 * Watches the durable session event feed for completed turns on root sessions,
 * asks the harness LLM service (`ctx.llm`) for a few short "next prompt"
 * suggestions in the conversation's language, keeps the per-session result in
 * memory, and serves it to the browser half over a small same-origin JSON API
 * registered on the `webServer` service:
 *
 *   GET  /next-prompt/suggest?session=<id>  → { ok, sessionId, suggestions, source, generatedAt, pending? }
 *   GET  /next-prompt/config                → { ok, enabled, maxSuggestions, showGhost }
 *   POST /next-prompt/regenerate            → same shape as suggest (same-origin guarded)
 *
 * Design constraints (see next-prompt/BRIEF.md and research/host.md):
 *   - never write to the session log, never expose a model-facing tool;
 *   - no imports beyond Node built-ins, no new dependencies;
 *   - one small non-streaming completion per completed turn, cancelled when
 *     superseded, with a deterministic heuristic fallback whenever the LLM is
 *     absent, slow, failing, or returns garbage;
 *   - every entry point is defensive: a bug here must not break the host or
 *     any other plugin. Listeners catch everything; routes always answer JSON.
 *
 * Verified against the shipped DSH 0.2.1-rc.5 build (app.asar). Evidence paths
 * and exact signatures are collected in ../research/host.md.
 */

/** Plugin identity used in logs and diagnostics. */
const PLUGIN_NAME = 'dsh-next-prompt'

/** Fixed HTTP surface. The browser half and the host docs hardcode these
 * paths; keeping them non-configurable removes a silent breakage footgun. */
const ROUTE_BASE = '/next-prompt'

/** Row config defaults; every field is optional in the patch row. */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  maxSuggestions: 3,
  language: 'auto',
  model: '',
  showGhost: true,
  minAnswerChars: 40,
})

/** Hard deadline for one suggestion completion. */
const LLM_TIMEOUT_MS = 15000
/** Output budget for one suggestion completion: a few short strings. */
const LLM_MAX_TOKENS = 512
/** Characters of the last user message fed to the model. */
const PROMPT_USER_CHARS = 1500
/** Characters of the assistant answer fed to the model (tail-biased). */
const PROMPT_ANSWER_CHARS = 3000
/** Hard cap on one suggestion's length. */
const SUGGESTION_MAX_CHARS = 220
/** Bounded number of tracked sessions (memory safety on long-lived hosts). */
const MAX_TRACKED_SESSIONS = 256

/** Reasoning-effort ids ordered lowest-first; adapter-owned ids outside the
 * ladder are ignored while ranking but still valid routes. */
const REASONING_EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Single-line validators. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/

/** Deterministic language-matched fallback suggestions. */
const HEURISTIC_SUGGESTIONS = Object.freeze({
  ru: Object.freeze([
    'Продолжай',
    'Добавь тесты к этому изменению',
    'Проверь, что ничего не сломалось',
    'Объясни подробнее',
    'Что дальше?',
  ]),
  en: Object.freeze([
    'Continue',
    'Add tests for this change',
    'Double-check that nothing broke',
    'Explain in more detail',
    "What's next?",
  ]),
})

/** Fallback first suggestion when the assistant asked the user a question. */
const HEURISTIC_ANSWER_QUESTION = Object.freeze({
  ru: 'Да, продолжай',
  en: 'Yes, go ahead',
})

// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------

/**
 * Normalize one row config into the internal options object.
 *
 * Unknown keys and invalid values are ignored rather than rejected: a plugin
 * config typo must not stop the host from booting.
 * @param {unknown} raw - the row `config` mapping (may be undefined).
 * @returns {typeof DEFAULT_CONFIG} resolved options.
 */
function normalizeConfig(raw) {
  const options = { ...DEFAULT_CONFIG }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return options

  if (typeof raw.enabled === 'boolean') options.enabled = raw.enabled
  if (typeof raw.showGhost === 'boolean') options.showGhost = raw.showGhost

  if (typeof raw.maxSuggestions === 'number' && Number.isFinite(raw.maxSuggestions)) {
    options.maxSuggestions = clampInt(raw.maxSuggestions, 1, 10, DEFAULT_CONFIG.maxSuggestions)
  }
  if (typeof raw.minAnswerChars === 'number' && Number.isFinite(raw.minAnswerChars)) {
    options.minAnswerChars = clampInt(raw.minAnswerChars, 0, 100000, DEFAULT_CONFIG.minAnswerChars)
  }
  if (raw.language === 'auto' || raw.language === 'ru' || raw.language === 'en') {
    options.language = raw.language
  }

  if (typeof raw.model === 'string') options.model = raw.model.trim().slice(0, 200)

  return options
}

/** Clamp a finite number to an integer within [min, max]. */
function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (!Number.isFinite(rounded)) return fallback
  return Math.min(max, Math.max(min, rounded))
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Read an Error-ish value's message without ever throwing. */
function messageOf(error) {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/** Log a warning through the plugin's context logger, never throwing. */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`${PLUGIN_NAME}: ${message}`)
  } catch {
    /* a logger failure must not escape */
  }
}

/** Log a debug line when the logger supports it; failures are ignored. */
function debug(ctx, message) {
  try {
    const logger = ctx.logger
    if (logger !== null && typeof logger === 'object' && typeof logger.debug === 'function') {
      logger.debug(`${PLUGIN_NAME}: ${message}`)
    }
  } catch {
    /* ignore */
  }
}

/** Extract visible text from a message's content blocks. */
function messageText(message) {
  try {
    const content = message?.content
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
    return parts.join('\n').trim()
  } catch {
    return ''
  }
}

/** Tail-biased truncation for long model input (the end matters most). */
function tailClip(text, max) {
  const value = String(text)
  if (value.length <= max) return value
  return `…(${value.length - max} chars elided)…\n${value.slice(value.length - max)}`
}

// ---------------------------------------------------------------------------
// Root-session and turn classification
// ---------------------------------------------------------------------------

/**
 * Root sessions only: subagent children are excluded by their durable
 * `origin`, and by a creator id (historical ordinary forks may keep one, so
 * `origin` remains the primary classifier — the same rule the shipped
 * dsh-macos-notifications host plugin uses).
 * @param {unknown} session - candidate session object.
 * @returns {boolean} whether this is a top-level session.
 */
function isRootSession(session) {
  try {
    const header = session?.header
    if (header === null || typeof header !== 'object') return false
    if (header.origin === 'subagent') return false
    if (header.parentSession !== undefined && header.parentSession !== null) return false
    return true
  } catch {
    return false
  }
}

/** Whether a `turn/end` reason represents a successfully completed turn. */
function isCompletedTurn(reason) {
  return reason !== null && typeof reason === 'object' && reason.kind === 'completed'
}

/** Whether a `turn/end` reason should clear any pending suggestion state. */
function isTerminalNonCompleted(reason) {
  if (reason === null || typeof reason !== 'object') return false
  return reason.kind === 'aborted' || reason.kind === 'forked' || reason.kind === 'interrupted'
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Mount the host half of dsh-next-prompt.
 * @param {import('@deepseek-ai/cordis').Context} ctx - this row's Cordis context.
 * @param {unknown} config - the row's `config` mapping; unknown fields ignored.
 */
export function apply(ctx, config) {
  if (ctx === null || typeof ctx !== 'object') return

  const options = normalizeConfig(config)

  /** @type {Map<string, SessionState>} per-session suggestion state */
  const states = new Map()
  /** @type {Map<string, {userText: string, answerText: string}>} event-feed fallback */
  const trackers = new Map()

  /** Whether the HTTP routes are currently registered (suggestions are pointless without them). */
  let routesActive = false

  // ------------------------------------------------------------------
  // State bookkeeping
  // ------------------------------------------------------------------

  /** Drop one session's state, cancelling any in-flight completion. */
  function clearState(sessionId, reason) {
    const state = states.get(sessionId)
    if (state === undefined) return
    states.delete(sessionId)
    try {
      state.controller?.abort(new Error(`${PLUGIN_NAME}: ${reason}`))
    } catch {
      /* ignore */
    }
    if (state.timer !== undefined) {
      try {
        clearTimeout(state.timer)
      } catch {
        /* ignore */
      }
    }
  }

  /** Forget a session entirely (state + tracker); called on session disposal. */
  function forgetSession(sessionId) {
    clearState(sessionId, 'session disposed')
    trackers.delete(sessionId)
  }

  /** Bound both maps so a long-lived host cannot grow without limit. */
  function enforceBounds() {
    while (states.size > MAX_TRACKED_SESSIONS) {
      const oldest = states.keys().next()
      if (oldest.done === true) break
      clearState(oldest.value, 'evicted')
    }
    while (trackers.size > MAX_TRACKED_SESSIONS) {
      const oldest = trackers.keys().next()
      if (oldest.done === true) break
      trackers.delete(oldest.value)
    }
  }

  // ------------------------------------------------------------------
  // Text collection
  // ------------------------------------------------------------------

  /**
   * Collect the material for one suggestion: the latest human prompt and the
   * assistant answer that just completed.
   *
   * Primary source is `session.deriveMessages()` (the same surface projection
   * the model sees, compaction-safe); the event-feed tracker covers a session
   * object that cannot derive messages and a turn whose events arrived while
   * the plugin loaded.
   * @param {any} session - live session object.
   * @param {{userText?: string, answerText?: string}|undefined} tracker - tracked event fallback.
   * @returns {{userText: string, answerText: string}}
   */
  function collectTurnTexts(session, tracker) {
    let userText = ''
    let answerText = ''

    try {
      if (typeof session?.deriveMessages === 'function') {
        const messages = session.deriveMessages()
        if (Array.isArray(messages)) {
          let humanUserText = ''
          let anyUserText = ''
          let assistantText = ''
          for (const message of messages) {
            if (message === null || typeof message !== 'object') continue
            if (message.role === 'user') {
              const text = messageText(message)
              if (text.length === 0) continue
              anyUserText = text
              if (message.source?.kind === 'user') humanUserText = text
            } else if (message.role === 'assistant') {
              const text = messageText(message)
              if (text.length > 0) assistantText = text
            }
          }
          userText = humanUserText.length > 0 ? humanUserText : anyUserText
          answerText = assistantText
        }
      }
    } catch {
      /* fall through to the event-feed tracker */
    }

    if (userText.length === 0 && typeof tracker?.userText === 'string') userText = tracker.userText
    if (answerText.length === 0 && typeof tracker?.answerText === 'string') answerText = tracker.answerText

    return { userText, answerText }
  }

  // ------------------------------------------------------------------
  // Language + heuristic
  // ------------------------------------------------------------------

  /**
   * Resolve the suggestion language: forced by config or detected from the
   * user's own message (a Russian user's prompt with English code is still
   * Russian; counting all text would skew toward the answer's identifiers).
   * @param {string} configured - 'auto' | 'ru' | 'en'.
   * @param {{userText: string, answerText: string}} texts - turn material.
   * @returns {'ru'|'en'} resolved language.
   */
  function resolveLanguage(configured, texts) {
    if (configured === 'ru' || configured === 'en') return configured
    const sample = `${texts.userText}\n${texts.answerText}`.slice(0, 4000)
    const cyrillic = (sample.match(/[\u0400-\u04FF]/gu) ?? []).length
    const latin = (sample.match(/[A-Za-z]/gu) ?? []).length
    if (cyrillic >= 2 && cyrillic / Math.max(1, cyrillic + latin) >= 0.2) return 'ru'
    return 'en'
  }

  /**
   * Deterministic fallback suggestions in the resolved language.
   * @param {'ru'|'en'} language - resolved language.
   * @param {string} answerText - the assistant answer that just completed.
   * @param {number} maxSuggestions - how many to return.
   * @returns {string[]} suggestions.
   */
  function heuristicSuggestions(language, answerText, maxSuggestions) {
    const base = [...(HEURISTIC_SUGGESTIONS[language] ?? HEURISTIC_SUGGESTIONS.en)]
    const tail = answerText.slice(-400).trim()
    if (tail.endsWith('?') || tail.endsWith('？')) {
      const opener = HEURISTIC_ANSWER_QUESTION[language] ?? HEURISTIC_ANSWER_QUESTION.en
      base.unshift(opener)
    }
    return base.slice(0, Math.max(1, maxSuggestions))
  }

  // ------------------------------------------------------------------
  // Model route resolution
  // ------------------------------------------------------------------

  /**
   * Parse the `model` config override. Accepts `provider/model` (canonical) or
   * a bare model id (paired with the session/default provider).
   * @param {string} value - trimmed config value.
   * @returns {{provider?: string, model?: string}|undefined} parsed override.
   */
  function parseModelOverride(value) {
    if (typeof value !== 'string' || value.length === 0) return undefined
    const slash = value.indexOf('/')
    if (slash > 0 && slash < value.length - 1) {
      const provider = value.slice(0, slash).trim()
      const model = value.slice(slash + 1).trim()
      if (provider.length > 0 && model.length > 0) return { provider, model }
      return undefined
    }
    if (slash === 0) {
      const model = value.slice(1).trim()
      return model.length > 0 ? { model } : undefined
    }
    return { model: value }
  }

  /** Read the exact route the session's latest recorded request used. */
  function sessionRoute(session) {
    try {
      const config = session?.requestHeader?.()?.config
      if (config !== null && typeof config === 'object'
        && typeof config.provider === 'string' && config.provider.length > 0
        && typeof config.model === 'string' && config.model.length > 0) {
        return { provider: config.provider, model: config.model }
      }
    } catch {
      /* ignore */
    }
    return undefined
  }

  /** Read the profile's default model selection (`agentDefaultModel` service). */
  function defaultRoute() {
    try {
      const service = ctx.get('agentDefaultModel')
      if (service === null || typeof service !== 'object' || typeof service.currentSelection !== 'function') return undefined
      const selection = service.currentSelection()
      if (selection !== null && typeof selection === 'object'
        && typeof selection.provider === 'string' && selection.provider.length > 0
        && typeof selection.model === 'string' && selection.model.length > 0) {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      /* ignore */
    }
    return undefined
  }

  /**
   * Resolve provider+model for the auxiliary completion:
   *   1. config `model` (with an explicit or resolved provider),
   *   2. the session's latest `request/header` route,
   *   3. the profile default model.
   * @param {any} session - live session object.
   * @returns {{provider: string, model: string}|undefined} route or undefined.
   */
  function resolveRoute(session) {
    const override = parseModelOverride(options.model)
    if (override !== undefined && override.provider !== undefined) {
      return { provider: override.provider, model: override.model }
    }
    const recorded = sessionRoute(session)
    if (recorded !== undefined) {
      return override !== undefined && override.model !== undefined
        ? { provider: recorded.provider, model: override.model }
        : recorded
    }
    const fallback = defaultRoute()
    if (fallback !== undefined) {
      return override !== undefined && override.model !== undefined
        ? { provider: fallback.provider, model: override.model }
        : fallback
    }
    return undefined
  }

  /** Read the LLM service lazily (it must never be a hard dependency). */
  function llmService() {
    try {
      const service = ctx.get('llm')
      if (service !== null && typeof service === 'object' && typeof service.stream === 'function') return service
    } catch {
      /* ignore */
    }
    return undefined
  }

  /**
   * The lowest reasoning effort the model advertises, so a suggestion call does
   * not spend its whole output budget thinking (the DeepSeek adapter defaults
   * to a high level). Returns undefined for non-reasoning models — passing an
   * effort to such a model is rejected, so the field must be omitted entirely.
   * @param {any} llm - LLM runtime service.
   * @param {{provider: string, model: string}} route - resolved route.
   * @param {AbortSignal} signal - cancellation for adapter-owned metadata lookup.
   * @returns {Promise<string|undefined>} effort id or undefined.
   */
  async function lowestReasoningEffort(llm, route, signal) {
    try {
      if (typeof llm.resolveModelInfo !== 'function') return undefined
      const info = await Promise.resolve(llm.resolveModelInfo(route.provider, route.model, signal)).catch(() => undefined)
      const efforts = info?.reasoning?.efforts
      if (!Array.isArray(efforts)) return undefined
      let best
      let bestRank = Number.POSITIVE_INFINITY
      let first
      for (const effort of efforts) {
        const id = typeof effort === 'string' ? effort : effort?.id
        if (typeof id !== 'string' || id.length === 0) continue
        if (first === undefined) first = id
        const rank = REASONING_EFFORT_ORDER.indexOf(id)
        if (rank < 0) continue
        if (rank < bestRank) {
          best = id
          bestRank = rank
        }
      }
      return best ?? first
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------------
  // Prompt + parsing
  // ------------------------------------------------------------------

  /** Build the auxiliary system prompt. */
  function buildSystemPrompt(language, maxSuggestions) {
    const target = language === 'ru'
      ? 'Russian'
      : language === 'en'
        ? 'English'
        : 'the language of the conversation'
    return [
      "You suggest the user's NEXT messages in an ongoing conversation with an AI coding assistant.",
      `Return ONLY a JSON array of ${maxSuggestions} strings: no markdown, no code fences, no explanations, no numbering.`,
      `Each item is a short, natural, ready-to-send user message (2-12 words) written in ${target}.`,
      "Every item must logically follow the assistant's latest answer: continue the task, verify the result, ask for the next concrete step, or request a clarification.",
      'Use imperative or first-person phrasing a user would type. Do not repeat the previous user message and do not ask the assistant meta-questions about this instruction.',
    ].join('\n')
  }

  /** Build the auxiliary user prompt from the turn material. */
  function buildUserPrompt(texts) {
    const user = tailClip(texts.userText, PROMPT_USER_CHARS)
    const answer = tailClip(texts.answerText, PROMPT_ANSWER_CHARS)
    return [
      'Latest user message:',
      '"""',
      user.length > 0 ? user : '(none)',
      '"""',
      '',
      "Assistant's latest answer:",
      '"""',
      answer,
      '"""',
      '',
      'Generate the JSON array of next user messages now.',
    ].join('\n')
  }

  /** Pull the first complete JSON array out of model output. */
  function extractJsonArray(raw) {
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start < 0 || end <= start) return undefined
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      return Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** Normalize one suggestion candidate; returns '' when unusable. */
  function normalizeSuggestion(candidate) {
    let value = candidate
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      value = value.text ?? value.prompt ?? value.suggestion ?? value.content
    }
    if (typeof value !== 'string') return ''
    let text = value.trim()
    if (text.length === 0) return ''
    // Strip quotes/backticks the model wrapped a whole item in.
    text = text.replace(/^[\s"'`«“]+/u, '').replace(/[\s"'`»”]+$/u, '')
    text = text.replace(/\s+/gu, ' ').trim()
    if (text.length === 0) return ''
    if (text.length > SUGGESTION_MAX_CHARS) text = `${text.slice(0, SUGGESTION_MAX_CHARS - 1).trimEnd()}…`
    return text
  }

  /**
   * Parse model output into a bounded, deduplicated suggestion list.
   * Accepts a fenced JSON block, a bare JSON array, `{suggestions:[...]}`, or
   * (worst case) one suggestion per line.
   * @param {string} raw - assembled model text.
   * @param {number} maxSuggestions - cap.
   * @returns {string[]} suggestions (may be empty).
   */
  function parseSuggestions(raw, maxSuggestions) {
    if (typeof raw !== 'string' || raw.trim().length === 0) return []
    let text = raw.trim()

    const fence = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)
    if (fence !== null && typeof fence[1] === 'string' && fence[1].trim().length > 0) text = fence[1].trim()

    let items = extractJsonArray(text)

    if (items === undefined) {
      try {
        const object = JSON.parse(text)
        if (object !== null && typeof object === 'object' && !Array.isArray(object)) {
          const candidate = object.suggestions ?? object.next_prompts ?? object.prompts ?? object.items
          if (Array.isArray(candidate)) items = candidate
        }
      } catch {
        /* not JSON */
      }
    }

    if (items === undefined) {
      // Last resort: one suggestion per line. This only runs for clearly
      // line-shaped output; prose (a sentence with punctuation) and broken
      // JSON are treated as garbage so the deterministic heuristic wins.
      if (text.includes('[')) return []
      const lines = text
        .split(/\r?\n/u)
        .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, '').trim())
        .filter(line => line.length > 0)
      if (lines.length >= 2) {
        items = lines
      } else if (lines.length === 1 && lines[0].length <= 120 && !/[.!?](?:\s|$)/u.test(lines[0])) {
        items = lines
      }
    }

    const suggestions = []
    const seen = new Set()
    for (const item of items) {
      const normalized = normalizeSuggestion(item)
      if (normalized.length === 0) continue
      const key = normalized.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      suggestions.push(normalized)
      if (suggestions.length >= maxSuggestions) break
    }
    return suggestions
  }

  // ------------------------------------------------------------------
  // Generation
  // ------------------------------------------------------------------

  /**
   * Run one auxiliary completion and return parsed suggestions.
   * Throws on unavailable/failing providers, aborts, or unparsable output; the
   * caller keeps the heuristic list in that case.
   * @param {{provider: string, model: string}} route - resolved model route.
   * @param {'ru'|'en'} language - resolved output language.
   * @param {{userText: string, answerText: string}} texts - turn material.
   * @param {AbortSignal} signal - per-generation cancellation (supersede/timeout/dispose).
   * @returns {Promise<string[]>} parsed suggestions.
   */
  async function generateSuggestions(route, language, texts, signal) {
    const llm = llmService()
    if (llm === undefined) throw new Error('LLM service is unavailable')

    const effort = await lowestReasoningEffort(llm, route, signal)
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: buildUserPrompt(texts) }],
    }]
    const request = {
      provider: route.provider,
      model: route.model,
      messages,
      system: buildSystemPrompt(language, options.maxSuggestions),
      maxTokens: LLM_MAX_TOKENS,
      signal,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }

    let text = ''
    let finishKind = ''
    for await (const chunk of llm.stream(request)) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (text.length > 20000) throw new Error('model output is unreasonably large')
      } else if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind ?? ''
        if (finishKind === 'error') {
          const failure = chunk.reason?.failure
          const failureMessage = typeof failure?.message === 'string' && failure.message.length > 0
            ? failure.message
            : 'model request failed'
          throw new Error(failureMessage)
        }
        if (finishKind === 'aborted') throw new Error('model request was aborted')
      }
    }
    if (signal.aborted) throw new Error('model request was aborted')

    const suggestions = parseSuggestions(text, options.maxSuggestions)
    if (suggestions.length === 0) {
      throw new Error(`model returned no usable suggestions (finish=${finishKind || 'none'})`)
    }
    return suggestions
  }

  /**
   * Publish a state object, evicting the oldest session when over budget.
   * @param {string} sessionId - owning session.
   * @param {SessionState} state - complete state record.
   */
  function publishState(sessionId, state) {
    states.delete(sessionId)
    states.set(sessionId, state)
    enforceBounds()
  }

  /** Whether this state object is still the published state for its session. */
  function isCurrentState(sessionId, state) {
    return states.get(sessionId) === state
  }

  /**
   * Start (or restart) one generation for a completed turn: publish the
   * heuristic list synchronously, then refine it with the LLM asynchronously.
   * Never throws.
   * @param {any} session - live session object.
   * @param {{userText: string, answerText: string}} texts - collected turn material.
   */
  function startGeneration(session, texts) {
    let sessionId
    try {
      sessionId = session?.id
    } catch {
      return
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) return

    clearState(sessionId, 'superseded by a newer turn')

    const language = resolveLanguage(options.language, texts)
    const heuristic = heuristicSuggestions(language, texts.answerText, options.maxSuggestions)
    const route = resolveRoute(session)
    const controller = new AbortController()
    const state = {
      sessionId,
      suggestions: heuristic,
      source: 'heuristic',
      generatedAt: Date.now(),
      pending: false,
      language,
      texts,
      reason: undefined,
      controller,
      timer: undefined,
    }

    const llm = route === undefined ? undefined : llmService()
    if (route === undefined || llm === undefined) {
      debug(ctx, route === undefined ? 'no model route; heuristic suggestions only' : 'LLM service unavailable; heuristic suggestions only')
      publishState(sessionId, state)
      return
    }

    state.pending = true
    publishState(sessionId, state)

    let timer
    try {
      timer = setTimeout(() => {
        try {
          controller.abort(new Error(`${PLUGIN_NAME}: model timeout`))
        } catch {
          /* ignore */
        }
      }, LLM_TIMEOUT_MS)
      if (typeof timer?.unref === 'function') timer.unref()
    } catch {
      timer = undefined
    }
    state.timer = timer

    void (async () => {
      try {
        const llmSuggestions = await generateSuggestions(route, language, texts, controller.signal)
        if (!isCurrentState(sessionId, state)) return
        state.suggestions = llmSuggestions
        state.source = 'llm'
        state.pending = false
        state.generatedAt = Date.now()
        debug(ctx, `suggestions ready for ${sessionId} (llm)`)
      } catch (error) {
        if (!isCurrentState(sessionId, state)) return
        state.pending = false
        state.reason = messageOf(error)
        debug(ctx, `LLM suggestion generation failed (${messageOf(error)}); keeping heuristic list`)
      } finally {
        if (state.timer !== undefined) {
          try {
            clearTimeout(state.timer)
          } catch {
            /* ignore */
          }
          state.timer = undefined
        }
      }
    })()
  }

  // ------------------------------------------------------------------
  // Session event feed
  // ------------------------------------------------------------------

  /** Update the event-feed fallback tracker from one appended event. */
  function trackEvent(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const tracker = trackers.get(sessionId) ?? { userText: '', answerText: '' }

    switch (event.type) {
      case 'user/message': {
        const data = event.data
        if (data !== null && typeof data === 'object' && data.source?.kind === 'user') {
          const text = messageText(data)
          if (text.length > 0) tracker.userText = text
        }
        break
      }
      case 'assistant/message': {
        const data = event.data
        const message = data !== null && typeof data === 'object' ? data.message : undefined
        const text = messageText(message)
        if (text.length > 0) tracker.answerText = text
        break
      }
      default:
        return
    }

    trackers.delete(sessionId)
    trackers.set(sessionId, tracker)
    enforceBounds()
  }

  /** Handle one `session/event` append. Never throws. */
  function onSessionEvent(session, event) {
    try {
      if (session === null || typeof session !== 'object') return
      if (event === null || typeof event !== 'object') return
      if (!isRootSession(session)) return

      const type = event.type

      if (type === 'user/message' || type === 'turn/start') {
        trackEvent(session, event)
        const sessionId = session.id
        if (typeof sessionId === 'string') clearState(sessionId, `${type} began new work`)
        return
      }

      if (type === 'assistant/message') {
        trackEvent(session, event)
        return
      }

      if (type !== 'turn/end') return

      const reason = event.data?.reason
      if (isTerminalNonCompleted(reason)) {
        const sessionId = session.id
        if (typeof sessionId === 'string') clearState(sessionId, 'turn did not complete')
        return
      }
      if (!isCompletedTurn(reason)) return
      if (!options.enabled) return
      if (!routesActive) return

      // Defer the collection/generation work out of the append path: the
      // listener stays a cheap, never-throwing observer.
      queueMicrotask(() => {
        try {
          const sessionId = session.id
          if (typeof sessionId !== 'string') return
          const texts = collectTurnTexts(session, trackers.get(sessionId))
          if (texts.answerText.length < options.minAnswerChars) {
            clearState(sessionId, 'answer below minAnswerChars')
            return
          }
          startGeneration(session, texts)
        } catch (error) {
          warn(ctx, `failed to prepare suggestions: ${messageOf(error)}`)
        }
      })
    } catch (error) {
      warn(ctx, `session event handling failed: ${messageOf(error)}`)
    }
  }

  /** Handle `session/disposed`. Never throws. */
  function onSessionDisposed(session) {
    try {
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      forgetSession(sessionId)
    } catch (error) {
      warn(ctx, `session disposal handling failed: ${messageOf(error)}`)
    }
  }

  try {
    ctx.on('session/event', onSessionEvent)
    ctx.on('session/disposed', onSessionDisposed)
  } catch (error) {
    warn(ctx, `could not subscribe to session events: ${messageOf(error)}`)
  }

  // Abort anything in flight and drop state when this plugin unloads.
  try {
    ctx.effect(() => () => {
      for (const sessionId of [...states.keys()]) clearState(sessionId, 'plugin disposed')
      states.clear()
      trackers.clear()
    }, `${PLUGIN_NAME}: state cleanup`)
  } catch {
    /* ignore */
  }

  // ------------------------------------------------------------------
  // HTTP surface
  // ------------------------------------------------------------------

  /** Write one JSON response, honoring HEAD (headers only). */
  function sendJson(req, res, status, body, extraHeaders) {
    const payload = JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    }
    if (req?.method === 'HEAD') {
      headers['Content-Length'] = String(Buffer.byteLength(payload, 'utf8'))
      res.writeHead(status, headers)
      res.end()
      return
    }
    res.writeHead(status, headers)
    res.end(payload)
  }

  /** Answer one request with a JSON error and the standard shape. */
  function sendError(req, res, status, error, extraHeaders) {
    sendJson(req, res, status, { ok: false, error }, extraHeaders)
  }

  /** Parse the request URL without ever throwing. */
  function requestUrl(req) {
    try {
      return new URL(typeof req?.url === 'string' ? req.url : '/', 'http://127.0.0.1')
    } catch {
      return undefined
    }
  }

  /** Validate one session id path/query value. */
  function validSessionId(value) {
    return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
  }

  /** Whether the `sessions` store knows this id (undefined when it cannot be checked). */
  function sessionIsLive(sessionId) {
    try {
      const sessions = ctx.get('sessions')
      if (sessions === null || typeof sessions !== 'object' || typeof sessions.get !== 'function') return undefined
      const session = sessions.get(sessionId)
      return session !== undefined && session !== null
    } catch {
      return undefined
    }
  }

  /** The JSON body of one config read. */
  function configBody() {
    return {
      ok: true,
      enabled: options.enabled,
      maxSuggestions: options.maxSuggestions,
      showGhost: options.showGhost,
    }
  }

  /** The JSON body of one suggestion read for a session. */
  function suggestBody(sessionId) {
    const state = states.get(sessionId)
    if (state === undefined) {
      return {
        ok: true,
        sessionId,
        suggestions: [],
        source: 'heuristic',
        generatedAt: Date.now(),
        pending: false,
      }
    }
    return {
      ok: true,
      sessionId,
      suggestions: [...state.suggestions],
      source: state.source,
      generatedAt: state.generatedAt,
      pending: state.pending === true,
    }
  }

  /** Resolve the requested session id from query or JSON body. */
  async function sessionIdOf(req, url, allowBody) {
    let sessionId = url?.searchParams instanceof URLSearchParams ? url.searchParams.get('session') : null
    if (allowBody === true && (sessionId === null || sessionId.length === 0)) {
      const raw = await readJsonBody(req)
      if (raw !== undefined && raw !== null && typeof raw === 'object' && typeof raw.session === 'string') {
        sessionId = raw.session
      }
    }
    return typeof sessionId === 'string' ? sessionId : undefined
  }

  /** Read a bounded JSON body; resolves undefined on any failure. */
  function readJsonBody(req, limit = 8192) {
    return new Promise((resolve) => {
      let settled = false
      let size = 0
      const chunks = []
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        if (req === null || typeof req !== 'object' || typeof req.on !== 'function') {
          finish(undefined)
          return
        }
        req.on('data', (chunk) => {
          if (settled) return
          size += chunk.length
          if (size > limit) {
            finish(undefined)
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          if (settled) return
          const text = Buffer.concat(chunks).toString('utf8').trim()
          if (text.length === 0) {
            finish({})
            return
          }
          try {
            finish(JSON.parse(text))
          } catch {
            finish(undefined)
          }
        })
        req.on('error', () => finish(undefined))
      } catch {
        finish(undefined)
      }
    })
  }

  /** Same-origin guard for mutating requests (proxy for CSRF protection). */
  function sameOrigin(req) {
    const origin = req?.headers?.origin
    if (origin === undefined) return true
    if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return false
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    const host = req?.headers?.host
    if (typeof host !== 'string' || host.length === 0) return false
    return parsed.host === host
  }

  /** Handle `GET /next-prompt/config`. */
  async function handleConfig(req, res) {
    try {
      const method = req?.method
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(req, res, 405, 'method not allowed', { Allow: 'GET, HEAD' })
        return
      }
      sendJson(req, res, 200, configBody())
    } catch (error) {
      warn(ctx, `config route failed: ${messageOf(error)}`)
      try {
        sendError(req, res, 500, 'internal error')
      } catch {
        /* ignore */
      }
    }
  }

  /** Handle `GET /next-prompt/suggest?session=<id>`. */
  async function handleSuggest(req, res) {
    try {
      const method = req?.method
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(req, res, 405, 'method not allowed', { Allow: 'GET, HEAD' })
        return
      }
      const url = requestUrl(req)
      if (url === undefined) {
        sendError(req, res, 400, 'invalid request url')
        return
      }
      const sessionId = url.searchParams.get('session')
      if (sessionId === null || sessionId.length === 0) {
        sendError(req, res, 400, 'missing session')
        return
      }
      if (!validSessionId(sessionId)) {
        sendError(req, res, 400, 'invalid session id')
        return
      }
      if (sessionIsLive(sessionId) === false) {
        sendError(req, res, 404, 'unknown session')
        return
      }
      sendJson(req, res, 200, suggestBody(sessionId))
    } catch (error) {
      warn(ctx, `suggest route failed: ${messageOf(error)}`)
      try {
        sendError(req, res, 500, 'internal error')
      } catch {
        /* ignore */
      }
    }
  }

  /** Handle `POST /next-prompt/regenerate` (`{session}` body or `?session=`). */
  async function handleRegenerate(req, res) {
    try {
      const method = req?.method
      if (method !== 'POST') {
        sendError(req, res, 405, 'method not allowed', { Allow: 'POST' })
        return
      }
      if (!sameOrigin(req)) {
        sendError(req, res, 403, 'cross-origin request refused')
        return
      }
      const url = requestUrl(req)
      const sessionId = await sessionIdOf(req, url, true)
      if (!validSessionId(sessionId)) {
        sendError(req, res, 400, sessionId === undefined ? 'missing session' : 'invalid session id')
        return
      }
      const live = sessionIsLive(sessionId)
      if (live === false) {
        sendError(req, res, 404, 'unknown session')
        return
      }
      if (!options.enabled) {
        sendJson(req, res, 200, suggestBody(sessionId))
        return
      }

      const existing = states.get(sessionId)
      let texts = existing?.texts
      if (texts === undefined || texts.answerText.length === 0) {
        try {
          const sessions = ctx.get('sessions')
          const session = sessions?.get?.(sessionId)
          texts = collectTurnTexts(session, trackers.get(sessionId))
        } catch {
          texts = undefined
        }
      }
      if (texts === undefined || texts.answerText.length === 0) {
        sendError(req, res, 404, 'no completed turn to regenerate')
        return
      }

      const session = (() => {
        try {
          return ctx.get('sessions')?.get?.(sessionId)
        } catch {
          return undefined
        }
      })()
      startGeneration(session ?? { id: sessionId }, texts)
      sendJson(req, res, 200, suggestBody(sessionId))
    } catch (error) {
      warn(ctx, `regenerate route failed: ${messageOf(error)}`)
      try {
        sendError(req, res, 500, 'internal error')
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Register the three fixed routes on one `webServer` instance.
   * @param {any} webServer - the active webServer service.
   * @returns {() => void} disposer removing every route it registered.
   */
  function registerRoutes(webServer) {
    const disposers = []
    const add = (path, handler) => {
      try {
        disposers.push(webServer.register({ kind: 'exact', path, handler }))
      } catch (error) {
        // A collision is a misconfiguration, not a crash: keep the other routes.
        warn(ctx, `could not register route ${path}: ${messageOf(error)}`)
      }
    }
    add(`${ROUTE_BASE}/suggest`, handleSuggest)
    add(`${ROUTE_BASE}/config`, handleConfig)
    add(`${ROUTE_BASE}/regenerate`, handleRegenerate)
    routesActive = disposers.length > 0
    if (routesActive) debug(ctx, `HTTP routes registered under ${ROUTE_BASE}`)
    return () => {
      routesActive = false
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Register routes from one context whose fiber should own their lifetime. */
  function installRoutes(ownerCtx) {
    try {
      const webServer = ownerCtx.get('webServer')
      if (webServer === null || typeof webServer !== 'object' || typeof webServer.register !== 'function') {
        warn(ctx, 'webServer service exposes no register(); HTTP routes are unavailable')
        return
      }
      ownerCtx.effect(() => registerRoutes(webServer), `${PLUGIN_NAME}: http routes`)
    } catch (error) {
      warn(ctx, `could not install HTTP routes: ${messageOf(error)}`)
    }
  }

  // Prefer immediate registration when the service is already active: profile
  // bundle order mounts the web app (and its webServer) before third-party
  // bundles, so this is the normal path. Otherwise wait for the service on a
  // child fiber whose disposal removes the routes.
  let routesInstalled = false
  try {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
      try {
        ctx.effect(() => registerRoutes(webServer), `${PLUGIN_NAME}: http routes`)
        routesInstalled = true
      } catch (error) {
        warn(ctx, `could not install HTTP routes: ${messageOf(error)}`)
      }
    }
  } catch {
    /* a context without service lookup falls through to ctx.inject below */
  }
  if (!routesInstalled) {
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (webCtx) => installRoutes(webCtx))
      }
    } catch (error) {
      warn(ctx, `could not wait for the webServer service: ${messageOf(error)}`)
    }
  }
}

/** @typedef {{ sessionId: string, suggestions: string[], source: 'llm'|'heuristic', generatedAt: number, pending: boolean, language: 'ru'|'en', texts: {userText: string, answerText: string}, reason: string|undefined, controller: AbortController, timer: any }} SessionState */
