/**
 * Fake-loader harness for hand-written DSH client bundles.
 *
 * Loads a lazy-CJS bundle (`window.__ModuleLoader__.load({ id, factory })`) with
 * a fake window/document/React/fetch, calls `factory(require)` like the page
 * module system does, and hands back the exports plus a fake Cordis ctx that
 * records everything `apply(ctx)` does.
 *
 * `node run.mjs` exercises the bundled test bundle; `node run.mjs <bundle>`
 * additionally drives the shipped component through the DOM/UX scenarios.
 */

import fs from "node:fs";
import { createDom, FakeResizeObserver, FakeEvent } from "./fake-dom.mjs";
import { createReact } from "./fake-react.mjs";

const BASELINE_MODULES = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "zod",
  "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
]);

export function createHarness() {
  const dom = createDom();
  const react = createReact(dom);
  const requests = [];
  let fetchHandler = (url) => ({ status: 404, body: { ok: false, error: "not-implemented", url } });
  let inflight = 0;

  function fetchImpl(url, init) {
    requests.push({ url, init });
    inflight += 1;
    const controller = init && init.signal;
    return new Promise((resolve, reject) => {
      const settle = (result) => {
        inflight -= 1;
        if (controller && controller.aborted) {
          reject(abortError());
          return;
        }
        if (result && result.reject) {
          reject(result.reject instanceof Error ? result.reject : new Error(String(result.reject)));
          return;
        }
        const status = result && result.status !== undefined ? result.status : 200;
        const body = result && result.body !== undefined ? result.body : {};
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: { get: () => "application/json" },
          json: async () => body,
          text: async () => JSON.stringify(body),
        });
      };
      Promise.resolve()
        .then(() => fetchHandler(url, init, requests.length))
        .then((result) => setTimeout(() => settle(result), 0))
        .catch((error) => setTimeout(() => settle({ reject: error }), 0));
      if (controller) {
        controller.addEventListener("abort", () => {
          setTimeout(() => settle({}) , 0);
        });
      }
    });
  }

  function setFetchHandler(handler) {
    fetchHandler = handler;
  }

  dom.window.fetch = fetchImpl;
  dom.window.ResizeObserver = FakeResizeObserver;
  dom.window.AbortController = AbortController;
  dom.window.__ModuleLoader__ = {
    loaded: null,
    load(entry) {
      dom.window.__ModuleLoader__.loaded = entry;
    },
  };

  function loadBundle(filePath) {
    const code = fs.readFileSync(filePath, "utf8");
    const requireTargets = [];
    const requireFn = (specifier) => {
      requireTargets.push(specifier);
      if (specifier === "react") return react;
      if (specifier === "react/jsx-runtime") {
        return {
          Fragment: react.Fragment,
          jsx: (type, props) => react.createElement(type, props),
          jsxs: (type, props) => react.createElement(type, props),
        };
      }
      throw new Error(`harness: unexpected require("${specifier}")`);
    };
    const factoryRun = new Function(
      "window",
      "document",
      "fetch",
      "AbortController",
      "ResizeObserver",
      "setTimeout",
      "clearTimeout",
      "queueMicrotask",
      "console",
      code,
    );
    factoryRun(
      dom.window,
      dom.document,
      fetchImpl,
      AbortController,
      FakeResizeObserver,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      console,
    );
    const entry = dom.window.__ModuleLoader__.loaded;
    if (entry === null || entry === undefined) {
      throw new Error("harness: bundle did not call window.__ModuleLoader__.load()");
    }
    if (typeof entry.factory !== "function") throw new Error("harness: load() entry has no factory function");
    const exports = entry.factory(requireFn);
    return { id: entry.id, exports, requireTargets, source: code };
  }

  return {
    dom,
    react,
    requests,
    loadBundle,
    setFetchHandler,
    get inflight() {
      return inflight;
    },
    makeProps: (overrides) => makeProps(dom, overrides),
    dispatchKey: (init) => dispatchKey(dom, init),
    mountComponent: (component, props, container) => {
      const host = container || dom.body;
      const wrapper = dom.document.createElement("div");
      wrapper.setAttribute("data-test-root", "");
      wrapper.style.display = "contents";
      host.appendChild(wrapper);
      const root = react.mount(wrapper, component, props);
      return root;
    },
    BASELINE_MODULES,
  };
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** Build the session-scoped standard props a conversation.input.overlay entry gets. */
export function makeProps(dom, overrides = {}) {
  const state = {
    input: { draft: "", attachmentIds: [], draftRev: 0, phase: "plain", occurrences: [], queue: [] },
    session: { running: false, blank: false, removed: false, subagent: null },
    status: new Map(),
    inputActions: {
      setDraftCalls: [],
      setDraft(text) {
        state.inputActions.setDraftCalls.push(text);
      },
      insertText() {
        return false;
      },
      captureInsertion() {
        return { from: 0, to: 0, draftRev: 0 };
      },
      persistDraft() {},
      addAttachments() {
        return true;
      },
      removeAttachment() {},
      pruneAttachments() {},
      submit() {},
    },
  };
  const selectAll = (value) => value;
  const props = {
    sessionId: "session-1",
    t: (key) => `t:${key}`,
    useInput: (selector) => (selector ? selector(state.input) : state.input),
    useSession: (selector) => (selector ? selector(state.session) : state.session),
    useSessionStatus: (selector) => (selector ? selector(state.status) : state.status),
    useSessions: (selector) => (selector ? selector({ ids: [], byId: {} }) : { ids: [], byId: {} }),
    useConversation: (selector) => (selector ? selector({}) : {}),
    inputActions: state.inputActions,
  };
  return Object.assign({ __state: state }, props, overrides);
}

