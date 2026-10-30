/**
 * Minimal DOM good enough to exercise the dsh-next-prompt ghost component in Node.
 *
 * Supported on purpose (only what the shipped bundle touches):
 *  - element creation / append / remove / replaceChildren
 *  - attributes + the `dataset` proxy
 *  - `style` as a plain mutable object
 *  - class / tag / attribute selectors: `tag`, `.cls`, `[attr]`, `[attr="v"]`,
 *    comma lists, and simple descendant chains separated by whitespace
 *  - closest / matches / querySelector / querySelectorAll / contains
 *  - getBoundingClientRect (scripted per element)
 *  - addEventListener / removeEventListener / dispatchEvent
 *  - focus() driving document.activeElement
 *  - document.head / body / documentElement / querySelector(All) / activeElement
 *
 * It is intentionally NOT a browser: no layout, no CSS cascade. The harness
 * scripts `getBoundingClientRect` and `getComputedStyle` to emulate the stock
 * composer card.
 */

let uid = 0;

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
    this.parentNode = null;
  }
  get parentElement() {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }
}

class FakeElement {
  constructor(tagName, doc) {
    this.nodeType = 1;
    this.tagName = String(tagName || "div").toUpperCase();
    this._doc = doc;
    this.parentNode = null;
    this.childNodes = [];
    this.style = {};
    this._attrs = Object.create(null);
    this._listeners = Object.create(null);
    this._rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
    this._uid = ++uid;
    const self = this;
    this.dataset = new Proxy(Object.create(null), {
      get(_t, key) {
        return self._attrs["data-" + dashCase(String(key))];
      },
      set(_t, key, value) {
        self.setAttribute("data-" + dashCase(String(key)), String(value));
        return true;
      },
      has(_t, key) {
        return ("data-" + dashCase(String(key))) in self._attrs;
      },
      deleteProperty(_t, key) {
        self.removeAttribute("data-" + dashCase(String(key)));
        return true;
      },
      ownKeys() {
        return Object.keys(self._attrs)
          .filter((k) => k.startsWith("data-"))
          .map((k) => camelCase(k.slice(5)));
      },
      getOwnPropertyDescriptor(_t, key) {
        const value = self._attrs["data-" + dashCase(String(key))];
        if (value === undefined) return undefined;
        return { value, writable: true, enumerable: true, configurable: true };
      },
    });
  }

