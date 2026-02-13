const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

async function exportCurrent(format) {
  const label = format === "md" ? "Markdown" : "JSON";
  setStatus(`現在の対話を ${label} でエクスポートしています...`);
  const response = await chrome.runtime.sendMessage({ type: "START_EXPORT_CURRENT", format });

  if (!response?.ok) {
    setStatus(`エラー: ${response?.error || "不明なエラー"}`);
  }
}

document.getElementById("exportCurrentJson").addEventListener("click", async () => {
  await exportCurrent("json");
});

document.getElementById("exportCurrentMd").addEventListener("click", async () => {
  await exportCurrent("md");
});

document.getElementById("bulkExport").addEventListener("click", async () => {
  const format = document.getElementById("bulkFormat").value;
  const compress = document.getElementById("bulkCompress").checked;
  const label = format === "md" ? "MD" : "JSON";
  setStatus(`一括エクスポート開始: ${label} / ${compress ? "ZIP圧縮あり" : "圧縮なし"}`);
  const response = await chrome.runtime.sendMessage({ type: "START_BULK_EXPORT", format, compress });

  if (!response?.ok) {
    setStatus(`エラー: ${response?.error || "不明なエラー"}`);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "EXPORT_PROGRESS") {
    const payload = message.payload;

    if (payload.stage === "collect") {
      setStatus(payload.message);
      return;
    }

    if (payload.stage === "extract") {
      setStatus(`抽出中... ${payload.current}/${payload.total}\n${payload.url}`);
    }
  }

  if (message?.type === "EXPORT_RESULT") {
    const payload = message.payload;
    const marker = payload.ok ? "✅" : "❌";
    setStatus(`${marker} ${payload.message}`);
  }
});
