"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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

// packages/agent-core/src/session/restore.ts
var restore_exports = {};
__export(restore_exports, {
  rebuildThread: () => rebuildThread
});
module.exports = __toCommonJS(restore_exports);
function rebuildThread(events) {
  const byId = /* @__PURE__ */ new Map();
  const order = [];
  const messageIdByToolCall = /* @__PURE__ */ new Map();
  const toolCallBy = /* @__PURE__ */ new Map();
  let title = "";
  let workspaceRoot = void 0;
  let usageTokens = 0;
  let seq = 0;
  const turnIds = [];
  const turnUserMessage = /* @__PURE__ */ new Map();
  const closedTurns = /* @__PURE__ */ new Set();
  const pendingApprovals = /* @__PURE__ */ new Set();
  const checkpointTurns = [];
  const ensure = (id, role, createdAt) => {
    let m = byId.get(id);
    if (!m) {
      m = { id, role, createdAt, parts: [] };
      byId.set(id, m);
      order.push(id);
    }
    return m;
  };
  for (const e of events) {
    seq = Math.max(seq, e.seq);
    switch (e.type) {
      case "threadCreated":
        title = e.payload.title;
        break;
      case "threadTitleChanged":
        title = e.payload.title;
        break;
      case "threadMoved":
        workspaceRoot = e.payload.workspaceRoot;
        break;
      case "turnStarted": {
        turnIds.push(e.payload.turnId);
        turnUserMessage.set(e.payload.turnId, e.payload.userMessageId);
        const m = ensure(e.payload.userMessageId, "user", e.ts);
        const text = e.payload.userText ?? "";
        if (text.length > 0 && !m.parts.some((p) => p.kind === "text" && p.text === text)) {
          m.parts.push({ kind: "text", text });
        }
        break;
      }
      case "textDelta": {
        const m = ensure(e.payload.messageId, "assistant", e.ts);
        const last = m.parts[m.parts.length - 1];
        if (last && last.kind === "text") last.text += e.payload.text;
        else m.parts.push({ kind: "text", text: e.payload.text });
        break;
      }
      case "toolCallComplete": {
        const m = ensure(e.payload.messageId, "assistant", e.ts);
        messageIdByToolCall.set(e.payload.toolCallId, e.payload.messageId);
        toolCallBy.set(e.payload.toolCallId, { name: e.payload.name });
        if (!m.parts.some((p) => p.kind === "tool-call" && p.toolCallId === e.payload.toolCallId)) {
          m.parts.push({
            kind: "tool-call",
            toolCallId: e.payload.toolCallId,
            name: e.payload.name,
            args: e.payload.args
          });
        }
        break;
      }
      case "observationAdded": {
        const messageId = messageIdByToolCall.get(e.payload.toolCallId);
        if (!messageId) break;
        const m = byId.get(messageId);
        if (m && !m.parts.some((p) => p.kind === "tool-result" && p.toolCallId === e.payload.toolCallId)) {
          const call = toolCallBy.get(e.payload.toolCallId);
          m.parts.push({
            kind: "tool-result",
            toolCallId: e.payload.toolCallId,
            content: e.payload.content ?? e.payload.preview,
            truncated: e.payload.truncated,
            originalChars: e.payload.originalChars
          });
        }
        break;
      }
      case "usageDelta":
        usageTokens += e.payload.inputTokens + e.payload.outputTokens;
        break;
      case "memoryCompressed": {
        const removed = new Set(e.payload.compressedMessageIds);
        const summaryMessage = {
          id: `restored_summary_${e.seq}`,
          role: "assistant",
          createdAt: e.ts,
          parts: [{ kind: "summary", text: e.payload.summary, summarizedRange: [1, e.payload.compressedMessageIds.length] }]
        };
        const firstIndex = order.findIndex((id) => removed.has(id));
        for (const id of removed) {
          byId.delete(id);
        }
        if (firstIndex >= 0) {
          order.splice(firstIndex, removed.size, summaryMessage.id);
        } else {
          order.unshift(summaryMessage.id);
        }
        byId.set(summaryMessage.id, summaryMessage);
        break;
      }
      case "approvalRequired":
        pendingApprovals.add(e.payload.approvalId);
        break;
      case "approvalResolved":
        pendingApprovals.delete(e.payload.approvalId);
        break;
      case "checkpointCreated":
        if (e.turnId) checkpointTurns.push(e.turnId);
        break;
      case "turnCompleted":
      case "turnCancelled": {
        const turnId = e.type === "turnCompleted" ? "" : e.payload.turnId;
        if (e.type === "turnCancelled") closedTurns.add(turnId);
        else {
          if (e.turnId) closedTurns.add(e.turnId);
        }
        break;
      }
      default:
        break;
    }
  }
  const interruptedTurnIds = turnIds.filter((t) => !closedTurns.has(t));
  return {
    threadId: events[0]?.threadId ?? "",
    title: title || "\u672A\u547D\u540D\u4F1A\u8BDD",
    ...workspaceRoot ? { workspaceRoot } : {},
    messages: order.map((id) => byId.get(id)).filter((m) => m !== void 0),
    turnIds,
    interruptedTurnIds,
    pendingApprovalIds: [...pendingApprovals],
    checkpointTurnIds: checkpointTurns,
    seq,
    usageTokens
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  rebuildThread
});
