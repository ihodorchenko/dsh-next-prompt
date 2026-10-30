#!/usr/bin/env node
/**
 * Lead acceptance test for the dsh-next-prompt Host half.
 *
 * Black-box only: imports the shipped `package/index.js`, mounts it on a mock
 * Cordis context, drives the public `session/event` / `session/disposed` surfaces
 * and calls the registered HTTP route handlers directly. Asserts the JSON
 * contract the browser half depends on (see next-prompt/BRIEF.md).
 *
 * Run:  node test/check-host.mjs
 * Exit: 0 = all checks passed, 1 = failure (printed).
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = join(here, '..', 'index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

/** A minimal Cordis-like host context with the services the plugin probes. */
function createHarness({ config = {}, llm = 'good', enabled = true } = {}) {
  const handlers = new Map()
  const routes = new Map()
  const disposers = []
  const logs = { warn: [], debug: [] }
  const sessions = new Map()

  const services = {
    webServer: {
      register(route) {
        assert.equal(typeof route?.path, 'string')
        assert.ok(route.path.startsWith('/next-prompt/'), `unexpected route path ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    sessions: {
      get(id) {
        return sessions.get(id)
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek-account', model: 'deepseek-flash' }
      },
    },
    llm: {
      async *stream(request) {
        assert.equal(typeof request?.provider, 'string')
        assert.equal(typeof request?.model, 'string')
        assert.ok(Array.isArray(request?.messages) && request.messages.length > 0)
        if (llm === 'throw') throw new Error('simulated provider failure')
        if (llm === 'garbage') {
          yield { type: 'text-delta', index: 0, text: '   \n\t ' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llm === 'fenced') {
          yield { type: 'text-delta', index: 0, text: '```json\n["Продолжай","Проверь сборку"]\n```' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: '["Продолжай","Добавь тесты","Что дальше?"]' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }

  const childContext = {
    get(name) {
      return services[name]
    },
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }

  const ctx = {
    logger: {
      warn(message) {
        logs.warn.push(String(message))
      },
      debug(message) {
        logs.debug.push(String(message))
      },
      info() {},
    },
    on(type, handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
      return () => {}
    },
    effect(fn) {
      return childContext.effect(fn)
    },
    get(name) {
      return services[name]
    },
    inject(deps, callback) {
      assert.ok(Array.isArray(deps))
      callback(childContext)
      return () => {}
    },
  }

  function emit(type, ...args) {
    for (const handler of handlers.get(type) ?? []) handler(...args)
  }

  return {
    ctx,
    services,
    sessions,
    routes,
    logs,
    emit,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

/** Root session mock whose derived messages can be controlled by the test. */
function makeSession(id, { origin = 'user', messages = [] } = {}) {
  const session = {
    id,
    header: { origin, cwd: '/tmp/workspace' },
    messages,
    deriveMessages() {
      return session.messages
    },
    requestHeader() {
      return { config: { provider: 'deepseek-account', model: 'deepseek-flash' } }
    },
  }
  return session
}

function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}
function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

/** Drive one completed turn through the public event surface. */
function completeTurn(harness, session, { userText, answerText }) {
  session.messages = [userMessage(userText), assistantMessage(answerText)]
  harness.sessions.set(session.id, session)
  harness.emit('session/event', session, { type: 'user/message', data: userMessage(userText) })
  harness.emit('session/event', session, { type: 'assistant/message', data: { message: assistantMessage(answerText), turn: 1, step: 1 } })
  harness.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

/** Call one registered route and return {status, headers, body}. */
async function callRoute(harness, path, { method = 'GET', url = path, headers = {}, body } = {}) {
  const route = harness.routes.get(path)
  assert.ok(route !== undefined, `route ${path} is not registered`)
  let status = 0
  let responseHeaders = {}
  let payload = ''
  const res = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus
      responseHeaders = nextHeaders ?? {}
    },
    end(chunk) {
      payload += chunk === undefined ? '' : String(chunk)
    },
    setHeader() {},
  }
  const req = { method, url, headers: { host: '127.0.0.1:59045', ...headers }, on() {}, async *[Symbol.asyncIterator]() {} }
  await route.handler(req, res)
  let json
  try {
    json = payload.length > 0 ? JSON.parse(payload) : undefined
  } catch {
    json = undefined
  }
  return { status, headers: responseHeaders, body: json, raw: payload }
}

const LONG_ANSWER = 'Готово: я обновил плагин, добавил маршрут и проверил, что приложение собирается без ошибок. ' +
  'Если нужно, могу добавить тесты на новый код и описать изменения в README.'

// ---------------------------------------------------------------------------
// 1. Mount + route registration
// ---------------------------------------------------------------------------
{
  const harness = createHarness()
  const module = await import(pathToFileURL(pluginPath).href)
  assert.equal(typeof module.apply, 'function', 'package/index.js must export apply()')
  module.apply(harness.ctx, { enabled: true, maxSuggestions: 3 })

  const paths = [...harness.routes.keys()].sort()
  assert.deepEqual(paths, ['/next-prompt/config', '/next-prompt/regenerate', '/next-prompt/suggest'])

  const configRoute = await callRoute(harness, '/next-prompt/config')
  assert.equal(configRoute.status, 200)
  assert.equal(configRoute.body.ok, true)
  assert.equal(configRoute.body.enabled, true)
  assert.equal(configRoute.body.maxSuggestions, 3)
  assert.equal(configRoute.body.showGhost, true)
  assert.equal(configRoute.headers['Cache-Control'], 'no-store')
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 2. Completed turn → LLM suggestions, then reset on the next user message
// ---------------------------------------------------------------------------
{
  const harness = createHarness()
  const module = await import(pathToFileURL(pluginPath).href)
  module.apply(harness.ctx, { enabled: true, maxSuggestions: 3, minAnswerChars: 10 })
  const session = makeSession('session-abc')

  completeTurn(harness, session, { userText: 'Почини сборку', answerText: LONG_ANSWER })
  await sleep(80)

  const first = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-abc' })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.sessionId, 'session-abc')
  assert.deepEqual(first.body.suggestions, ['Продолжай', 'Добавь тесты', 'Что дальше?'])
  assert.equal(first.body.source, 'llm')
  assert.equal(first.body.pending, false)
  assert.ok(Number.isFinite(first.body.generatedAt))

  // A new user message supersedes the previous suggestion.
  harness.emit('session/event', session, { type: 'user/message', data: userMessage('Ещё вопрос') })
  const after = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-abc' })
  assert.equal(after.status, 200)
  assert.deepEqual(after.body.suggestions, [])
  assert.equal(after.body.pending, false)
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 3. Fenced JSON and provider failure fallbacks
// ---------------------------------------------------------------------------
{
  const harness = createHarness({ llm: 'fenced' })
  const module = await import(pathToFileURL(pluginPath).href)
  module.apply(harness.ctx, { minAnswerChars: 10 })
  const session = makeSession('session-json')
  completeTurn(harness, session, { userText: 'Продолжи', answerText: LONG_ANSWER })
  await sleep(80)
  const response = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-json' })
  assert.deepEqual(response.body.suggestions, ['Продолжай', 'Проверь сборку'])
  assert.equal(response.body.source, 'llm')
  harness.dispose()
}

{
  const harness = createHarness({ llm: 'throw' })
  const module = await import(pathToFileURL(pluginPath).href)
  module.apply(harness.ctx, { minAnswerChars: 10, language: 'ru' })
  const session = makeSession('session-fail')
  completeTurn(harness, session, { userText: 'Продолжи', answerText: LONG_ANSWER })
  await sleep(120)
  const response = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-fail' })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.pending, false)
  assert.equal(response.body.source, 'heuristic')
  assert.ok(response.body.suggestions.length > 0, 'heuristic fallback must not be empty')
  assert.ok(harness.logs.warn.length >= 0)
  harness.dispose()
}

{
  const harness = createHarness({ llm: 'garbage' })
  const module = await import(pathToFileURL(pluginPath).href)
  module.apply(harness.ctx, { minAnswerChars: 10 })
  const session = makeSession('session-garbage')
  completeTurn(harness, session, { userText: 'Продолжи', answerText: LONG_ANSWER })
  await sleep(120)
  const response = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-garbage' })
  assert.equal(response.body.source, 'heuristic')
  assert.ok(response.body.suggestions.length > 0)
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 4. Subagent sessions, short answers and disabled config are ignored
// ---------------------------------------------------------------------------
{
  const harness = createHarness()
  const module = await import(pathToFileURL(pluginPath).href)
  module.apply(harness.ctx, { minAnswerChars: 10 })

  const child = makeSession('session-child', { origin: 'subagent' })
  completeTurn(harness, child, { userText: 'Продолжи', answerText: LONG_ANSWER })
  await sleep(60)
  const childResponse = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-child' })
  assert.deepEqual(childResponse.body.suggestions, [], 'subagent sessions must not produce suggestions')

  const short = makeSession('session-short')
  completeTurn(harness, short, { userText: 'Привет', answerText: 'Ок.' })
  await sleep(60)
  const shortResponse = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-short' })
  assert.deepEqual(shortResponse.body.suggestions, [], 'short answers must not produce suggestions')

  const disabledHarness = createHarness()
  module.apply(disabledHarness.ctx, { enabled: false, minAnswerChars: 10 })
  const disabled = makeSession('session-off')
  completeTurn(disabledHarness, disabled, { userText: 'Продолжи', answerText: LONG_ANSWER })
  await sleep(60)
  const disabledResponse = await callRoute(disabledHarness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-off' })
  assert.deepEqual(disabledResponse.body.suggestions, [], 'disabled plugin must not produce suggestions')
  const disabledConfig = await callRoute(disabledHarness, '/next-prompt/config')
  assert.equal(disabledConfig.body.enabled, false)
  disabledHarness.dispose()
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 5. HTTP error contract
// ---------------------------------------------------------------------------
{
  const harness = createHarness()
  const module = await import(pathToFileURL(pluginPath).href)
  module.apply(harness.ctx, {})

  const missing = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.ok, false)

  const invalid = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=../etc/passwd' })
  assert.equal(invalid.status, 400)

  const unknown = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-unknown' })
  assert.ok(unknown.status === 404 || unknown.status === 200, `unexpected status ${unknown.status}`)
  if (unknown.status === 200) assert.deepEqual(unknown.body.suggestions, [])

  const wrongMethod = await callRoute(harness, '/next-prompt/suggest', { method: 'POST', url: '/next-prompt/suggest?session=session-abc' })
  assert.equal(wrongMethod.status, 405)

  const regenerateGet = await callRoute(harness, '/next-prompt/regenerate', { url: '/next-prompt/regenerate?session=session-abc' })
  assert.equal(regenerateGet.status, 405)

  const configPost = await callRoute(harness, '/next-prompt/config', { method: 'POST', url: '/next-prompt/config' })
  assert.equal(configPost.status, 405)
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 6. Disposal drops state without throwing
// ---------------------------------------------------------------------------
{
  const harness = createHarness()
  const module = await import(pathToFileURL(pluginPath).href)
  module.apply(harness.ctx, { minAnswerChars: 10 })
  const session = makeSession('session-dispose')
  completeTurn(harness, session, { userText: 'Продолжи', answerText: LONG_ANSWER })
  await sleep(60)
  harness.emit('session/disposed', session)
  const response = await callRoute(harness, '/next-prompt/suggest', { url: '/next-prompt/suggest?session=session-dispose' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.suggestions, [])
  harness.dispose()
  await sleep(20)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let failures = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}
if (failures > 0) {
  console.error(`\ncheck-host: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-host: all checks passed')
