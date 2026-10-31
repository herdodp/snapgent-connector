// SPDX-License-Identifier: GPL-3.0-or-later
// providers/ptero.js - the Ptero (ptero.pro) provider.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let diag = () => {};
  let lockedEditor = null;

  const S = {
    list: "#chat-messages",
    user: ".chat-msg.user",
    assistant: ".chat-msg.assistant",
    editor: "#chat-input",
    send: "#chat-send-btn",
    thinking: ".chat-thinking",
    reply: ".chat-msg-text",
    errors: '[role="alert"],[class*="chat-error"],[class*="chat-notice"]',
  };

  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 60000,
    REASON_NOREPLY_MS: 120000,
    STABLE_MS: 10000,
    RESPONSE_TIMEOUT_MS: 300000,
  };
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const allItems = () => {
    const list = document.querySelector(S.list);
    return list ? [...list.querySelectorAll(`${S.user},${S.assistant}`)] : [];
  };
  const isAssistantItem = (item) => !!item && item.matches(S.assistant);
  const isUserItem = (item) => !!item && item.matches(S.user);
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const items = assistantItems();
    return items.length ? items[items.length - 1] : null;
  };
  const bodyOf = (item) => item && item.querySelector(S.reply);

  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = [".zs-chip", S.thinking, excludeSel].filter(Boolean).join(",");
    let text = "";
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches(skip)) return;
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    return text;
  }

  const itemText = (item) => textWithout(bodyOf(item) || item);
  const classifyText = (item, excludeSel) =>
    textWithout(bodyOf(item) || item, excludeSel);
  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();

  function getEditor() {
    if (visible(lockedEditor) && !lockedEditor.closest("#zs-root")) return lockedEditor;
    const editor = document.querySelector(S.editor);
    return editor && !editor.closest("#zs-root") && visible(editor) ? editor : null;
  }
  const editorText = () => {
    const editor = getEditor();
    return editor ? editor.value || "" : "";
  };
  const composerFrame = () => document.querySelector("#chat-input-area");
  const barAnchor = () => {
    const area = composerFrame();
    return area && visible(area) ? area : null;
  };

  const ids = new WeakMap();
  let nextId = 0;
  function lastAssistantId() {
    const item = lastAssistant();
    if (!item) return null;
    const id = item.dataset.msgId || item.dataset.messageId;
    if (id) return id;
    if (!ids.has(item)) ids.set(item, ++nextId);
    return ids.get(item);
  }
  const streamText = (item) => textWithout(bodyOf(item));
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;
  let sampledItem = null;
  let sampledLen = 0;
  let grewAt = 0;
  function sampleStream() {
    const item = lastAssistant();
    const length = streamLen(item);
    const now = Date.now();
    if (item !== sampledItem || length < sampledLen - 400) {
      sampledItem = item;
      sampledLen = length;
      grewAt = now;
    } else if (length > sampledLen) {
      sampledLen = length;
      grewAt = now;
    }
  }
  const stopButton = () => {
    const button = document.querySelector(S.send);
    return button && button.classList.contains("is-stop") && visible(button) ? button : null;
  };
  const sendButton = () => {
    const button = document.querySelector(S.send);
    return button && !button.classList.contains("is-stop") && visible(button) ? button : null;
  };
  const isHardGenerating = () => !!stopButton();
  const isGenerating = () => {
    sampleStream();
    return isHardGenerating() || (sampledLen > 0 && Date.now() - grewAt < timings.GEN_IDLE_MS);
  };
  const isBusyNow = isGenerating;

  function snapshot() {
    const item = lastAssistant();
    const thinking = item && item.querySelector(S.thinking);
    return { th: thinking ? textWithout(thinking).length : 0, rp: streamLen(item) };
  }
  function readAssistant() {
    const item = lastAssistant();
    const thinking = item && item.querySelector(S.thinking);
    return {
      present: !!item,
      reply: item ? streamText(item).trim() : "",
      thinking: thinking ? textWithout(thinking).trim() : "",
      item,
    };
  }
  async function waitFor(predicate, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) return true;
      await sleep(120);
    }
    return false;
  }

  function setInputLock(on) {
    const editor = on ? getEditor() : (lockedEditor || getEditor());
    lockedEditor = on ? editor : null;
    if (editor) {
      if (on) editor.setAttribute("readonly", "");
      else editor.removeAttribute("readonly");
    }
  }
  function setTextareaValue(editor, text) {
    editor.removeAttribute("readonly");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(editor, text);
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }));
    if (lockedEditor === editor) editor.setAttribute("readonly", "");
  }
  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Ptero input box not found");
    const beforeUsers = userCount();
    setTextareaValue(editor, text);
    const ready = await waitFor(() => {
      const button = sendButton();
      return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }, 10000);
    const button = sendButton();
    if (!ready || !button || button.disabled ||
        button.getAttribute("aria-disabled") === "true") {
      throw new Error("Ptero send button did not become available");
    }
    button.click();
    await waitFor(() =>
      editorText().trim() === "" || userCount() > beforeUsers || isHardGenerating(),
    5000);
  }
  function stopGeneration() {
    const button = stopButton();
    if (button) button.click();
  }
  const enforceComposer = () => ({ ready: !!getEditor() });
  async function ensureComposerReady(reason) {
    const ready = !!getEditor();
    diag("mode_ready", { reason, provider: "ptero", ready });
    return { ready };
  }

  function scanError() {
    const list = document.querySelector(S.list);
    for (const el of document.querySelectorAll(S.errors)) {
      if (!visible(el) || el.closest("#zs-root") || (list && list.contains(el))) continue;
      const text = (el.innerText || el.textContent || "").trim();
      if (text.length > 8 && text.length < 600) return text.slice(0, 240);
    }
    return getEditor() ? null : "The Ptero input box is not available.";
  }
  const isTooLongMsg = (text) => /conversation.{0,30}(too long|limit)|context.{0,20}limit/i.test(text);
  const isBusyMsg = (text) => /try again later|temporarily unavailable|rate limit|too many requests/i.test(text);
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;
  const conversationKey = () => {
    const items = allItems();
    const first = items[0];
    if (!first) return "";
    const firstAssistant = items.find(isAssistantItem);
    const id = (firstAssistant && (firstAssistant.dataset.msgId || firstAssistant.dataset.messageId)) ||
      first.dataset.msgId || first.dataset.messageId;
    if (id) return `ptero:${id}`;
    if (!ids.has(first)) ids.set(first, ++nextId);
    return `ptero:${ids.get(first)}`;
  };

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const editor = getEditor();
      if (!editor || event.target !== editor || !editorText().trim()) return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest(S.send) : null;
      if (!button || !getEditor()) return;
      if (button.classList.contains("is-stop")) {
        handlers.onNativeStop();
        return;
      }
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  const commandShape = /"(?:command|tool)"\s*:\s*"|###\s*(?:lua|mcp_tool)/i;
  function findToolBlockSpot(item) {
    const body = bodyOf(item);
    if (!body) return null;
    let found = null;
    body.querySelectorAll("pre,code,p,li").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide")) return;
      const text = (el.textContent || "").trim();
      if (text && commandShape.test(text)) {
        el.classList.add("zs-tool-hide");
        found = found || { parent: el.parentElement, ref: el };
      }
    });
    return found;
  }

  return {
    id: "ptero",
    displayName: "Ptero",
    sendRetryLimit: 1,
    supportsVision: false,
    timings,
    chipAtItemLevel: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages: () => false,
    clearAttachments: () => {},
    conversationKey, installSendHooks, findToolBlockSpot,
  };
})();
