#!/usr/bin/env node
/**
 * dsh-next-prompt — static + fake-loader verification for the browser bundle.
 *
 *   node test/check-client.mjs [bundle.js] [expected-id]
 *
 * Defaults: ../lib/client.js and "dsh-next-prompt".
 *
 * Checks (exit code 0 = all required checks pass):
 *   1. `node --check` syntax pass on the file as a script
 *   2. wrapper is `window.__ModuleLoader__.load({ id, factory })`, called once
 *   3. id equals the package/row id (the loader rejects mismatches at runtime)
 *   4. factory materialises without DOM access and returns exports.apply (function)
 *      and exports.inject (string array, contains "slots")
 *   5. every `require()` target is in the shell platform table (no `external` deps)
 *   6. no ESM syntax, no dynamic import, no require.async, no eval/new Function,
 *      no document.write, no hardcoded http(s) URLs (same-origin routes only)
 *   7. `apply(ctx)` runs against a fake client context: registers the overlay slot
 *      entry (name/id/locale), registers en+ru dictionaries, injects one style tag
 *      carrying data-plugin
 *
 * No dependencies; works with any Node >= 18 (uses node: builtins only).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = path.resolve(HERE, "../lib/client.js");
const DEFAULT_ID = "dsh-next-prompt";

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

const SLOT_NAME = "conversation.input.overlay";

const results = [];
function check(ok, label, detail) {
  results.push({ ok: !!ok, label, detail });
  const suffix = detail === undefined ? "" : " -> " + JSON.stringify(detail);
  console.log((ok ? "  ok   " : "  FAIL ") + label + suffix);
}
function section(title) {
  console.log("\n# " + title);
}

const bundlePath = path.resolve(process.argv[2] || DEFAULT_BUNDLE);
const expectedId = process.argv[3] || DEFAULT_ID;

function main() {
  section("bundle file");
  if (!fs.existsSync(bundlePath)) {
    check(false, "bundle file exists", bundlePath);
    return finish();
  }
  const source = fs.readFileSync(bundlePath, "utf8");
  check(source.length > 1000, "bundle is non-trivial", { bytes: source.length });
  check(!source.includes("//# sourceMappingURL"), "hand-written bundle carries no source-map trailer");

  section("syntax");
  try {
    execFileSync(process.execPath, ["--check", bundlePath], { stdio: "pipe" });
    check(true, "node --check passes (script syntax)");
  } catch (error) {
    check(false, "node --check passes (script syntax)", String(error.stderr || error.message).slice(0, 400));
    return finish();
  }

  section("lazy-CJS wrapper");
  let loadCalls = 0;
  let entry = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(value) {
        loadCalls += 1;
        entry = value;
      },
    },
  };
  let evaluateError = null;
  try {
    // Only `window` is injected; `document` must resolve from the global scope at
    // call time (as in the page). It is deliberately absent here, so a bundle that
    // touches the DOM while materialising fails this check loudly.
    const run = new Function("window", source);
    run(fakeWindow);
  } catch (error) {
    evaluateError = error;
  }
  check(evaluateError === null, "bundle evaluates with window.__ModuleLoader__ only", evaluateError && String(evaluateError));
  check(loadCalls === 1, "window.__ModuleLoader__.load called exactly once", { loadCalls });
  check(entry !== null && typeof entry === "object", "load() receives an entry object");
  check(entry !== null && Object.prototype.hasOwnProperty.call(entry, "id"), "entry declares id");
  check(entry !== null && entry.id === expectedId, "entry id matches the package/row id", {
    actual: entry && entry.id,
    expected: expectedId,
  });
  check(entry !== null && typeof entry.factory === "function", "entry declares a factory function");

  section("factory exports + require surface");
  const requireTargets = [];
  const reactStub = {
    Fragment: Symbol("react.fragment"),
    createElement: () => ({}),
    useState: () => {
      throw new Error("factory executed a React hook at materialization time");
    },
    useEffect: () => {
      throw new Error("factory executed a React hook at materialization time");
    },
    useLayoutEffect: () => {
      throw new Error("factory executed a React hook at materialization time");
    },
    useRef: () => {
      throw new Error("factory executed a React hook at materialization time");
    },
    useCallback: () => {
      throw new Error("factory executed a React hook at materialization time");
    },
    useMemo: () => {
      throw new Error("factory executed a React hook at materialization time");
    },
  };
  const requireFn = (specifier) => {
    requireTargets.push(specifier);
    if (specifier === "react") return reactStub;
    throw new Error(`require("${specifier}") is not in the baseline table`);
  };
  let exports = null;
  let factoryError = null;
  try {
    exports = entry.factory(requireFn);
  } catch (error) {
    factoryError = error;
  }
  check(factoryError === null, "factory materialises without DOM access", factoryError && String(factoryError));
  check(exports !== null && typeof exports === "object", "factory returns an exports object");
  check(exports !== null && typeof exports.apply === "function", "exports.apply is a function");
  check(exports !== null && Array.isArray(exports.inject), "exports.inject is an array");
  const injectList = exports && Array.isArray(exports.inject) ? exports.inject : [];
  check(injectList.includes("slots"), "exports.inject includes the slots service", injectList);
  const unknownInject = injectList.filter((name) => typeof name !== "string");
  check(unknownInject.length === 0, "exports.inject holds service names only", unknownInject);
  check(requireTargets.length > 0, "factory requires at least one module", requireTargets);
  const outsideBaseline = requireTargets.filter((specifier) => !BASELINE_MODULES.has(specifier));
  check(outsideBaseline.length === 0, "all require() targets are in the shell platform table", outsideBaseline);

  section("forbidden constructs");
  const forbidden = [
    { pattern: /^\s*import\s+[\s\S]*?from\s/mgu, label: "no ESM import statements" },
    { pattern: /^\s*export\s+(?:default|const|function|class|\{)/mgu, label: "no ESM export statements" },
    { pattern: /\bimport\s*\(/gu, label: "no dynamic import()" },
    { pattern: /\brequire\.async\s*\(/gu, label: "no require.async (needs a built chunk)" },
    { pattern: /\beval\s*\(/gu, label: "no eval()" },
    { pattern: /new\s+Function\s*\(/gu, label: "no new Function()" },
    { pattern: /document\s*\.\s*write\s*\(/gu, label: "no document.write()" },
    { pattern: /https?:\/\//gu, label: "no hardcoded http(s) URLs (same-origin routes only)" },
    { pattern: /process\s*\.\s*(?:env|exit|cwd)/gu, label: "no Node process access" },
    { pattern: /\brequire\s*\(\s*["']node:/gu, label: "no node: builtin requires" },
  ];
  for (const rule of forbidden) {
    const matches = [...source.matchAll(rule.pattern)];
    check(matches.length === 0, rule.label, matches.slice(0, 3).map((m) => m[0]));
  }

  section("apply() against a fake client context");
  const styleTags = [];
  const dictionaries = [];
  const registrations = [];
  const injectKeys = [];
  const fakeDocument = {
    createElement(tagName) {
      const element = {
        tagName: String(tagName).toUpperCase(),
        dataset: {},
        style: {},
        textContent: "",
        parentNode: null,
        children: [],
        appendChild(child) {
          child.parentNode = element;
          element.children.push(child);
          return child;
        },
        removeChild(child) {
          const index = element.children.indexOf(child);
          if (index >= 0) element.children.splice(index, 1);
          child.parentNode = null;
          return child;
        },
      };
      return element;
    },
    head: {
      children: [],
      appendChild(child) {
        child.parentNode = fakeDocument.head;
        fakeDocument.head.children.push(child);
        if (child.tagName === "STYLE") styleTags.push(child);
        return child;
      },
      removeChild(child) {
        const index = fakeDocument.head.children.indexOf(child);
        if (index >= 0) fakeDocument.head.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
    },
  };
  const effects = [];
  const fakeCtx = {
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
        injectKeys.push(key);
        const dispose = callback();
        return typeof dispose === "function" ? dispose : () => {};
      },
      register(registration, component) {
        registrations.push({ registration, component });
        return () => {};
      },
    },
  };
  let applyError = null;
  try {
    // `document` is a global in the page; provide it for the apply() phase only.
    const previousDocument = globalThis.document;
    globalThis.document = fakeDocument;
    try {
      exports.apply(fakeCtx);
    } finally {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  } catch (error) {
    applyError = error;
  }
  check(applyError === null, "apply(ctx) does not throw", applyError && String(applyError));
  check(injectKeys.includes(SLOT_NAME), "apply defers registration on the overlay slot", injectKeys);
  const entryRegistration = registrations.find((item) => item.registration && item.registration.name === SLOT_NAME);
  check(entryRegistration !== undefined, "an overlay slot entry is registered", registrations.length);
  if (entryRegistration !== undefined) {
    check(
      typeof entryRegistration.registration.id === "string" && entryRegistration.registration.id.length > 0,
      "slot entry declares a list-slot id",
      entryRegistration.registration.id,
    );
    check(typeof entryRegistration.registration.order === "number", "slot entry declares a numeric order");
    check(
      typeof entryRegistration.registration.locale === "string" && entryRegistration.registration.locale.length > 0,
      "slot entry declares a locale namespace (required for the t seat)",
      entryRegistration.registration.locale,
    );
    check(typeof entryRegistration.component === "function", "slot entry component is a function");
  }
  check(dictionaries.length >= 1, "locale.register called from apply", dictionaries.length);
  const dictionary = dictionaries[0];
  if (dictionary !== undefined) {
    check(typeof dictionary.namespace === "string" && dictionary.namespace.length > 0, "locale namespace is a string");
    const locales = Object.keys(dictionary.dicts || {});
    check(locales.includes("en"), "dictionary contains en", locales);
    check(locales.includes("ru"), "dictionary contains ru", locales);
  }
  check(styleTags.length === 1, "apply injects exactly one style tag", styleTags.length);
  if (styleTags.length === 1) {
    check(styleTags[0].dataset.plugin === expectedId, "style tag carries data-plugin=<id>", styleTags[0].dataset.plugin);
    check(typeof styleTags[0].textContent === "string" && styleTags[0].textContent.length > 0, "style tag has content");
  }
  const disposers = effects.map((effect) => effect.dispose).filter((dispose) => typeof dispose === "function");
  check(disposers.length === effects.length, "every ctx.effect returned a disposer");

  section("fetch surface");
  const routePrefix = "/next-prompt";
  const routeLiterals = [...source.matchAll(/(["'`])(\/[A-Za-z0-9._~\/?=&-]+)\1/gu)]
    .map((match) => match[2])
    .filter((value) => value.startsWith(routePrefix));
  const uniqueRoutes = [...new Set(routeLiterals)];
  check(uniqueRoutes.length >= 2, "bundle declares the plugin route paths", uniqueRoutes);
  check(uniqueRoutes.some((value) => value.indexOf("/suggest") >= 0), "bundle declares the suggest route", uniqueRoutes);
  check(uniqueRoutes.some((value) => value.indexOf("/config") >= 0), "bundle declares the config route", uniqueRoutes);
  check(/\bfetch\s*\(/u.test(source), "bundle performs a same-origin fetch");
  const foreignFetch = [...source.matchAll(/fetch\s*\(\s*(["'`])([^"'`]+)\1/gu)]
    .map((match) => match[2])
    .filter((value) => !value.startsWith(routePrefix));
  check(foreignFetch.length === 0, "no inline fetch() to a foreign path", foreignFetch);

  return finish();
}

function finish() {
  const failures = results.filter((result) => !result.ok);
  console.log("\n" + (results.length - failures.length) + " checks passed, " + failures.length + " failed");
  if (failures.length > 0) {
    console.log("failed checks:");
    for (const failure of failures) console.log("  - " + failure.label + (failure.detail === undefined ? "" : " -> " + JSON.stringify(failure.detail)));
    process.exitCode = 1;
  }
  return failures.length === 0;
}

main();
