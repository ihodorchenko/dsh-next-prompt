/**
 * Minimal React-compatible runtime for the harness: createElement + the hooks the
 * shipped component uses, plus a tiny host renderer that turns the element tree
 * into fake-DOM nodes and commits effects the way React would (layout first,
 * then passive, re-rendering until state settles).
 *
 * Not a React substitute for production code: no context, no memo, no keys,
 * no reconciliation (the component's host subtree is rebuilt per pass, which is
 * exactly what the tests need because the component keeps DOM anchors via refs).
 */

const FRAGMENT = Symbol.for("react.fragment");

function flatten(children, out) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) flatten(child, out);
    else out.push(child);
  }
  return out;
}

function elementTypeName(type) {
  if (typeof type === "string") return type;
  if (typeof type === "function") return type.name || "Component";
  if (type === FRAGMENT) return "Fragment";
  return "Unknown";
}

export function createReact(dom) {
  const react = {
    Fragment: FRAGMENT,
    _root: null,
    createElement(type, props, ...children) {
      const nextProps = Object.assign({}, props || {});
      if (children.length === 1) nextProps.children = children[0];
      else if (children.length > 1) nextProps.children = children;
      return { $$typeof: "element", type, props: nextProps };
    },
  };

  // Real React exposes the hooks on the module object; components call
  // `React.useState(...)`. Delegate to the root that is currently rendering.
  for (const hookName of [
    "useState",
    "useRef",
    "useCallback",
    "useMemo",
    "useEffect",
    "useLayoutEffect",
  ]) {
    react[hookName] = (...args) => {
      const root = react._root;
      if (root === null) throw new Error(`harness react: ${hookName}() called outside a component render`);
      return root[hookName](...args);
    };
  }

  /** One mounted component instance. */
  class Root {
    constructor(container, component, owner) {
      this.container = container;
      this.component = component;
      this.owner = owner;
      this.hooks = [];
      this.cursor = 0;
      this.dirty = false;
      this.unmounted = false;
      this.depth = 0;
      this.props = null;
      this.refs = [];
    }

    render(props) {
      if (props !== undefined) this.props = props;
      if (this.unmounted) throw new Error("render after unmount");
      const previousRoot = this.owner._root;
      this.owner._root = this;
      try {
        return this._renderPasses();
      } finally {
        this.owner._root = previousRoot;
      }
    }

    _renderPasses() {
      let guard = 0;
      do {
        this.dirty = false;
        if (++guard > 40) throw new Error("render loop did not settle");
        this.cursor = 0;
        this.refs = [];
        const tree = this.component(this.props);
        const nodes = [];
        this.buildNode(tree, nodes);
        this.container.replaceChildren(...nodes);
        this.attachRefs();
        this.commit();
      } while (this.dirty);
      return this;
    }

    /** Flush a state update that happened outside render (async callback, event). */
    flush() {
      if (this.unmounted) return this;
      if (!this.dirty) return this;
      return this.render();
    }

    attachRefs() {
      for (const entry of this.refs) {
        if (entry.ref && typeof entry.ref === "object") entry.ref.current = entry.node;
        else if (typeof entry.ref === "function") entry.ref(entry.node);
      }
    }

    // ------------------------------------------------------------- host tree
    buildNode(node, out) {
      if (node === null || node === undefined || node === false || node === true) return;
      if (Array.isArray(node)) {
        for (const child of node) this.buildNode(child, out);
        return;
      }
      if (typeof node === "string" || typeof node === "number") {
        out.push(dom.document.createTextNode(node));
        return;
      }
      if (typeof node !== "object" || node.$$typeof !== "element") return;
      if (typeof node.type === "function") {
        const rendered = node.type(node.props || {});
        this.buildNode(rendered, out);
        return;
      }
      if (node.type === FRAGMENT) {
        this.buildNode(node.props.children, out);
        return;
      }
      if (typeof node.type !== "string") return;
      const el = dom.document.createElement(node.type);
      const props = node.props || {};
      for (const [key, value] of Object.entries(props)) {
        if (key === "children" || key === "ref") continue;
        if (key === "style" && value && typeof value === "object") {
          Object.assign(el.style, value);
          continue;
        }
        if (key === "className") {
          el.setAttribute("class", value);
          continue;
        }
        if (key === "hidden") {
          if (value) el.setAttribute("hidden", "");
          else el.removeAttribute("hidden");
          continue;
        }
        if (key === "aria-hidden") {
          el.setAttribute("aria-hidden", value ? "true" : "false");
          continue;
        }
        if (/^on[A-Z]/.test(key) && typeof value === "function") {
          el.addEventListener(key.slice(2).toLowerCase(), value);
          continue;
        }
        if (key === "value" || key === "checked" || key === "disabled") {
          el.setAttribute(key, value === true ? "" : String(value));
          continue;
        }
        if (value === null || value === undefined || value === false) continue;
        el.setAttribute(key, value === true ? "" : String(value));
      }
      out.push(el);
      if (props.ref) this.refs.push({ ref: props.ref, node: el });
      const childNodes = [];
      this.buildNode(props.children, childNodes);
      el.append(...childNodes);
    }

    // ----------------------------------------------------------------- hooks
    hook(init) {
      const index = this.cursor++;
      let record = this.hooks[index];
      if (record === undefined) {
        record = init();
        this.hooks[index] = record;
      }
      return record;
    }

    useState(initial) {
      const root = this;
      const record = this.hook(() => ({
        kind: "state",
        value: typeof initial === "function" ? initial() : initial,
      }));
      const setState = (next) => {
        const value = typeof next === "function" ? next(record.value) : next;
        if (Object.is(value, record.value)) return;
        record.value = value;
        root.dirty = true;
      };
      return [record.value, setState];
    }

    useRef(initial) {
      return this.hook(() => ({ kind: "ref", current: initial }));
    }

    useCallback(fn, deps) {
      return this.memo(fn, deps, "callback");
    }

    useMemo(fn, deps) {
      const record = this.hook(() => {
        const value = fn();
        return { kind: "memo", deps, value };
      });
      if (!sameDeps(record.deps, deps)) {
        record.deps = deps;
        record.value = fn();
      }
      return record.value;
    }

    memo(fn, deps) {
      const record = this.hook(() => ({ kind: "memo", deps: deps ? deps.slice() : deps, value: fn }));
      if (deps !== undefined && record.deps !== undefined && sameDeps(record.deps, deps)) return record.value;
      record.deps = deps ? deps.slice() : deps;
      record.value = fn;
      return record.value;
    }

    useEffect(fn, deps) {
      const record = this.hook(() => ({
        kind: "effect",
        phase: "passive",
        fn,
        deps: undefined,
        pendingDeps: deps ? deps.slice() : undefined,
        ran: false,
        cleanup: undefined,
      }));
      record.fn = fn;
      record.pendingDeps = deps ? deps.slice() : undefined;
    }

    useLayoutEffect(fn, deps) {
      const record = this.hook(() => ({
        kind: "effect",
        phase: "layout",
        fn,
        deps: undefined,
        pendingDeps: deps ? deps.slice() : undefined,
        ran: false,
        cleanup: undefined,
      }));
      record.fn = fn;
      record.pendingDeps = deps ? deps.slice() : undefined;
    }

    commit() {
      for (const phase of ["layout", "passive"]) {
        for (const record of this.hooks) {
          if (!record || record.kind !== "effect" || record.phase !== phase) continue;
          const deps = record.pendingDeps;
          const changed = deps === undefined || !record.ran || !sameDeps(record.deps, deps);
          if (!changed) continue;
          if (typeof record.cleanup === "function") {
            try {
              record.cleanup();
            } catch (error) {
              record.cleanup = undefined;
              throw error;
            }
          }
          record.cleanup = normaliseCleanup(record.fn());
          record.ran = true;
          record.deps = deps ? deps.slice() : undefined;
        }
      }
    }

    unmount() {
      if (this.unmounted) return;
      this.unmounted = true;
      for (const record of this.hooks) {
        if (record && record.kind === "effect" && typeof record.cleanup === "function") {
          try {
            record.cleanup();
          } catch {
            /* cleanup failures are reported by the test, not thrown here */
          }
          record.cleanup = undefined;
        }
      }
      this.container.replaceChildren();
    }

    hookCount() {
      return this.hooks.length;
    }
  }

  react.mount = (container, component, props) => new Root(container, component, react).render(props);

  return react;
}

function normaliseCleanup(value) {
  if (typeof value === "function") return value;
  return undefined;
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (!Object.is(left[i], right[i])) return false;
  return true;
}
