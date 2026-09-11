window.__ModuleLoader__.load({ id: "dsh-session-status", factory(require) {
const module = { exports: {} };
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name,
  slot: () => slot
});
module.exports = __toCommonJS(client_exports);
var import_jsx_runtime = require("react/jsx-runtime");
var name = "session-status";
var inject = ["slots", "uiSession"];
var slot = "conversation.session.header.actions";
function selectStatus(snapshot) {
  if (snapshot.removed) return "removed";
  if (snapshot.openState === "error") return "unavailable";
  if (snapshot.openState !== "open") return "loading";
  return snapshot.running ? "running" : "idle";
}
function SessionStatus({ useSession }) {
  const status = useSession(selectStatus);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "span",
    {
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      "data-session-status": status,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4em",
        padding: "3px 6px",
        border: "1px solid var(--dsw-alias-border-l1, currentColor)",
        borderRadius: "6px",
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontSize: "12px",
        lineHeight: "18px",
        whiteSpace: "nowrap"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": "true", children: status === "running" ? "\u25CF" : "\u25CB" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          "Session: ",
          status
        ] })
      ]
    }
  );
}
function apply(ctx) {
  ctx.slots.inject(slot, () => ctx.slots.register({
    name: slot,
    id: "dsh-session-status",
    order: 100
  }, SessionStatus));
}
return module.exports;
} });