  // ---------------------------------------------------------------- tree
  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }
  get parentElement() {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get isConnected() {
    let node = this;
    while (node !== null) {
      if (node === this._doc || node === this._doc.body || node === this._doc.documentElement) return true;
      node = node.parentNode;
    }
    return false;
  }
  appendChild(child) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...children) {
    for (const child of children) this.appendChild(typeof child === "string" ? this._doc.createTextNode(child) : child);
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...children) {
    for (const child of this.childNodes.slice()) child.parentNode = null;
    this.childNodes.length = 0;
    this.append(...children);
  }
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }

  // ----------------------------------------------------------- attributes
  setAttribute(name, value) {
    this._attrs[String(name)] = String(value);
  }
  getAttribute(name) {
    const value = this._attrs[String(name)];
    return value === undefined ? null : value;
  }
  removeAttribute(name) {
    delete this._attrs[String(name)];
  }
  hasAttribute(name) {
    return String(name) in this._attrs;
  }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : !!force;
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return on;
  }
  get className() {
    return this._attrs.class || "";
  }
  set className(value) {
    this.setAttribute("class", value);
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(value) {
    this.toggleAttribute("hidden", !!value);
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(value) {
    this.replaceChildren(this._doc.createTextNode(String(value)));
  }

  // --------------------------------------------------------------- selectors
  matches(selector) {
    return selector.split(",").some((part) => matchesChain(this, part.trim()));
  }
  closest(selector) {
    let node = this;
    while (node !== null && node !== undefined) {
      if (node instanceof FakeElement && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  contains(node) {
    let current = node;
    while (current !== null && current !== undefined) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  // -------------------------------------------------------------------- rect
  setRect(rect) {
    this._rect = Object.assign({ left: 0, top: 0, width: 0, height: 0 }, rect);
    this._rect.right = this._rect.left + this._rect.width;
    this._rect.bottom = this._rect.top + this._rect.height;
    this._rect.x = this._rect.left;
    this._rect.y = this._rect.top;
    return this;
  }
  getBoundingClientRect() {
    return this._rect;
  }

  // ------------------------------------------------------------------ focus
  focus() {
    if (this._doc) this._doc.activeElement = this;
  }
  blur() {
    if (this._doc && this._doc.activeElement === this) this._doc.activeElement = this._doc.body;
  }

  // --------------------------------------------------------------- listeners
  addEventListener(type, handler) {
    (this._listeners[type] || (this._listeners[type] = [])).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners[type];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatchEvent(event) {
    event.currentTarget = this;
    if (event.target == null) event.target = this;
    const list = this._listeners[event.type] || [];
    for (const handler of list.slice()) {
      if (event._stopImmediate) break;
      handler.call(this, event);
      if (event._stop) break;
    }
    return !event.defaultPrevented;
  }
}

function dashCase(name) {
  return name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}
function camelCase(name) {
  return name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

/** Simple selector grammar: "tag.cls[attr][attr=\"v\"]" tokens, space = descendant. */
function parseCompound(compound) {
  const spec = { tag: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let match;
  let consumed = 0;
  while ((match = re.exec(compound)) !== null) {
    if (match.index !== consumed) return null;
    consumed = re.lastIndex;
    if (match[1]) spec.tag = match[1].toUpperCase();
    else if (match[2]) spec.classes.push(match[2]);
    else if (match[3]) spec.attrs.push({ name: match[3], value: match[4] !== undefined ? match[4] : match[5] !== undefined ? match[5] : match[6] });
  }
  if (consumed !== compound.length) return null;
  return spec;
}

function matchesCompound(node, spec) {
  if (!(node instanceof FakeElement)) return false;
  if (spec.tag !== null && node.tagName !== spec.tag) return false;
  for (const cls of spec.classes) {
    if (!node.className.split(/\s+/).includes(cls)) return false;
  }
  for (const attr of spec.attrs) {
    const value = node.getAttribute(attr.name);
    if (value === null) return false;
    if (attr.value !== undefined && value !== attr.value) return false;
  }
  return true;
}

function matchesChain(node, selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const compounds = parts.map(parseCompound);
  if (compounds.some((c) => c === null)) return false;
  let current = node;
  let index = compounds.length - 1;
  if (!matchesCompound(current, compounds[index])) return false;
  index -= 1;
  while (index >= 0) {
    let ancestor = current.parentNode;
    let found = false;
    while (ancestor !== null && ancestor !== undefined) {
      if (ancestor instanceof FakeElement && matchesCompound(ancestor, compounds[index])) {
        found = true;
        break;
      }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
    current = ancestor;
    index -= 1;
  }
  return true;
}

class FakeEvent {
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init || {});
    this.defaultPrevented = this.defaultPrevented === true;
    this._stop = false;
    this._stopImmediate = false;
    this.target = this.target || null;
    this.currentTarget = null;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stop = true;
  }
  stopImmediatePropagation() {
    this._stop = true;
    this._stopImmediate = true;
  }
}

class FakeDocument {
  constructor() {
    this.nodeType = 9;
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.visibilityState = "visible";
    this._listeners = Object.create(null);
  }
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
  createTextNode(text) {
    return new FakeText(text);
  }
  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
  getElementById(id) {
    return this.querySelector("#" + id);
  }
  addEventListener(type, handler) {
    (this._listeners[type] || (this._listeners[type] = [])).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners[type] || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    for (const handler of (this._listeners[event.type] || []).slice()) handler.call(this, event);
    return !event.defaultPrevented;
  }
  defaultView() {
    return null;
  }
}

class FakeWindow {
  constructor(document) {
    this.document = document;
    this._listeners = Object.create(null);
    this.innerWidth = 1440;
    this.innerHeight = 900;
    this.navigator = { language: "en-US", languages: ["en-US", "en"] };
    this.location = { href: "http://127.0.0.1:59045/", origin: "http://127.0.0.1:59045" };
  }
  addEventListener(type, handler, _options) {
    (this._listeners[type] || (this._listeners[type] = [])).push(handler);
  }
  removeEventListener(type, handler, _options) {
    const list = this._listeners[type] || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    for (const handler of (this._listeners[event.type] || []).slice()) handler.call(this, event);
    return !event.defaultPrevented;
  }
  getComputedStyle(element) {
    return element.__computedStyle || defaultComputedStyle();
  }
  requestAnimationFrame(callback) {
    return setTimeout(() => callback(Date.now()), 0);
  }
  cancelAnimationFrame(id) {
    clearTimeout(id);
  }
  getSelection() {
    return null;
  }
}

function defaultComputedStyle() {
  return {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontSize: "14px",
    fontWeight: "400",
    fontStyle: "normal",
    lineHeight: "24px",
    letterSpacing: "normal",
    direction: "ltr",
    textAlign: "start",
    color: "rgb(120, 120, 120)",
    getPropertyValue() {
      return "";
    },
  };
}

/** ResizeObserver stub: tests can fire `flush()` to run every callback once. */
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
    FakeResizeObserver.instances.push(this);
  }
  observe(target) {
    this.targets.push(target);
  }
  unobserve(target) {
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
  }
  disconnect() {
    this.targets.length = 0;
    const index = FakeResizeObserver.instances.indexOf(this);
    if (index >= 0) FakeResizeObserver.instances.splice(index, 1);
  }
  static flushAll() {
    for (const instance of FakeResizeObserver.instances.slice()) instance.callback([], instance);
  }
  static reset() {
    FakeResizeObserver.instances.length = 0;
  }
}
FakeResizeObserver.instances = [];

export function createDom() {
  const document = new FakeDocument();
  const window = new FakeWindow(document);
  return {
    document,
    window,
    FakeElement,
    FakeEvent,
    FakeResizeObserver,
    createElement: (tag) => document.createElement(tag),
    body: document.body,
    head: document.head,
  };
}

export { FakeElement, FakeEvent, FakeText, FakeResizeObserver, fakeCamelCase as camelCase, fakeDashCase as dashCase };

function fakeCamelCase(value) {
  return camelCase(value);
}
function fakeDashCase(value) {
  return dashCase(value);
}
