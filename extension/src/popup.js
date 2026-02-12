const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

document.getElementById("exportCurrent").addEventListener("click", async () => {
  setStatus("現在の対話をエクスポートしています...");
  const response = await chrome.runtime.sendMessage({ type: "START_EXPORT_CURRENT" });

  if (!response?.ok) {
    setStatus(`エラー: ${response?.error || "不明なエラー"}`);
  }
});

document.getElementById("bulkExport").addEventListener("click", async () => {
  setStatus("一括エクスポートを開始します...");
  const response = await chrome.runtime.sendMessage({ type: "START_BULK_EXPORT" });

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
