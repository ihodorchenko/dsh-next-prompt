/**
 * Hand-written lazy-CJS test bundle for the fake-loader harness.
 *
 * It mirrors every structural element of the shipped bundle (loader wrapper,
 * `require("react")`, style injection, locale registration, deferred slot
 * registration through ctx.slots.inject, exports.apply/exports.inject) so the
 * harness can prove the format and the registration path without the real app.
 */
window.__ModuleLoader__.load({
	id: "dsh-next-prompt-harness-test",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		var PLUGIN_ID = "dsh-next-prompt-harness-test";
		var NS = "next-prompt-harness-test";
		var SLOT = "conversation.input.overlay";
		var CSS = ".tnp-harness-test{color:var(--dsw-alias-label-caption,#888);font-style:italic}";
		var DICTS = {
			en: { ghost: "Suggested next prompt", hint: "Tab" },
			zh: { ghost: "建议的下一条提示", hint: "Tab" },
			ru: { ghost: "Предлагаемый следующий запрос", hint: "Tab" }
		};

		function mountStyle() {
			if (typeof document === "undefined") return function () {};
			var style = document.createElement("style");
			style.dataset.plugin = PLUGIN_ID;
			style.dataset.pluginCss = PLUGIN_ID + "/test.css";
			style.textContent = CSS;
			document.head.appendChild(style);
			return function () {
				if (style.parentNode) style.parentNode.removeChild(style);
			};
		}

		function TestGhost(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			var useInput = typeof props.useInput === "function" ? props.useInput : null;
			var useSession = typeof props.useSession === "function" ? props.useSession : null;
			var state = React.useState(false);
			var enabled = state[0];
			var setEnabled = state[1];
			var input = useInput ? useInput(function (snapshot) { return snapshot; }) : null;
			var session = useSession ? useSession(function (snapshot) { return snapshot; }) : null;
			React.useEffect(function () {
				setEnabled(true);
			}, []);
			if (!enabled) return null;
			return React.createElement(
				"div",
				{ "data-test-ghost": "", className: "tnp-harness-test" },
				t("ghost"),
				"|",
				String(props.sessionId),
				"|",
				input && typeof input.draft === "string" ? input.draft : "",
				"|",
				session ? String(session.running) : "no-session"
			);
		}

		function apply(ctx) {
			ctx.effect(function () {
				return mountStyle();
			}, PLUGIN_ID + ": styles");
			ctx.effect(function () {
				return ctx.locale.register(NS, DICTS);
			}, PLUGIN_ID + ": dictionaries");
			try {
				ctx.slots.inject(SLOT, function () {
					return ctx.slots.register({
						name: SLOT,
						id: PLUGIN_ID,
						order: 50,
						locale: NS,
						inject: function (sessionId) {
							return { sessionId: sessionId };
						}
					}, TestGhost);
				});
			} catch (error) {
				console.warn("[" + PLUGIN_ID + "] overlay slot unavailable", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		exports.PLUGIN_ID = PLUGIN_ID;
		exports.DICTS = DICTS;
		return module.exports;
	}
});
