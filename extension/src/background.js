function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensurePerplexityTab(tab) {
  if (!tab?.url || !tab.url.includes("perplexity.ai")) {
    throw new Error("Perplexityページを開いたタブで実行してください。");
  }
}

function sendProgress(payload) {
  chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", payload }).catch(() => {
    // popupが閉じている場合は通知不要
  });
}

function sendResult(payload) {
  chrome.runtime.sendMessage({ type: "EXPORT_RESULT", payload }).catch(() => {
    // popupが閉じている場合は通知不要
  });
}

async function sendToTab(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  return response;
}

function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "chat";
}

function chatToMarkdown(chat) {
  const lines = [`# ${chat.title}`, "", `- URL: ${chat.url}`, `- ExportedAt: ${chat.exportedAt}`, ""];

  for (const message of chat.messages) {
    lines.push(`## ${message.role}`);
    if (message.timestamp) {
      lines.push(`- timestamp: ${message.timestamp}`);
    }
    lines.push("", message.text, "");
  }

  return lines.join("\n");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16LE(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32LE(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function createZipBlob(files) {
  const encoder = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);

    const localHeader = new Uint8Array([
      ...uint32LE(0x04034b50),
      ...uint16LE(20),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint32LE(crc),
      ...uint32LE(dataBytes.length),
      ...uint32LE(dataBytes.length),
      ...uint16LE(nameBytes.length),
      ...uint16LE(0)
    ]);

    localChunks.push(localHeader, nameBytes, dataBytes);

    const centralHeader = new Uint8Array([
      ...uint32LE(0x02014b50),
      ...uint16LE(20),
      ...uint16LE(20),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint32LE(crc),
      ...uint32LE(dataBytes.length),
      ...uint32LE(dataBytes.length),
      ...uint16LE(nameBytes.length),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint16LE(0),
      ...uint32LE(0),
      ...uint32LE(offset)
    ]);

    centralChunks.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const endRecord = new Uint8Array([
    ...uint32LE(0x06054b50),
    ...uint16LE(0),
    ...uint16LE(0),
    ...uint16LE(files.length),
    ...uint16LE(files.length),
    ...uint32LE(centralSize),
    ...uint32LE(offset),
    ...uint16LE(0)
  ]);

  return new Blob([...localChunks, ...centralChunks, endRecord], { type: "application/zip" });
}

async function extractFromUrl(url) {
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await sleep(2500);
    const result = await sendToTab(tab.id, { type: "EXPORT_CURRENT_CHAT" });

    if (!result?.ok) {
      throw new Error(result?.error?.message || "チャット抽出に失敗しました。");
    }

    return result.data;
  } finally {
    if (tab.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function exportCurrentChat() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ensurePerplexityTab(tab);

  const result = await sendToTab(tab.id, { type: "EXPORT_CURRENT_CHAT" });
  if (!result?.ok) {
    throw new Error(result?.error?.message || "現在のチャット取得に失敗しました。");
  }

  const chat = result.data;
  const fileBase = sanitizeFileName(chat.title);
  const jsonBlob = new Blob([JSON.stringify(chat, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(jsonBlob);

  await chrome.downloads.download({
    url,
    filename: `perplexity-export/${fileBase}.json`,
    saveAs: true
  });

  sendResult({ ok: true, mode: "single", message: "現在のチャットをダウンロードしました。" });
}

async function exportBulkChats() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ensurePerplexityTab(activeTab);

  sendProgress({ stage: "collect", message: "スレッド一覧を収集中..." });
  const collected = await sendToTab(activeTab.id, { type: "COLLECT_THREAD_URLS" });
  const urls = collected?.data?.urls || [];

  if (!urls.length) {
    throw new Error("スレッドURLを見つけられませんでした。履歴一覧ページを開いてから再実行してください。");
  }

  const chats = [];
  const failures = [];

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    sendProgress({ stage: "extract", current: i + 1, total: urls.length, url });

    try {
      const chat = await extractFromUrl(url);
      chats.push(chat);
    } catch (error) {
      failures.push({ url, reason: error.message });
    }
  }

  if (!chats.length) {
    throw new Error("すべてのスレッド抽出に失敗しました。ログイン状態やDOMセレクタを確認してください。");
  }

  const files = [];
  for (const chat of chats) {
    const base = sanitizeFileName(chat.title);
    files.push({
      name: `${base}.json`,
      content: JSON.stringify(chat, null, 2)
    });
    files.push({
      name: `${base}.md`,
      content: chatToMarkdown(chat)
    });
  }

  files.push({
    name: "summary.json",
    content: JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        successCount: chats.length,
        failureCount: failures.length,
        failures
      },
      null,
      2
    )
  });

  const zipBlob = createZipBlob(files);
  const zipUrl = URL.createObjectURL(zipBlob);

  await chrome.downloads.download({
    url: zipUrl,
    filename: `perplexity-export/perplexity-bulk-${Date.now()}.zip`,
    saveAs: true
  });

  sendResult({
    ok: true,
    mode: "bulk",
    message: `完了: ${chats.length}件成功 / ${failures.length}件失敗`,
    successCount: chats.length,
    failureCount: failures.length
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_EXPORT_CURRENT") {
    exportCurrentChat()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResult({ ok: false, message: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "START_BULK_EXPORT") {
    exportBulkChats()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResult({ ok: false, message: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  return false;
});
