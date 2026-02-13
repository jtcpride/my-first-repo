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
  const WINDOWS_RESERVED = new Set([
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9"
  ]);

  let value = (name || "").replace(/[\x00-\x1f\x7f]/g, " ");
  value = value.replace(/[\\/:*?"<>|]+/g, "-");
  value = value.replace(/\s+/g, " ").trim();
  value = value.replace(/^\.+/, "").replace(/\.+$/, "");
  value = value.replace(/[. ]+$/g, "");

  if (!value) {
    value = "chat";
  }

  if (WINDOWS_RESERVED.has(value.toUpperCase())) {
    value = `${value}-file`;
  }

  return value.slice(0, 80) || "chat";
}

function buildExportFilename(baseName, extension) {
  const base = sanitizeFileName(baseName);
  return `${base}.${extension}`;
}

async function downloadWithFilenameFallback(options, fallbackExtension) {
  try {
    return await chrome.downloads.download(options);
  } catch (error) {
    const message = error?.message || "";
    if (!message.includes("Invalid filename")) {
      throw error;
    }

    const fallbackName = `chat-${Date.now()}.${fallbackExtension}`;
    try {
      return await chrome.downloads.download({
        ...options,
        filename: fallbackName
      });
    } catch (secondError) {
      const fallbackFlatName = `chat-${Date.now()}.${fallbackExtension}`;
      return chrome.downloads.download({
        ...options,
        filename: fallbackFlatName
      });
    }
  }
}

function chatToMarkdown(chat) {
  const lines = [`# ${chat.title}`, "", `- URL: ${chat.url}`, `- ExportedAt: ${chat.exportedAt}`, ""];

  const toBlockquote = (text) =>
    (text || "")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

  for (const message of chat.messages) {
    if (message.role === "user") {
      lines.push(`> [!question] User`);
      if (typeof message.turnIndex === "number") {
        lines.push(`> - turnIndex: ${message.turnIndex}`);
      }
      if (message.timestamp) {
        lines.push(`> - timestamp: ${message.timestamp}`);
      }
      lines.push(">", toBlockquote(message.text), "");
      continue;
    }

    lines.push("## assistant");
    if (typeof message.turnIndex === "number") {
      lines.push(`- turnIndex: ${message.turnIndex}`);
    }
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

function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function textToDataUrl(text, mimeType) {
  const bytes = new TextEncoder().encode(text);
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function bytesToDataUrl(bytes, mimeType) {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function createZipBytes(files) {
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

  return concatUint8Arrays([...localChunks, ...centralChunks, endRecord]);
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

function normalizeSingleFormat(format) {
  return format === "md" ? "md" : "json";
}

function normalizeBulkOptions(options) {
  return {
    format: normalizeSingleFormat(options?.format),
    compress: options?.compress !== false
  };
}

async function exportCurrentChat(format) {
  const singleFormat = normalizeSingleFormat(format);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ensurePerplexityTab(tab);

  const result = await sendToTab(tab.id, { type: "EXPORT_CURRENT_CHAT" });
  if (!result?.ok) {
    const base = result?.error?.message || "現在のチャット取得に失敗しました。";
    const diagnostics = result?.error?.diagnostics ? ` diagnostics=${JSON.stringify(result.error.diagnostics)}` : "";
    throw new Error(`${base}${diagnostics}`);
  }

  const chat = result.data;
  const isMd = singleFormat === "md";
  const content = isMd ? chatToMarkdown(chat) : JSON.stringify(chat, null, 2);
  const mimeType = isMd ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8";
  const extension = isMd ? "md" : "json";

  await downloadWithFilenameFallback(
    {
      url: textToDataUrl(content, mimeType),
      filename: buildExportFilename(chat.title, extension),
      saveAs: false,
      conflictAction: "uniquify"
    },
    extension
  );

  const label = isMd ? "Markdown" : "JSON";
  sendResult({ ok: true, mode: "single", format: singleFormat, message: `現在のチャットを ${label} でダウンロードしました。` });
}

async function exportBulkChats(options) {
  const bulkOptions = normalizeBulkOptions(options);
  const isMd = bulkOptions.format === "md";
  const extension = isMd ? "md" : "json";
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
    const content = isMd ? chatToMarkdown(chat) : JSON.stringify(chat, null, 2);
    files.push({
      name: `${base}.${extension}`,
      content
    });
  }

  const summary = {
    exportedAt: new Date().toISOString(),
    format: bulkOptions.format,
    compressed: bulkOptions.compress,
    successCount: chats.length,
    failureCount: failures.length,
    failures
  };

  if (bulkOptions.compress) {
    files.push({
      name: "summary.json",
      content: JSON.stringify(summary, null, 2)
    });

    const zipBytes = createZipBytes(files);
    const zipDataUrl = bytesToDataUrl(zipBytes, "application/zip");

    await downloadWithFilenameFallback(
      {
        url: zipDataUrl,
        filename: `perplexity-bulk-${bulkOptions.format}-${Date.now()}.zip`,
        saveAs: false,
        conflictAction: "uniquify"
      },
      "zip"
    );
  } else {
    const batchId = Date.now();
    for (const file of files) {
      await downloadWithFilenameFallback(
        {
          url: textToDataUrl(file.content, isMd ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8"),
          filename: `perplexity-${bulkOptions.format}-${batchId}-${file.name}`,
          saveAs: false,
          conflictAction: "uniquify"
        },
        extension
      );
    }

    await downloadWithFilenameFallback(
      {
        url: textToDataUrl(JSON.stringify(summary, null, 2), "application/json;charset=utf-8"),
        filename: `perplexity-${bulkOptions.format}-${batchId}-summary.json`,
        saveAs: false,
        conflictAction: "uniquify"
      },
      "json"
    );
  }

  sendResult({
    ok: true,
    mode: "bulk",
    format: bulkOptions.format,
    compressed: bulkOptions.compress,
    message: `完了: ${chats.length}件成功 / ${failures.length}件失敗 (${bulkOptions.format.toUpperCase()}${
      bulkOptions.compress ? " / ZIP" : " / 非圧縮"
    })`,
    successCount: chats.length,
    failureCount: failures.length
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_EXPORT_CURRENT") {
    exportCurrentChat(message?.format)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResult({ ok: false, message: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "START_BULK_EXPORT") {
    exportBulkChats({ format: message?.format, compress: message?.compress })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResult({ ok: false, message: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  return false;
});
