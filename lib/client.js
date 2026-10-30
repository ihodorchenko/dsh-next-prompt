/**
 * dsh-next-prompt — browser half.
 *
 * After an assistant turn completes, asks the host for a suggested next prompt
 * (`GET /next-prompt/suggest?session=<id>`) and renders the top suggestion as
 * ghost text inside the message composer. The user accepts it with Tab (or by
 * clicking it) and it is inserted through the standard composer action
 * `inputActions.setDraft(text)`; Escape or typing dismisses it.
 *
 * The bundle is a hand-written lazy-CJS factory in the shape the DSH client
 * module system materialises (`window.__ModuleLoader__.load({ id, factory })`):
 * executing the file only registers the factory; every side effect (style tag,
 * slot registration, locale dictionaries) runs inside `apply(ctx)`.
 *
 * Registration target: one entry of the session-scoped list slot
 * `conversation.input.overlay`, which the stock composer renders inside the
 * composer card (`<div data-composer-overlay>`), right above the editor. That
 * entry receives the session-scoped standard props
 * (`sessionId`, `useSession`, `useSessionStatus`, `useInput`, `inputActions`,
 * `t`) — see `lib/types/client/{index,scoped-slots}.js` in
 * `@deepseek-ai/dsh-client-ui-renderer` and the `uiSession.provide` calls in
 * `@deepseek-ai/dsh-client-ui-session` / `@deepseek-ai/dsh-client-ui-conversation`.
 *
 * Everything degrades silently: no anchors, no props, no locale, no host route
 * → no ghost, never a thrown error into the application.
 */