/** Set up a stock composer DOM under document.body and return the anchors. */
export function setupComposer(dom, options = {}) {
  const document = dom.document;
  const card = document.createElement("div");
  card.setAttribute("data-composer-card", "");
  const overlay = document.createElement("div");
  overlay.setAttribute("data-composer-overlay", "");
  const scroll = document.createElement("div");
  scroll.setAttribute("data-input-scroll", "");
  const grow = document.createElement("div");
  const input = document.createElement("div");
  input.setAttribute("data-composer-input", "");
  input.setAttribute("role", "textbox");
  const placeholder = document.createElement("div");
  placeholder.setAttribute("data-composer-placeholder", "");
  placeholder.textContent = options.placeholderText || "Ask anything";
  placeholder.style.visibility = "";
  const row = document.createElement("div");
  card.setAttribute("data-card", "");
  card.append(overlay, scroll);
  scroll.append(grow);
  grow.append(input, placeholder);
  card.append(row);
  document.body.appendChild(card);

  card.setRect({ left: 100, top: 30, width: 720, height: 120 });
  overlay.setRect({ left: 100, top: 30, width: 720, height: 0 });
  scroll.setRect({ left: 100, top: 38, width: 720, height: 36 });
  grow.setRect({ left: 100, top: 38, width: 720, height: 36 });
  input.setRect({ left: 100, top: 38, width: 720, height: 36 });
  const ph = Object.assign({ left: 114, top: 42, width: 700, height: 24 }, options.placeholderRect || {});
  placeholder.setRect(ph);
  placeholder.__computedStyle = Object.assign(
    {
      fontFamily: '"Inter", system-ui, sans-serif',
      fontSize: "14px",
      fontWeight: "400",
      fontStyle: "normal",
      lineHeight: "24px",
      letterSpacing: "normal",
      direction: "ltr",
      getPropertyValue: () => "",
    },
    options.placeholderStyle || {},
  );
  return { card, overlay, scroll, grow, input, placeholder, row };
}

/** Dispatch a bubbling window keydown event (the shipped listener is on window). */
export function dispatchKey(dom, init) {
  const event = new FakeEvent("keydown", {
    key: init.key,
    code: init.code || init.key,
    shiftKey: init.shiftKey === true,
    altKey: init.altKey === true,
    ctrlKey: init.ctrlKey === true,
    metaKey: init.metaKey === true,
    repeat: init.repeat === true,
    isComposing: init.isComposing === true,
    keyCode: init.keyCode || 0,
    target: init.target || dom.document.activeElement || dom.body,
  });
  if (init.defaultPrevented) event.defaultPrevented = true;
  dom.window.dispatchEvent(event);
  return event;
}

export { FakeEvent, FakeResizeObserver };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Advance timers/microtasks enough for debounce + fetch polling chains. */
export async function settle(harness, ms = 1600) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    await sleep(20);
  }
}
