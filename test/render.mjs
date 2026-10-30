/**
 * Fake-loader harness runner.
 *
 *   node run.mjs                 # structural test bundle only
 *   node run.mjs <bundle.js>     # + shipped-bundle scenarios against fake DOM
 *
 * No dependencies, no browser: everything below runs on Node 24.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHarness,
  makeProps,
  setupComposer,
  dispatchKey,
  sleep,
  settle,
  FakeResizeObserver,
} from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_BUNDLE = path.join(HERE, "test-bundle.js");
const DEFAULT_SHIPPED = path.resolve(HERE, "../lib/client.js");

let passed = 0;
const failures = [];

function describeDetail(detail) {
  if (detail === undefined) return "";
  if (detail === null) return "null";
  if (typeof detail === "object" && typeof detail.nodeType === "number") {
    return "<" + String(detail.tagName || "text").toLowerCase() + ">";
  }
  try {
    return JSON.stringify(detail);
  } catch (ignored) {
    return String(detail);
  }
}

function ok(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log("  ok   " + label);
  } else {
    failures.push({ label, detail });
    console.log("  FAIL " + label + (detail === undefined ? "" : " -> " + describeDetail(detail)));
  }
}

function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label, { actual: normaliseForLog(actual), expected: normaliseForLog(expected) });
}

function normaliseForLog(value) {
  if (value !== null && typeof value === "object" && typeof value.nodeType === "number") return "<" + String(value.tagName || "text").toLowerCase() + ">";
  return value;
}

function section(title) {
  console.log("\n# " + title);
}

function createFakeCtx(options = {}) {
  const effects = [];
  const registrations = [];
  const dictionaries = [];
  const slotKeys = [];
  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    on() {
      return () => {};
    },
    get() {
      return undefined;
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts });
        return () => {};
      },
      bind() {
        return (key) => key;
      },
    },
    slots: {
      inject(key, callback) {
        slotKeys.push(key);
        if (options.declaredSlots !== undefined && !options.declaredSlots.includes(key)) {
          return () => {};
        }
        const dispose = callback();
        return typeof dispose === "function" ? dispose : () => {};
      },
      register(registration, component) {
        registrations.push({ registration, component });
        return () => {};
      },
    },
  };
  return { ctx, effects, registrations, dictionaries, slotKeys };
}

function disposeAll(effects) {
  for (const effect of effects.slice().reverse()) {
    if (typeof effect.dispose === "function") effect.dispose();
  }
}

// ---------------------------------------------------------------------------
// 1. structural test bundle
// ---------------------------------------------------------------------------

function runStructuralTests() {
  section("test bundle: loader wrapper / registration / style / locale");
  const harness = createHarness();
  const loaded = harness.loadBundle(TEST_BUNDLE);
  eq(loaded.id, "dsh-next-prompt-harness-test", "load() id is preserved");
  ok(typeof loaded.exports.apply === "function", "factory returns exports.apply function");
  ok(
    Array.isArray(loaded.exports.inject) &&
      loaded.exports.inject.length === 2 &&
      loaded.exports.inject[0] === "slots" &&
      loaded.exports.inject[1] === "locale",
    "factory returns exports.inject service list",
    loaded.exports.inject,
  );
  ok(
    loaded.requireTargets.every((specifier) => harness.BASELINE_MODULES.has(specifier)),
    "require() targets stay in the baseline table",
    loaded.requireTargets,
  );

  const fake = createFakeCtx({ declaredSlots: ["conversation.input.overlay"] });
  loaded.exports.apply(fake.ctx);
  const styleTag = harness.dom.document.head.querySelector("style[data-plugin]");
  ok(styleTag !== null, "apply injects one style tag into document.head");
  eq(styleTag && styleTag.getAttribute("data-plugin"), "dsh-next-prompt-harness-test", "style tag carries data-plugin");
  eq(styleTag && styleTag.getAttribute("data-plugin-css"), "dsh-next-prompt-harness-test/test.css", "style tag carries data-plugin-css");
  ok(styleTag !== null && styleTag.textContent.indexOf(".tnp-harness-test") >= 0, "style tag contains the component CSS");
  eq(fake.slotKeys[0], "conversation.input.overlay", "slots.inject targets the overlay slot");
  ok(fake.dictionaries.length === 1, "locale.register called once");
  const dicts = fake.dictionaries[0];
  eq(dicts.namespace, "next-prompt-harness-test", "locale namespace matches");
  ok(dicts.dicts.en && dicts.dicts.zh && dicts.dicts.ru, "locale registers en + zh + ru dictionaries");

  const entry = fake.registrations[0];
  ok(entry !== undefined, "one slot registration captured");
  const registration = entry.registration;
  eq(registration.name, "conversation.input.overlay", "registration.name is the overlay slot");
  eq(registration.id, "dsh-next-prompt-harness-test", "registration.id");
  eq(registration.order, 50, "registration.order");
  eq(registration.locale, "next-prompt-harness-test", "registration.locale namespace");
  ok(typeof registration.inject === "function", "registration.inject(sessionId) supplied");
  ok(typeof entry.component === "function", "registration component is a function component");

  // Component render with the harness props, including the locale `t` seat.
  const props = makeProps(harness.dom, {
    t: (key) => "T(" + key + ")",
  });
  const root = harness.mountComponent(entry.component, props);
  const ghost = harness.dom.document.querySelector("[data-test-ghost]");
  ok(ghost !== null, "component renders its host element");
  ok(
    ghost !== null && ghost.textContent.includes("T(ghost)") && ghost.textContent.includes("session-1"),
    "component receives t() and sessionId props",
    ghost && ghost.textContent,
  );
  root.unmount();

  // Server-render style passivity: apply must not throw when the slot is absent.
  const harness2 = createHarness();
  const loaded2 = harness2.loadBundle(TEST_BUNDLE);
  const fake2 = createFakeCtx({ declaredSlots: [] });
  let threw = null;
  try {
    loaded2.exports.apply(fake2.ctx);
  } catch (error) {
    threw = error;
  }
  ok(threw === null, "apply does not throw when the overlay slot is never declared", threw && String(threw));
  ok(fake2.registrations.length === 0, "nothing registered while the slot is absent");

  // dispose contract: style tag removed with the effect
  disposeAll(fake.effects);
  eq(harness.dom.document.head.querySelector("style[data-plugin]"), null, "effect disposal removes the style tag");
}

// ---------------------------------------------------------------------------
// 2. shipped bundle scenarios
// ---------------------------------------------------------------------------

function loadShipped(bundlePath) {
  const harness = createHarness();
  const loaded = harness.loadBundle(bundlePath);
  if (!loaded.exports || typeof loaded.exports.apply !== "function") {
    throw new Error("shipped bundle has no exports.apply");
  }
  const fake = createFakeCtx({ declaredSlots: ["conversation.input.overlay"] });
  loaded.exports.apply(fake.ctx);
  const entry = fake.registrations.find((candidate) => candidate.registration.id === "next-prompt");
  if (entry === undefined) {
    throw new Error(
      "shipped bundle registered no 'next-prompt' overlay entry; slotKeys=" +
        JSON.stringify(fake.slotKeys) +
        " registered=" +
        JSON.stringify(fake.registrations.map((item) => item.registration && item.registration.id)),
    );
  }
  return { harness, loaded, fake, entry };
}

function responseOf(harness, responses) {
  let index = 0;
  harness.setFetchHandler((url) => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === "function") return next(url);
    return next;
  });
}

function routeOf(url) {
  return String(url).split("?")[0];
}

async function waitForGhostMatching(harness, root, props, match, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    root.render(props);
    const ghost = harness.dom.document.querySelector("[data-next-prompt-ghost]");
    if (ghost !== null && match(String(ghost.textContent))) return ghost;
    await sleep(25);
  }
  return null;
}

async function waitForGhost(harness, root, props, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    root.render(props);
    const ghost = harness.dom.document.querySelector("[data-next-prompt-ghost]");
    if (ghost !== null) return ghost;
    await sleep(30);
  }
  return null;
}

async function runShippedTests(bundlePath) {
  section("shipped bundle: apply() surface");
  const first = loadShipped(bundlePath);
  eq(first.loaded.id, "dsh-next-prompt", "bundle id is dsh-next-prompt");
  ok(
    Array.isArray(first.loaded.exports.inject) && first.loaded.exports.inject.indexOf("slots") >= 0,
    "exports.inject includes the slots service",
    first.loaded.exports.inject,
  );
  ok(
    first.loaded.requireTargets.every((specifier) => first.harness.BASELINE_MODULES.has(specifier)),
    "require() targets stay in the baseline table",
    first.loaded.requireTargets,
  );
  const styleTag = first.harness.dom.document.head.querySelector("style[data-plugin]");
  ok(styleTag !== null, "apply injects the ghost stylesheet");
  eq(styleTag && styleTag.getAttribute("data-plugin"), "dsh-next-prompt", "stylesheet carries data-plugin");
  eq(first.fake.dictionaries.length, 1, "locale.register called once");
  const dicts = first.fake.dictionaries[0];
  ok(dicts && dicts.dicts && dicts.dicts.en && dicts.dicts.ru, "en + ru dictionaries registered", dicts && Object.keys(dicts.dicts || {}));
  const registration = first.entry.registration;
  eq(registration.name, "conversation.input.overlay", "registration.name");
  eq(registration.id, "next-prompt", "registration.id");
  ok(typeof registration.order === "number", "registration.order is numeric");
  eq(registration.locale, "next-prompt", "registration.locale is the plugin namespace");
  disposeAll(first.fake.effects);

  section("shipped bundle: no DOM anchors -> silent, no ghost, no throw");
  {
    const { harness, entry } = loadShipped(bundlePath);
    responseOf(harness, [{ status: 404, body: { ok: false } }]);
    const props = makeProps(harness.dom);
    const root = harness.mountComponent(entry.component, props);
    props.__state.session.running = true;
    root.render(props);
    props.__state.session.running = false;
    root.render(props);
    await settle(harness, 900);
    root.flush();
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "no ghost without a composer card");
    root.unmount();
  }

  section("shipped bundle: turn end -> pending poll -> ghost aligned to placeholder");
  const scenario = loadShipped(bundlePath);
  {
    const { harness, entry } = scenario;
    const anchors = setupComposer(harness.dom);
    setupFetchScenario(harness);
    const props = makeProps(harness.dom);
    const root = harness.mountComponent(entry.component, props, anchors.overlay);

    // turn starts
    props.__state.session.running = true;
    root.render(props);
    await sleep(120);
    root.flush();
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "no ghost while the turn runs");

    // turn ends
    props.__state.session.running = false;
    root.render(props);
    const ghost = await waitForGhost(harness, root, props);
    ok(ghost !== null, "ghost appears after the turn ends");

    const suggestion = "Add error handling to the parser";
    if (ghost !== null) {
      eq(ghost.style.left, "14px", "ghost left = placeholder.left - anchor.left");
      eq(ghost.style.top, "12px", "ghost top = placeholder.top - anchor.top");
      eq(ghost.style.width, "700px", "ghost width = placeholder width");
      ok(String(ghost.textContent).indexOf(suggestion) >= 0, "ghost shows the top suggestion", ghost.textContent);
      ok(String(ghost.textContent).toLowerCase().indexOf("tab") >= 0, "ghost shows the Tab hint", ghost.textContent);
      eq(anchors.placeholder.style.visibility, "hidden", "real placeholder hidden while the ghost shows");
    }
    const suggestRequest = harness.requests.filter((request) => routeOf(request.url) === "/next-prompt/suggest");
    ok(suggestRequest.length >= 1, "GET /next-prompt/suggest issued", harness.requests.map((r) => r.url));
    ok(
      suggestRequest.length > 0 && String(suggestRequest[0].url).indexOf("session=session-1") >= 0,
      "suggest request carries the session id",
      suggestRequest[0] && suggestRequest[0].url,
    );
    const configRequest = harness.requests.filter((request) => routeOf(request.url) === "/next-prompt/config");
    ok(configRequest.length >= 1, "GET /next-prompt/config issued", harness.requests.map((r) => r.url));

    section("shipped bundle: heuristic -> LLM refinement polling (pending:true)");
  {
    const { harness, entry } = loadShipped(bundlePath);
    const anchors = setupComposer(harness.dom);
    let suggestCalls = 0;
    harness.setFetchHandler((url) => {
      if (routeOf(url) === "/next-prompt/config") {
        return { status: 200, body: { ok: true, enabled: true, showGhost: true, maxSuggestions: 3 } };
      }
      if (routeOf(url) === "/next-prompt/suggest") {
        suggestCalls += 1;
        if (suggestCalls === 1) {
          return {
            status: 200,
            body: { ok: true, sessionId: "session-1", suggestions: ["Продолжай"], source: "heuristic", generatedAt: Date.now(), pending: true },
          };
        }
        return {
          status: 200,
          body: { ok: true, sessionId: "session-1", suggestions: ["Добавь обработку ошибок в парсер"], source: "llm", generatedAt: Date.now(), pending: false },
        };
      }
      return { status: 404, body: { ok: false } };
    });
    const props = makeProps(harness.dom);
    const root = harness.mountComponent(entry.component, props, anchors.overlay);
    props.__state.session.running = true;
    root.render(props);
    await settle(harness, 900);
    root.flush();
    eq(
      harness.requests.filter((request) => routeOf(request.url) === "/next-prompt/suggest").length,
      0,
      "no suggest request while the turn runs (debounce/turn gating)",
    );
    props.__state.session.running = false;
    root.render(props);
    const heuristicGhost = await waitForGhostMatching(harness, root, props, (text) => text.indexOf("Продолжай") >= 0);
    ok(heuristicGhost !== null, "heuristic suggestion shows while the host reports pending");
    const refinedGhost = await waitForGhostMatching(harness, root, props, (text) => text.indexOf("Добавь обработку ошибок") >= 0);
    ok(refinedGhost !== null, "LLM refinement replaces the heuristic suggestion");
    ok(
      harness.requests.filter((request) => routeOf(request.url) === "/next-prompt/suggest").length >= 2,
      "polling issued a second suggest request after pending:true",
      harness.requests.map((request) => request.url),
    );
    const ghostAfterRefine = harness.dom.document.querySelector("[data-next-prompt-ghost]");
    eq(anchors.placeholder.style.visibility, "hidden", "placeholder stays hidden across refinement");
    ok(ghostAfterRefine !== null && String(ghostAfterRefine.textContent).indexOf("Продолжай") < 0, "heuristic text is fully replaced");
    harness.dom.document.activeElement = anchors.input;
    dispatchKey(harness.dom, { key: "Tab", target: anchors.input });
    eq(props.__state.inputActions.setDraftCalls.length, 1, "Tab accepts the refined suggestion");
    eq(props.__state.inputActions.setDraftCalls[0], "Добавь обработку ошибок в парсер", "setDraft receives the refined text");
    root.flush();
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "ghost removed after accepting the refined suggestion");
    eq(anchors.placeholder.style.visibility, "", "placeholder restored after refine-accept");
  }

  section("shipped bundle: accept with Tab");
    harness.dom.document.activeElement = anchors.input;
    const tabEvent = dispatchKey(harness.dom, { key: "Tab", target: anchors.input });
    ok(tabEvent.defaultPrevented, "Tab is consumed while the ghost is visible");
    eq(props.__state.inputActions.setDraftCalls.length, 1, "setDraft called once on Tab");
    eq(props.__state.inputActions.setDraftCalls[0], suggestion, "setDraft receives the suggestion text");
    root.flush();
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "ghost removed after accept");
    eq(anchors.placeholder.style.visibility, "", "placeholder restored after accept");
  }

  section("shipped bundle: Tab guards (defaultPrevented / focus / menu / modifiers)");
  {
    const { harness, entry } = loadShipped(bundlePath);
    const anchors = setupComposer(harness.dom);
    setupFetchScenario(harness);
    const props = makeProps(harness.dom);
    const root = harness.mountComponent(entry.component, props, anchors.overlay);
    props.__state.session.running = true;
    root.render(props);
    await sleep(60);
    props.__state.session.running = false;
    root.render(props);
    ok((await waitForGhost(harness, root, props)) !== null, "ghost ready for guard checks");

    harness.dom.document.activeElement = anchors.input;
    dispatchKey(harness.dom, { key: "Tab", defaultPrevented: true, target: anchors.input });
    eq(props.__state.inputActions.setDraftCalls.length, 0, "prevented Tab is ignored");

    harness.dom.document.activeElement = harness.dom.body;
    dispatchKey(harness.dom, { key: "Tab", target: anchors.input });
    eq(props.__state.inputActions.setDraftCalls.length, 0, "Tab ignored while the composer is not focused");

    harness.dom.document.activeElement = anchors.input;
    dispatchKey(harness.dom, { key: "Tab", shiftKey: true, target: anchors.input });
    dispatchKey(harness.dom, { key: "Tab", altKey: true, target: anchors.input });
    dispatchKey(harness.dom, { key: "Tab", ctrlKey: true, target: anchors.input });
    eq(props.__state.inputActions.setDraftCalls.length, 0, "modified Tab is ignored");

    dispatchKey(harness.dom, { key: "Tab", isComposing: true, target: anchors.input });
    eq(props.__state.inputActions.setDraftCalls.length, 0, "Tab during IME composition is ignored");

    const menu = harness.dom.document.createElement("div");
    menu.setAttribute("role", "listbox");
    anchors.overlay.appendChild(menu);
    dispatchKey(harness.dom, { key: "Tab", target: anchors.input });
    eq(props.__state.inputActions.setDraftCalls.length, 0, "Tab ignored while an overlay menu is open");
    anchors.overlay.removeChild(menu);

    dispatchKey(harness.dom, { key: "Tab", target: anchors.input });
    eq(props.__state.inputActions.setDraftCalls.length, 1, "plain Tab accepts once the guards clear");
  }

  section("shipped bundle: Escape dismisses, typing dismisses");
  {
    const { harness, entry } = loadShipped(bundlePath);
    const anchors = setupComposer(harness.dom);
    setupFetchScenario(harness);
    const props = makeProps(harness.dom);
    const root = harness.mountComponent(entry.component, props, anchors.overlay);
    props.__state.session.running = true;
    root.render(props);
    await sleep(60);
    props.__state.session.running = false;
    root.render(props);
    ok((await waitForGhost(harness, root, props)) !== null, "ghost ready for dismiss checks");
    dispatchKey(harness.dom, { key: "Escape" });
    root.flush();
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "Escape hides the ghost");
    eq(anchors.placeholder.style.visibility, "", "placeholder restored after Escape");

    // A new turn-end cycle re-arms it, then typing dismisses it.
    props.__state.session.running = true;
    root.render(props);
    await sleep(60);
    props.__state.session.running = false;
    root.render(props);
    ok((await waitForGhost(harness, root, props)) !== null, "ghost re-armed by the next turn");
    props.__state.input.draft = "typed";
    root.render(props);
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "typing hides the ghost");
    props.__state.input.draft = "";
    root.render(props);
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "clearing the draft does not resurrect it");
  }

  section("shipped bundle: config disabled / fetch failure degrade quietly");
  {
    const { harness, entry } = loadShipped(bundlePath);
    setupComposer(harness.dom);
    harness.setFetchHandler((url) => {
      if (routeOf(url) === "/next-prompt/config") return { status: 200, body: { ok: true, enabled: false, showGhost: false } };
      return { status: 200, body: { ok: true, sessionId: "session-1", suggestions: ["should not appear"] } };
    });
    const props = makeProps(harness.dom);
    const root = harness.mountComponent(entry.component, props);
    props.__state.session.running = true;
    root.render(props);
    await sleep(60);
    props.__state.session.running = false;
    root.render(props);
    await settle(harness, 1400);
    root.flush();
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "disabled config suppresses the ghost");
    eq(
      harness.requests.filter((request) => routeOf(request.url) === "/next-prompt/suggest").length,
      0,
      "disabled config suppresses the suggest request",
    );
  }
  {
    const { harness, entry } = loadShipped(bundlePath);
    setupComposer(harness.dom);
    harness.setFetchHandler((url) => {
      if (routeOf(url) === "/next-prompt/config") return { status: 404, body: { ok: false } };
      return { status: 500, body: { ok: false, error: "boom" } };
    });
    const props = makeProps(harness.dom);
    const root = harness.mountComponent(entry.component, props);
    props.__state.session.running = true;
    root.render(props);
    await sleep(60);
    props.__state.session.running = false;
    root.render(props);
    await settle(harness, 1400);
    root.flush();
    eq(harness.dom.document.querySelector("[data-next-prompt-ghost]"), null, "HTTP failure shows nothing");
    ok(true, "HTTP failure did not throw");
  }

  section("shipped bundle: resize relayout");
  {
    const { harness, entry } = loadShipped(bundlePath);
    const anchors = setupComposer(harness.dom);
    setupFetchScenario(harness);
    const props = makeProps(harness.dom);
    const root = harness.mountComponent(entry.component, props, anchors.overlay);
    props.__state.session.running = true;
    root.render(props);
    await sleep(60);
    props.__state.session.running = false;
    root.render(props);
    const ghost = await waitForGhost(harness, root, props);
    ok(ghost !== null, "ghost before resize");
    if (ghost !== null) {
      // The card grew (e.g. accessory row) and the placeholder moved down by 20px.
      anchors.placeholder.setRect({ left: 124, top: 62, width: 660, height: 24 });
      anchors.overlay.setRect({ left: 110, top: 30, width: 720, height: 0 });
      FakeResizeObserver.flushAll();
      root.flush();
      await sleep(40);
      root.flush();
      const repositioned = harness.dom.document.querySelector("[data-next-prompt-ghost]");
      ok(repositioned !== null, "ghost still rendered after relayout");
      if (repositioned !== null) {
        eq(repositioned.style.left, "14px", "ghost re-measured left after relayout");
        eq(repositioned.style.top, "32px", "ghost re-measured top after relayout");
      }
    }
  }
}

/** Config 200 + suggest pending once, then suggestions. */
function setupFetchScenario(harness) {
  let suggestCalls = 0;
  harness.setFetchHandler((url) => {
    if (routeOf(url) === "/next-prompt/config") {
      return { status: 200, body: { ok: true, enabled: true, showGhost: true, maxSuggestions: 3 } };
    }
    if (routeOf(url) === "/next-prompt/suggest") {
      suggestCalls += 1;
      if (suggestCalls === 1) return { status: 200, body: { ok: true, sessionId: "session-1", pending: true, suggestions: [] } };
      return {
        status: 200,
        body: {
          ok: true,
          sessionId: "session-1",
          suggestions: ["Add error handling to the parser", "Write tests for the new parser"],
          source: "llm",
          generatedAt: Date.now(),
        },
      };
    }
    return { status: 404, body: { ok: false } };
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const shippedPath = args[0] || (fs.existsSync(DEFAULT_SHIPPED) ? DEFAULT_SHIPPED : null);

  runStructuralTests();

  if (shippedPath === null) {
    section("shipped bundle scenarios");
    console.log("  skip: no bundle path given and " + DEFAULT_SHIPPED + " does not exist");
  } else if (!fs.existsSync(shippedPath)) {
    section("shipped bundle scenarios");
    console.log("  skip: " + shippedPath + " does not exist");
  } else {
    console.log("\n(shipped bundle: " + shippedPath + ")");
    await runShippedTests(shippedPath);
  }

  console.log("\n" + passed + " assertions passed, " + failures.length + " failed");
  if (failures.length > 0) {
    for (const failure of failures) console.log("  - " + failure.label + " " + JSON.stringify(failure.detail));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