window.__ModuleLoader__.load({
	id: "dsh-next-prompt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		/* ------------------------------------------------------------- constants */

		/** Bundle id; must equal the package name and the /plugins row id. */
		var PLUGIN_ID = "dsh-next-prompt";
		/** Locale namespace owned by this plugin. */
		var NS = "next-prompt";
		/** Session-scoped list slot rendered inside the composer card. */
		var SLOT = "conversation.input.overlay";
		/** Identity of this plugin's entry inside that list slot. */
		var SLOT_ID = "next-prompt";
		/** Host routes (same origin, registered by the host half of this package). */
		var CONFIG_URL = "/next-prompt/config";
		var SUGGEST_URL = "/next-prompt/suggest?session=";
		/** How long a fetched /next-prompt/config answer is reused. */
		var CONFIG_TTL_MS = 300000;
		/** Delay before the first suggestion request after a turn ends. */
		var FIRST_REQUEST_DELAY_MS = 400;
		/** Backoff while the host reports `pending: true`. */
		var POLL_DELAYS_MS = [250, 400, 650, 1000, 1500];

		/** English dictionary (also the in-component fallback if `t` is missing). */
		var EN = {
			"ghost.label": "Suggested next prompt",
			"hint.tab": "Tab",
			"hint.accept": "Press Tab to use this suggestion, Esc to dismiss"
		};
		var ZH = {
			"ghost.label": "建议的下一条提示",
			"hint.tab": "Tab",
			"hint.accept": "按 Tab 使用此建议，按 Esc 忽略"
		};
		var RU = {
			"ghost.label": "Предлагаемый следующий запрос",
			"hint.tab": "Tab",
			"hint.accept": "Нажмите Tab, чтобы подставить подсказку; Esc — скрыть"
		};
		var DICTS = { en: EN, zh: ZH, ru: RU };

		/**
		 * Ghost styles. Theme tokens (`--dsw-alias-*`) come from the active shell
		 * theme, so light/dark and third-party skins work without extra code.
		 * The geometry/typography itself is written as inline styles by the
		 * component (measured from the real placeholder element).
		 */
		var CSS = [
			".dshnp-ghost {",
			"\tposition: absolute;",
			"\tdisplay: flex;",
			"\talign-items: baseline;",
			"\tgap: 8px;",
			"\tbox-sizing: border-box;",
			"\tmargin: 0;",
			"\tpadding: 0;",
			"\toverflow: hidden;",
			"\twhite-space: nowrap;",
			"\tpointer-events: none;",
			"}",
			".dshnp-text {",
			"\tflex: 0 1 auto;",
			"\tmin-width: 0;",
			"\toverflow: hidden;",
			"\ttext-overflow: ellipsis;",
			"\twhite-space: nowrap;",
			"\tfont-style: italic;",
			"\tcolor: var(--dsw-alias-label-tertiary, #8a8f98);",
			"\tpointer-events: auto;",
			"\tcursor: pointer;",
			"}",
			".dshnp-kbd {",
			"\tflex: none;",
			"\tfont-family: inherit;",
			"\tfont-size: 11px;",
			"\tfont-style: normal;",
			"\tfont-weight: 500;",
			"\tline-height: 16px;",
			"\tletter-spacing: 0;",
			"\tpadding: 0 5px;",
			"\tborder: 0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.5));",
			"\tborder-radius: 4px;",
			"\tcolor: var(--dsw-alias-label-tertiary, #8a8f98);",
			"\tbackground-color: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.08));",
			"\twhite-space: nowrap;",
			"\tuser-select: none;",
			"\t-webkit-user-select: none;",
			"\tpointer-events: auto;",
			"\tcursor: pointer;",
			"}",
			".dshnp-ghost:hover .dshnp-text {",
			"\tcolor: var(--dsw-alias-label-secondary, #6f7680);",
			"}",
			".dshnp-ghost:hover .dshnp-kbd {",
			"\tcolor: var(--dsw-alias-label-secondary, #6f7680);",
			"\tborder-color: var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.7));",
			"}"
		].join("\n");

		/* --------------------------------------------------------------- logging */

		/** Log a warning without ever throwing (a broken logger must not break apply). */
		function warn(message, error) {
			try {
				if (typeof console !== "undefined" && console !== null && typeof console.warn === "function") {
					console.warn("[" + PLUGIN_ID + "] " + message, error);
				}
			} catch (ignored) {
				/* nothing sensible to do */
			}
		}

		/* --------------------------------------------------------------- helpers */

		/** Stable selector hooks (created once, so slot subscriptions stay quiet). */
		function selectSnapshot(snapshot) {
			return snapshot;
		}
		function selectRunning(session) {
			return session === null || session === undefined ? undefined : session.running;
		}

		function isNonEmptyString(value) {
			return typeof value === "string" && value.trim() !== "";
		}

		/** Translate with an English fallback when `t` is missing or returns a key. */
		function translate(t, key) {
			if (typeof t === "function") {
				var translated = t(key);
				if (typeof translated === "string" && translated !== "" && translated !== key) return translated;
			}
			var fallback = EN[key];
			return typeof fallback === "string" ? fallback : key;
		}

		/** Same-origin JSON GET; resolves `null` on any transport/HTTP/parse failure. */
		function fetchJson(url, signal) {
			var init = {
				method: "GET",
				headers: { Accept: "application/json" },
				cache: "no-store",
				credentials: "same-origin"
			};
			if (signal !== undefined && signal !== null) init.signal = signal;
			return fetch(url, init).then(
				function (response) {
					if (response === null || response === undefined || response.ok !== true) return null;
					return response.json().then(
						function (data) {
							return data;
						},
						function () {
							return null;
						}
					);
				},
				function () {
					return null;
				}
			);
		}

		/** Cached /next-prompt/config (the client never receives the row config). */
		var configCache = { value: null, at: 0, promise: null };

		function normalizeConfig(data) {
			var config = { enabled: true, showGhost: true, maxSuggestions: 3 };
			if (data !== null && typeof data === "object") {
				if (data.enabled === false) config.enabled = false;
				if (data.showGhost === false) config.showGhost = false;
				if (typeof data.maxSuggestions === "number" && data.maxSuggestions > 0) {
					config.maxSuggestions = Math.floor(data.maxSuggestions);
				}
			}
			return config;
		}

		function readConfig() {
			var now = Date.now();
			if (configCache.value !== null && now - configCache.at < CONFIG_TTL_MS) {
				return Promise.resolve(configCache.value);
			}
			if (configCache.promise !== null) return configCache.promise;
			var promise = fetchJson(CONFIG_URL, undefined).then(
				function (data) {
					var config = normalizeConfig(data);
					configCache.value = config;
					configCache.at = Date.now();
					configCache.promise = null;
					return config;
				},
				function () {
					configCache.promise = null;
					return normalizeConfig(null);
				}
			);
			configCache.promise = promise;
			return promise;
		}

		function samePosition(left, right) {
			if (left === right) return true;
			if (left === null || right === null || left === undefined || right === undefined) return false;
			return (
				left.left === right.left &&
				left.top === right.top &&
				left.width === right.width &&
				left.height === right.height &&
				left.fontFamily === right.fontFamily &&
				left.fontSize === right.fontSize &&
				left.fontWeight === right.fontWeight &&
				left.lineHeight === right.lineHeight &&
				left.letterSpacing === right.letterSpacing &&
				left.direction === right.direction &&
				left.textAlign === right.textAlign
			);
		}

		/* -------------------------------------------------------------- styles */

		/** Inject exactly one style tag; the disposer removes it again. */
		function mountStyle() {
			if (typeof document === "undefined" || document === null || document.head === null || document.head === undefined) {
				return function () {};
			}
			var existing = null;
			try {
				existing = document.querySelector('style[data-plugin-css="' + PLUGIN_ID + '/ghost.css"]');
			} catch (ignored) {
				existing = null;
			}
			if (existing !== null && existing !== undefined) return function () {};
			var style = document.createElement("style");
			style.dataset.plugin = PLUGIN_ID;
			style.dataset.pluginCss = PLUGIN_ID + "/ghost.css";
			style.textContent = CSS;
			document.head.appendChild(style);
			return function () {
				try {
					if (style.parentNode !== null && style.parentNode !== undefined) style.parentNode.removeChild(style);
				} catch (ignored) {
					/* already detached */
				}
			};
		}

		/* ----------------------------------------------------------- component */

		/**
		 * One per Session composer. Owns the turn-end detection, the suggestion
		 * request cycle, the ghost DOM and the accept/dismiss behaviour.
		 *
		 * @param props - session-scoped slot standard props (see module doc).
		 * @returns the ghost element while a suggestion is available, else null.
		 */
		function NextPromptGhost(props) {
			var t = props === null || props === undefined ? undefined : props.t;
			var sessionId = props !== null && props !== undefined && typeof props.sessionId === "string" ? props.sessionId : "";
			var inputActions = props !== null && props !== undefined ? props.inputActions : undefined;
			var useInput = props !== null && props !== undefined && typeof props.useInput === "function" ? props.useInput : null;
			var useSession = props !== null && props !== undefined && typeof props.useSession === "function" ? props.useSession : null;
			var useSessionStatus =
				props !== null && props !== undefined && typeof props.useSessionStatus === "function" ? props.useSessionStatus : null;

			/* Slot-standard selector hooks. Their presence is fixed for the lifetime
			 * of the entry, so the conditional calls keep a stable hook order. */
			var input = useInput !== null ? useInput(selectSnapshot) : null;
			var sessionRunning = useSession !== null ? useSession(selectRunning) : undefined;
			var statusSelector = React.useCallback(
				function (statusMap) {
					if (sessionId === "" || statusMap === null || statusMap === undefined || typeof statusMap.get !== "function") {
						return undefined;
					}
					var status = statusMap.get(sessionId);
					return status === undefined || status === null ? undefined : status.running;
				},
				[sessionId]
			);
			var statusRunning = useSessionStatus !== null ? useSessionStatus(statusSelector) : undefined;

			/* Component state. */
			var suggestionState = React.useState(null);
			var suggestion = suggestionState[0];
			var setSuggestion = suggestionState[1];
			var dismissedState = React.useState(false);
			var dismissed = dismissedState[0];
			var setDismissed = dismissedState[1];
			var positionState = React.useState(null);
			var position = positionState[0];
			var setPosition = positionState[1];
			var enabledState = React.useState(true);
			var showGhostEnabled = enabledState[0];
			var setShowGhostEnabled = enabledState[1];

			/* Refs: event/timer/async continuations read the latest values from here. */
			var ghostRef = React.useRef(null);
			var previousRunningRef = React.useRef(undefined);
			var previousVisibleRef = React.useRef(false);
			var abortRef = React.useRef(null);
			var timersRef = React.useRef([]);
			var cycleTokenRef = React.useRef(0);
			var placeholderRef = React.useRef(null);
			var liveStateRef = React.useRef(null);

			/* Derived composer state. */
			var draft = input !== null && input !== undefined && typeof input.draft === "string" ? input.draft : "";
			var attachmentCount =
				input !== null && input !== undefined && input.attachmentIds !== undefined && input.attachmentIds !== null
					? input.attachmentIds.length
					: 0;
			var phase = input !== null && input !== undefined && typeof input.phase === "string" ? input.phase : "inert";
			var running = sessionRunning === true || statusRunning === true;
			var idle = running !== true;
			/* Mirrors the stock input bar: the placeholder (our alignment anchor)
			 * exists only for draft === "" (not trim()) with no attachments or claim. */
			var empty = draft === "" && attachmentCount === 0 && phase === "plain";
			var visible =
				sessionId !== "" &&
				suggestion !== null &&
				suggestion !== "" &&
				dismissed !== true &&
				idle === true &&
				empty === true &&
				showGhostEnabled === true;

			/* ---------------------------------------------------- config (once) */

			React.useEffect(function () {
				var cancelled = false;
				readConfig().then(function (config) {
					if (cancelled) return;
					setShowGhostEnabled(config.enabled !== false && config.showGhost !== false);
				});
				return function () {
					cancelled = true;
				};
			}, []);

			/* --------------------------------------------------- cycle machinery */

			function clearTimers() {
				var timers = timersRef.current;
				timersRef.current = [];
				for (var index = 0; index < timers.length; index += 1) {
					try {
						clearTimeout(timers[index]);
					} catch (ignored) {
						/* timer already gone */
					}
				}
			}

			function cancelCycle() {
				cycleTokenRef.current += 1;
				clearTimers();
				var controller = abortRef.current;
				abortRef.current = null;
				if (controller !== null && controller !== undefined && typeof controller.abort === "function") {
					try {
						controller.abort();
					} catch (ignored) {
						/* nothing sensible to do */
					}
				}
			}

			function later(callback, delay) {
				var timer = setTimeout(function () {
					try {
						callback();
					} catch (error) {
						warn("deferred step failed", error);
					}
				}, delay);
				timersRef.current.push(timer);
			}

			function startCycle() {
				cancelCycle();
				if (sessionId === "") return;
				if (showGhostEnabled !== true) return;
				var token = cycleTokenRef.current;
				var controller = typeof AbortController === "function" ? new AbortController() : null;
				abortRef.current = controller;
				var attempt = 0;
				var signal = controller !== null ? controller.signal : undefined;

				function isCurrent() {
					return cycleTokenRef.current === token;
				}

				function finish() {
					if (!isCurrent()) return;
					if (abortRef.current === controller) abortRef.current = null;
				}

				function deliver(text) {
					if (!isCurrent()) return;
					if (abortRef.current === controller) abortRef.current = null;
					setSuggestion(text);
				}

				function request() {
					if (!isCurrent()) return;
					fetchJson(SUGGEST_URL + encodeURIComponent(sessionId), signal).then(function (data) {
						if (!isCurrent()) return;
						if (data === null || data === undefined || data.ok === false) {
							finish();
							return;
						}
						/* Show the best candidate we have right now. The host publishes a
						 * heuristic list immediately (pending:true) and the LLM refinement
						 * later, so a delivered suggestion is replaced by later polls. */
						var candidates =
							data.suggestions !== undefined && data.suggestions !== null && typeof data.suggestions.length === "number"
								? data.suggestions
								: [];
						for (var index = 0; index < candidates.length; index += 1) {
							if (isNonEmptyString(candidates[index])) {
								deliver(candidates[index].trim());
								break;
							}
						}
						/* Keep polling while the host says the answer is still being
						 * refined; the chain is bounded by POLL_DELAYS_MS and dies with
						 * cancelCycle() on hide/accept/dismiss/turn-start/unmount. */
						if (data.pending === true && attempt < POLL_DELAYS_MS.length) {
							var delay = POLL_DELAYS_MS[attempt];
							attempt += 1;
							later(request, delay);
							return;
						}
						finish();
					});
				}

				later(request, FIRST_REQUEST_DELAY_MS);
			}

			/* ---------------------------------------- turn-end / running effects */

			React.useEffect(function () {
				var previous = previousRunningRef.current;
				previousRunningRef.current = running;
				if (running === true) {
					cancelCycle();
					setSuggestion(null);
					setDismissed(false);
					return;
				}
				if (previous === true) {
					setDismissed(false);
					setSuggestion(null);
					startCycle();
				}
			}, [running]);

			/* Typing dismisses the ghost for this turn and stops any pending poll. */
			React.useEffect(function () {
				previousVisibleRef.current = visible;
				if (draft === "") return;
				if (suggestion !== null) setDismissed(true);
				if (abortRef.current !== null || timersRef.current.length > 0) cancelCycle();
			}, [visible, draft]);

			/* ---------------------------------------------- placeholder + layout */

			function hidePlaceholder(placeholder) {
				var record = placeholderRef.current;
				if (record !== null && record !== undefined && record.element !== placeholder) restorePlaceholder();
				if (placeholderRef.current !== null && placeholderRef.current !== undefined) return;
				try {
					placeholderRef.current = { element: placeholder, visibility: placeholder.style.visibility };
					placeholder.style.visibility = "hidden";
				} catch (ignored) {
					placeholderRef.current = null;
				}
			}

			function restorePlaceholder() {
				var record = placeholderRef.current;
				if (record === null || record === undefined) return;
				placeholderRef.current = null;
				try {
					record.element.style.visibility = record.visibility;
				} catch (ignored) {
					/* element is gone with its composer */
				}
			}

			/** Measure the real placeholder against the overlay anchor. */
			function measure(ghost) {
				try {
					var anchor = ghost.closest("[data-composer-overlay]");
					var card = ghost.closest("[data-composer-card]");
					if (anchor === null || anchor === undefined || card === null || card === undefined) return null;
					var placeholder = card.querySelector("[data-composer-placeholder]");
					if (placeholder === null || placeholder === undefined) return null;
					var anchorRect = anchor.getBoundingClientRect();
					var placeholderRect = placeholder.getBoundingClientRect();
					if (!(placeholderRect.width > 0) || !(placeholderRect.height > 0)) return null;
					var styles = typeof window !== "undefined" && typeof window.getComputedStyle === "function" ? window.getComputedStyle(placeholder) : null;
					if (styles === null || styles === undefined) return null;
					return {
						placeholder: placeholder,
						position: {
							left: placeholderRect.left - anchorRect.left,
							top: placeholderRect.top - anchorRect.top,
							width: placeholderRect.width,
							height: placeholderRect.height,
							fontFamily: styles.fontFamily,
							fontSize: styles.fontSize,
							fontWeight: styles.fontWeight,
							lineHeight: styles.lineHeight,
							letterSpacing: styles.letterSpacing,
							direction: styles.direction,
							textAlign: styles.textAlign
						}
					};
				} catch (error) {
					warn("cannot measure the composer placeholder", error);
					return null;
				}
			}

			function syncPosition() {
				var ghost = ghostRef.current;
				if (ghost === null || ghost === undefined) return false;
				var measured = measure(ghost);
				if (measured === null) return false;
				hidePlaceholder(measured.placeholder);
				setPosition(function (previous) {
					return samePosition(previous, measured.position) ? previous : measured.position;
				});
				return true;
			}

			/* Measure before paint; hide the real placeholder in the same commit. */
			React.useLayoutEffect(function () {
				if (visible !== true) {
					restorePlaceholder();
					if (position !== null) setPosition(null);
					return;
				}
				if (syncPosition() !== true) restorePlaceholder();
			}, [visible, suggestion, draft, phase]);

			/* Re-measure while the card can change size (growth, hero switch, resize). */
			React.useEffect(function () {
				if (visible !== true) return undefined;
				var ghost = ghostRef.current;
				if (ghost === null || ghost === undefined) return undefined;
				var card = ghost.closest("[data-composer-card]");
				var placeholder = card !== null && card !== undefined ? card.querySelector("[data-composer-placeholder]") : null;
				var grow = placeholder !== null && placeholder !== undefined ? placeholder.parentElement : null;
				var scroll = card !== null && card !== undefined ? card.querySelector("[data-input-scroll]") : null;
				var reposition = function () {
					try {
						syncPosition();
					} catch (error) {
						warn("cannot re-position the ghost", error);
					}
				};
				var observer = null;
				var ObserverCtor = null;
				if (typeof ResizeObserver !== "undefined" && typeof ResizeObserver === "function") ObserverCtor = ResizeObserver;
				else if (typeof window !== "undefined" && window !== null && typeof window.ResizeObserver === "function") ObserverCtor = window.ResizeObserver;
				if (ObserverCtor !== null) {
					try {
						observer = new ObserverCtor(reposition);
						if (card !== null && card !== undefined) observer.observe(card);
						if (grow !== null && grow !== undefined) observer.observe(grow);
					} catch (ignored) {
						observer = null;
					}
				}
				var onWindowResize = reposition;
				if (typeof window !== "undefined" && window !== null && typeof window.addEventListener === "function") {
					window.addEventListener("resize", onWindowResize);
				}
				var onScroll = reposition;
				if (scroll !== null && scroll !== undefined && typeof scroll.addEventListener === "function") {
					scroll.addEventListener("scroll", onScroll, { passive: true });
				}
				return function () {
					if (observer !== null && typeof observer.disconnect === "function") {
						try {
							observer.disconnect();
						} catch (ignored) {
							/* detached */
						}
					}
					if (typeof window !== "undefined" && window !== null && typeof window.removeEventListener === "function") {
						window.removeEventListener("resize", onWindowResize);
					}
					if (scroll !== null && scroll !== undefined && typeof scroll.removeEventListener === "function") {
						scroll.removeEventListener("scroll", onScroll);
					}
				};
			}, [visible, suggestion]);

			/* ------------------------------------------------- accept / dismiss */

			function getCard() {
				var ghost = ghostRef.current;
				if (ghost === null || ghost === undefined) return null;
				try {
					return ghost.closest("[data-composer-card]");
				} catch (ignored) {
					return null;
				}
			}

			function focusComposer(card) {
				try {
					if (typeof document === "undefined" || document === null) return;
					var target = card !== null && card !== undefined ? card.querySelector("[data-composer-input]") : document.querySelector("[data-composer-input]");
					if (target !== null && target !== undefined && typeof target.focus === "function") target.focus({ preventScroll: true });
				} catch (ignored) {
					/* focus is best-effort */
				}
			}

			function accept() {
				var text = suggestion;
				if (!isNonEmptyString(text)) return;
				var card = getCard();
				cancelCycle();
				restorePlaceholder();
				setSuggestion(null);
				setDismissed(true);
				setPosition(null);
				try {
					if (inputActions !== undefined && inputActions !== null && typeof inputActions.setDraft === "function") {
						inputActions.setDraft(text);
					}
				} catch (error) {
					warn("setDraft failed", error);
				}
				focusComposer(card);
			}

			function dismiss() {
				cancelCycle();
				restorePlaceholder();
				setSuggestion(null);
				setDismissed(true);
				setPosition(null);
			}

			/* Latest callbacks for the window listener (registered once). */
			liveStateRef.current = {
				visible: visible,
				empty: empty,
				accept: accept,
				dismiss: dismiss,
				getCard: getCard
			};

			/* ------------------------------------------------- keyboard support */

			React.useEffect(function () {
				if (typeof window === "undefined" || window === null || typeof window.addEventListener !== "function") return undefined;

				function composerFocused(card) {
					try {
						if (typeof document === "undefined" || document === null) return false;
						if (card === null || card === undefined) return false;
						var editor = card.querySelector("[data-composer-input]");
						if (editor === null || editor === undefined) return false;
						var active = document.activeElement;
						if (active === editor) return true;
						return active !== null && active !== undefined && typeof editor.contains === "function" && editor.contains(active);
					} catch (ignored) {
						return false;
					}
				}

				function popupOpen(card) {
					try {
						return card.querySelector('[role="listbox"], [role="menu"], [role="dialog"]') !== null;
					} catch (ignored) {
						return false;
					}
				}

				function onKeyDown(event) {
					try {
						var state = liveStateRef.current;
						if (state === null || state === undefined || state.visible !== true) return;
						if (event === null || event === undefined) return;
						if (event.defaultPrevented === true) return;
						if (event.isComposing === true || event.keyCode === 229) return;
						if (event.key === "Escape") {
							var escapeCard = state.getCard();
							if (escapeCard !== null && popupOpen(escapeCard) === true) return;
							state.dismiss();
							return;
						}
						if (event.key !== "Tab") return;
						if (event.shiftKey === true || event.altKey === true || event.ctrlKey === true || event.metaKey === true) return;
						if (event.repeat === true) return;
						var card = state.getCard();
						if (composerFocused(card) !== true) return;
						if (popupOpen(card) === true) return;
						event.preventDefault();
						event.stopPropagation();
						state.accept();
					} catch (error) {
						warn("keyboard handling failed", error);
					}
				}

				/* Bubble phase on purpose: every editor/menu/dialog handler has
				 * already reported consumption through preventDefault by now, and the
				 * browser's default Tab focus move is still cancellable. */
				window.addEventListener("keydown", onKeyDown);
				return function () {
					window.removeEventListener("keydown", onKeyDown);
				};
			}, []);

			/* ----------------------------------------------------- plugin teardown */

			React.useEffect(function () {
				return function () {
					cancelCycle();
					restorePlaceholder();
					previousVisibleRef.current = false;
				};
			}, []);

			/* ------------------------------------------------------------ render */

			if (visible !== true) return null;

			var label = translate(t, "ghost.label");
			var tabLabel = translate(t, "hint.tab");
			var acceptHint = translate(t, "hint.accept");
			var text = suggestion;

			var ghostStyle = {
				position: "absolute",
				display: "flex",
				alignItems: "baseline",
				gap: "8px",
				boxSizing: "border-box",
				margin: 0,
				padding: 0,
				overflow: "hidden",
				whiteSpace: "nowrap",
				pointerEvents: "none",
				visibility: position === null ? "hidden" : "visible"
			};
			if (position !== null) {
				ghostStyle.left = position.left + "px";
				ghostStyle.top = position.top + "px";
				ghostStyle.width = position.width + "px";
				ghostStyle.fontFamily = position.fontFamily;
				ghostStyle.fontSize = position.fontSize;
				ghostStyle.fontWeight = position.fontWeight;
				ghostStyle.fontStyle = "italic";
				ghostStyle.lineHeight = position.lineHeight;
				ghostStyle.letterSpacing = position.letterSpacing;
				ghostStyle.direction = position.direction;
				ghostStyle.textAlign = position.textAlign;
			}

			function keepFocus(event) {
				/* Keep the editor focused: the card's own mousedown logic already
				 * exempts overlay targets, so nothing else would restore it. */
				event.preventDefault();
				event.stopPropagation();
			}

			function onGhostClick(event) {
				keepFocus(event);
				accept();
			}

			return React.createElement(
				"div",
				{
					ref: ghostRef,
					className: "dshnp-ghost",
					"data-next-prompt-ghost": "",
					role: "status",
					"aria-live": "polite",
					"aria-label": label,
					title: acceptHint,
					style: ghostStyle,
					onMouseDown: keepFocus
				},
				React.createElement(
					"span",
					{
						key: "text",
						className: "dshnp-text",
						"data-next-prompt-text": "",
						title: text + " — " + acceptHint,
						onMouseDown: keepFocus,
						onClick: onGhostClick
					},
					text
				),
				React.createElement(
					"kbd",
					{
						key: "hint",
						className: "dshnp-kbd",
						"data-next-prompt-hint": "",
						"aria-hidden": "true",
						title: acceptHint,
						onMouseDown: keepFocus,
						onClick: onGhostClick
					},
					tabLabel
				)
			);
		}

		/* ------------------------------------------------------------ plugin */

		/**
		 * Client plugin body: one style tag, the locale dictionaries, and one
		 * session-scoped entry of the composer overlay slot.
		 *
		 * @param ctx - client Cordis context (`slots` and `locale` injected).
		 */
		function apply(ctx) {
			if (ctx === null || ctx === undefined || typeof ctx !== "object") return;

			try {
				ctx.effect(function () {
					return mountStyle();
				}, PLUGIN_ID + ": ghost styles");
			} catch (error) {
				warn("cannot install the ghost styles", error);
			}

			var hasLocale = ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.register === "function";
			if (hasLocale) {
				try {
					ctx.effect(function () {
						return ctx.locale.register(NS, DICTS);
					}, PLUGIN_ID + ": ghost dictionaries");
				} catch (error) {
					warn("cannot register the ghost dictionaries", error);
				}
			}

			try {
				var slots = ctx.slots;
				if (slots === null || slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
					warn("slots service unavailable; composer overlay disabled");
					return;
				}
				slots.inject(SLOT, function () {
					var registration = { name: SLOT, id: SLOT_ID, order: 50 };
					if (hasLocale) registration.locale = NS;
					return slots.register(registration, NextPromptGhost);
				});
			} catch (error) {
				warn("composer overlay slot unavailable", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		return module.exports;
	}
});
