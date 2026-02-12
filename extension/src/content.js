const THREAD_PATH_PATTERNS = [/\/search\//, /\/thread\//, /\/c\//];

function matchesThreadPath(urlString) {
  try {
    const url = new URL(urlString, window.location.origin);
    return THREAD_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname));
  } catch (error) {
    return false;
  }
}

function sanitizeText(value) {
  return (value || "").replace(/\u00a0/g, " ").trim();
}

function guessRoleFromNode(node) {
  const roleAttr = node.getAttribute("data-role") || node.getAttribute("aria-label") || "";
  const className = node.className || "";
  const lower = `${roleAttr} ${className}`.toLowerCase();

  if (lower.includes("assistant") || lower.includes("ai") || lower.includes("response")) {
    return "assistant";
  }

  if (lower.includes("user") || lower.includes("prompt") || lower.includes("question")) {
    return "user";
  }

  const userBadge = node.querySelector("[data-testid*='user'], [aria-label*='user' i]");
  if (userBadge) {
    return "user";
  }

  const assistantBadge = node.querySelector("[data-testid*='assistant'], [aria-label*='assistant' i]");
  if (assistantBadge) {
    return "assistant";
  }

  return "unknown";
}

function findMessageNodes() {
  const selectors = [
    "article[data-testid*='message']",
    "div[data-testid*='message']",
    "[data-message-author-role]",
    "main article",
    "main [role='article']"
  ];

  for (const selector of selectors) {
    const list = Array.from(document.querySelectorAll(selector));
    if (list.length > 1) {
      return list;
    }
  }

  return [];
}

function extractMessages() {
  const nodes = findMessageNodes();

  if (!nodes.length) {
    return {
      ok: false,
      error: {
        code: "NO_MESSAGES",
        message: "メッセージ要素が見つかりませんでした。PerplexityのUI変更の可能性があります。",
        url: window.location.href
      }
    };
  }

  const messages = nodes
    .map((node) => {
      const role = node.getAttribute("data-message-author-role") || guessRoleFromNode(node);
      const text = sanitizeText(node.innerText);
      const timeNode = node.querySelector("time");
      const timestamp = timeNode?.dateTime || timeNode?.getAttribute("datetime") || null;
      return {
        role,
        text,
        timestamp
      };
    })
    .filter((message) => message.text.length > 0);

  if (!messages.length) {
    return {
      ok: false,
      error: {
        code: "EMPTY_MESSAGES",
        message: "メッセージ候補は見つかりましたが本文を抽出できませんでした。",
        url: window.location.href
      }
    };
  }

  const title = sanitizeText(document.querySelector("h1")?.innerText) || "untitled-chat";

  return {
    ok: true,
    data: {
      title,
      url: window.location.href,
      exportedAt: new Date().toISOString(),
      messages
    }
  };
}

function collectThreadUrls() {
  const links = Array.from(document.querySelectorAll("a[href]"));
  const unique = new Set();

  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) {
      continue;
    }

    const absolute = new URL(href, window.location.origin).toString();
    if (matchesThreadPath(absolute)) {
      unique.add(absolute);
    }
  }

  return {
    ok: true,
    data: {
      sourceUrl: window.location.href,
      urls: Array.from(unique)
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXPORT_CURRENT_CHAT") {
    sendResponse(extractMessages());
    return true;
  }

  if (message?.type === "COLLECT_THREAD_URLS") {
    sendResponse(collectThreadUrls());
    return true;
  }

  return false;
});
