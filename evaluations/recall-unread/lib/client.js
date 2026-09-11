window.__ModuleLoader__.load({ id: "dsh-recall-local", factory: (require) => {
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

// src/client.ts
var client_exports = {};
__export(client_exports, {
  MESSAGE: () => MESSAGE,
  RecallStrip: () => RecallStrip,
  apply: () => apply,
  entryId: () => entryId,
  entryOrder: () => entryOrder,
  inject: () => inject,
  isRecallable: () => isRecallable,
  name: () => name,
  previewOf: () => previewOf,
  selectRecallItems: () => selectRecallItems,
  slot: () => slot,
  textOf: () => textOf
});
module.exports = __toCommonJS(client_exports);

// src/actions.ts
var MESSAGE = {
  recalledOne: "Unread message recalled.",
  recalledMany: (count) => `${String(count)} unread messages recalled.`,
  claimed: "Already picked up by the model \u2014 nothing to recall.",
  closed: "The turn stopped accepting steering messages.",
  failed: (preview) => `Could not recall \u201C${shorten(preview)}\u201D.`,
  failedMany: (failed) => `${String(failed)} of the unread messages could not be recalled.`
};
function shorten(preview, limit = 40) {
  const chars = Array.from(preview);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}\u2026` : preview;
}
function previewOf(content) {
  const parts = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type !== "image" && block.type !== "file") parts.push(`[${block.type}]`);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function textOf(content) {
  if (!content.every((block) => block.type === "text")) return null;
  return content.map((block) => block.type === "text" ? block.text : "").join("").trim();
}
function isRecallable(row) {
  if (row.placement !== "steering") return false;
  const text = textOf(row.content);
  return text !== null && text !== "";
}
function selectRecallItems(snapshot) {
  return snapshot.queue.filter(isRecallable).map((row) => ({ id: String(row.id), preview: previewOf(row.content) }));
}
function createRecallActions(init) {
  return {
    recall: (itemId) => init.conversation.updateQueue(itemId, { kind: "remove" }),
    notify: (level, text) => {
      init.conversation.input.for(init.scope).notify(level, text);
    }
  };
}
function classifyRecallError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("queue-item-not-found")) return { kind: "claimed" };
  if (message.includes("steer-unavailable")) return { kind: "closed" };
  return { kind: "failed", error };
}
async function recallMany(items, recall) {
  let recalled = 0;
  let claimed = 0;
  let closed = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await recall(item.id);
      recalled += 1;
    } catch (error) {
      const outcome = classifyRecallError(error);
      if (outcome.kind === "claimed") claimed += 1;
      else if (outcome.kind === "closed") closed += 1;
      else failed += 1;
    }
  }
  if (recalled === 0 && claimed === 0 && closed === 0 && failed === 0) return null;
  if (failed > 0) return { level: "error", text: MESSAGE.failedMany(failed) };
  if (recalled > 0) return { level: "info", text: recalled === 1 ? MESSAGE.recalledOne : MESSAGE.recalledMany(recalled) };
  if (claimed > 0) return { level: "info", text: MESSAGE.claimed };
  return { level: "info", text: MESSAGE.closed };
}

// src/strip.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var slot = "conversation.input.dock";
function RecallStrip({ useSession, recall, notify }) {
  const items = useSession(selectRecallItems);
  const [rows, setRows] = (0, import_react.useState)({});
  const [batchBusy, setBatchBusy] = (0, import_react.useState)(false);
  const [feedback, setFeedback] = (0, import_react.useState)(null);
  const [announcement, setAnnouncement] = (0, import_react.useState)("");
  const report = (0, import_react.useCallback)(
    (next) => {
      setFeedback(next);
      setAnnouncement(next.text);
      notify(next.level, next.text);
    },
    [notify]
  );
  const onRecallOne = (0, import_react.useCallback)(
    async (item) => {
      setRows((current) => ({ ...current, [item.id]: "recalling" }));
      setFeedback(null);
      try {
        await recall(item.id);
        setRows((current) => ({ ...current, [item.id]: "recalled" }));
        report({ level: "info", text: MESSAGE.recalledOne });
      } catch (error) {
        setRows((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        const outcome = classifyRecallError(error);
        if (outcome.kind === "claimed") report({ level: "info", text: MESSAGE.claimed });
        else if (outcome.kind === "closed") report({ level: "info", text: MESSAGE.closed });
        else report({ level: "error", text: MESSAGE.failed(item.preview) });
      }
    },
    [recall, report]
  );
  const onRecallAll = (0, import_react.useCallback)(async () => {
    setBatchBusy(true);
    setFeedback(null);
    setRows((current) => {
      const next = { ...current };
      for (const item of items) next[item.id] = "recalling";
      return next;
    });
    const result = await recallMany(items, recall);
    setBatchBusy(false);
    setRows((current) => {
      const next = {};
      for (const [id, state] of Object.entries(current)) if (state !== "recalling") next[id] = state;
      return next;
    });
    if (result === null) return;
    report(result);
  }, [items, recall, report]);
  const count = items.length;
  const listId = "dsh-recall-local-list";
  const pending = batchBusy || Object.values(rows).some((state) => state === "recalling");
  const header = (0, import_react.useMemo)(() => {
    if (feedback !== null) return feedback.text;
    return count === 1 ? "1 unread message" : `${String(count)} unread messages`;
  }, [count, feedback]);
  if (count === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { "data-dsh-recall-local": "", style: stripStyle, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { "data-dsh-recall-local-card": "", style: cardStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: headerRowStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": "true", children: "\u21A9" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { id: `${listId}-label`, style: labelStyle, children: header }),
      count > 1 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => void onRecallAll(), disabled: pending, style: buttonStyle(pending), children: "Recall all" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { id: listId, "aria-labelledby": `${listId}-label`, style: listStyle, children: items.map((item) => {
      const state = rows[item.id] ?? "idle";
      const disabled = pending || state !== "idle";
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { "data-recall-item": item.id, style: rowStyle, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { title: item.preview, style: previewStyle, children: item.preview }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: state === "recalled" ? recalledStyle : idleLabelStyle, children: state === "recalled" ? "Recalled" : "" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            "aria-label": `Recall ${shorten(item.preview, 120)}`,
            onClick: () => void onRecallOne(item),
            disabled,
            style: buttonStyle(disabled),
            children: state === "recalling" ? "Recalling\u2026" : "Recall"
          }
        )
      ] }, item.id);
    }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "status", "aria-live": "polite", "aria-atomic": "true", style: visuallyHidden, children: announcement })
  ] }) });
}
var stripStyle = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  width: "calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))",
  maxWidth: "calc(var(--dsh-composer-card-max-width, 100%) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))",
  margin: "0 auto calc(0px - var(--dsh-composer-stack-gap, 6px) - 3px)",
  padding: "0 var(--dsh-composer-dock-inset, 8px)",
  flex: "none",
  minWidth: 0
};
var cardStyle = {
  boxSizing: "border-box",
  width: "100%",
  margin: "0 auto",
  padding: "6px 8px",
  border: "1px solid var(--dsw-alias-border-l1, currentColor)",
  borderRadius: "8px",
  background: "var(--dsw-alias-bg-layer-1, transparent)",
  color: "var(--dsw-alias-label-secondary, inherit)",
  fontSize: "12px",
  lineHeight: "18px"
};
var headerRowStyle = { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 };
var labelStyle = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};
var rowStyle = {
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  minWidth: 0
};
var previewStyle = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};
var listStyle = {
  boxSizing: "border-box",
  listStyle: "none",
  margin: 0,
  padding: 0,
  maxHeight: "180px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "4px"
};
var idleLabelStyle = { flex: "0 0 auto" };
var recalledStyle = { flex: "0 0 auto", color: "var(--dsw-alias-label-tertiary, inherit)" };
var visuallyHidden = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0
};
function buttonStyle(disabled) {
  return {
    flex: "0 0 auto",
    padding: "2px 8px",
    border: "1px solid var(--dsw-alias-border-l1, currentColor)",
    borderRadius: "6px",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1
  };
}

// src/install.ts
var slot2 = "conversation.input.dock";
var entryId = "recall-unread";
var entryOrder = 10;
function install(ctx) {
  ctx.slots.inject(
    slot2,
    () => ctx.slots.register(
      {
        name: slot2,
        id: entryId,
        order: entryOrder,
        inject: (sessionId) => {
          const session = ctx.sessions.scope(sessionId);
          if (session === void 0) throw new Error(`recall-local: session "${String(sessionId)}" resolved no scope`);
          const conversation = session.get("conversation");
          if (conversation === void 0) throw new Error("recall-local: conversation service unavailable");
          return createRecallActions({ conversation, scope: session });
        }
      },
      RecallStrip
    )
  );
}

// src/client.ts
var name = "recall-local";
var inject = ["slots", "sessions"];
function apply(ctx) {
  install(ctx);
}
return module.exports;
} });
