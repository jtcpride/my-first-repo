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

function normalizeRole(role) {
  const lower = (role || "").toLowerCase();
  if (lower.includes("assistant") || lower === "ai") {
    return "assistant";
  }
  if (lower.includes("user") || lower.includes("human")) {
    return "user";
  }
  return "unknown";
}

function detectRoleFromAttributes(node) {
  const testId = (node.getAttribute("data-testid") || "").toLowerCase();
  const roleAttr = (node.getAttribute("data-message-author-role") || node.getAttribute("data-author") || "").toLowerCase();
  const combined = `${testId} ${roleAttr}`;

  if (combined.includes("assistant") || combined.includes("answer") || combined.includes("response")) {
    return "assistant";
  }
  if (combined.includes("user") || combined.includes("query") || combined.includes("prompt") || combined.includes("question")) {
    return "user";
  }
  return "unknown";
}

function guessRoleFromNode(node) {
  const roleAttr = node.getAttribute("data-role") || node.getAttribute("aria-label") || "";
  const className = node.className || "";
  const lower = `${roleAttr} ${className}`.toLowerCase();

  if (lower.includes("assistant") || lower.includes("ai") || lower.includes("response") || lower.includes("answer")) {
    return "assistant";
  }

  if (lower.includes("user") || lower.includes("prompt") || lower.includes("question") || lower.includes("query")) {
    return "user";
  }

  const answerDescendant = node.querySelector(
    "[data-testid*='answer'], [data-testid*='assistant'], [data-testid*='response'], [aria-label*='assistant' i]"
  );
  if (answerDescendant) {
    return "assistant";
  }

  const queryDescendant = node.querySelector(
    "[data-testid*='query'], [data-testid*='question'], [data-testid*='prompt'], [aria-label*='user' i]"
  );
  if (queryDescendant) {
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

function getAllRoots() {
  const roots = [];
  const nodeQueue = [];
  const docQueue = [document];
  const seenDocs = new Set();

  while (docQueue.length) {
    const doc = docQueue.shift();
    if (!doc || seenDocs.has(doc)) {
      continue;
    }
    seenDocs.add(doc);

    roots.push(doc);
    if (doc.documentElement) {
      nodeQueue.push(doc.documentElement);
    }

    const frames = doc.querySelectorAll ? Array.from(doc.querySelectorAll("iframe, frame")) : [];
    for (const frame of frames) {
      try {
        const frameDoc = frame.contentDocument;
        if (frameDoc) {
          docQueue.push(frameDoc);
        }
      } catch (error) {
        // cross-origin frameはアクセス不可
      }
    }
  }

  while (nodeQueue.length) {
    const node = nodeQueue.shift();
    if (!node) {
      continue;
    }
    if (node.shadowRoot) {
      roots.push(node.shadowRoot);
      nodeQueue.push(node.shadowRoot);
    }

    const children = node.children || [];
    for (const child of children) {
      nodeQueue.push(child);
    }
  }

  return roots;
}

function queryAllAcrossRoots(selector) {
  const matches = [];
  const seen = new Set();

  for (const root of getAllRoots()) {
    const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
    for (const node of nodes) {
      if (seen.has(node)) {
        continue;
      }
      seen.add(node);
      matches.push(node);
    }
  }

  return matches;
}

function sortNodesByDomOrder(nodes) {
  return [...nodes].sort((a, b) => {
    if (a === b) {
      return 0;
    }
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  });
}

function collectBySelectors(selectors) {
  const map = new Map();
  for (const selector of selectors) {
    for (const node of queryAllAcrossRoots(selector)) {
      map.set(node, node);
    }
  }
  return sortNodesByDomOrder(Array.from(map.values()));
}

function findMessageNodes() {
  const wrapperSelectors = [
    "article[data-testid*='message']",
    "div[data-testid*='message']",
    "[data-message-author-role]",
    "[data-testid*='conversation'] [data-testid*='turn']",
    "[data-testid*='chat'] [data-testid*='turn']",
    "main article",
    "main [role='article']"
  ];

  for (const selector of wrapperSelectors) {
    const list = sortNodesByDomOrder(queryAllAcrossRoots(selector));
    if (list.length > 1) {
      return list;
    }
  }

  const querySelectors = [
    "[data-testid*='query']",
    "[data-testid*='question']",
    "[data-testid*='prompt']"
  ];
  const answerSelectors = [
    "[data-testid*='answer']",
    "[data-testid*='response']",
    "[data-testid*='assistant']"
  ];

  const queries = collectBySelectors(querySelectors);
  const answers = collectBySelectors(answerSelectors);
  if (queries.length && answers.length) {
    return sortNodesByDomOrder([...queries, ...answers]);
  }

  return [];
}

function extractLooseMessageBlocks() {
  const candidates = queryAllAcrossRoots("[class*='query'], [class*='answer'], [class*='message'], [data-testid]");
  const messages = [];
  const seen = new Set();

  for (const node of candidates) {
    const text = sanitizeText(node.innerText);
    if (!text || text.length < 10) {
      continue;
    }
    if (text.length > 10000) {
      continue;
    }

    const attrRole = detectRoleFromAttributes(node);
    const role = attrRole !== "unknown" ? attrRole : guessRoleFromNode(node);
    if (role === "unknown") {
      continue;
    }

    const key = `${role}:${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    messages.push({ role, text, timestamp: null });
  }

  return messages;
}

function extractAssistantCandidateBlocks() {
  const assistantNodes = collectBySelectors([
    "[data-testid*='answer']",
    "[data-testid*='response']",
    "[data-testid*='assistant']",
    "[class*='answer']",
    "[class*='response']",
    "[class*='assistant']",
    ".prose",
    "[class*='prose']",
    "[class*='markdown']",
    "main p"
  ]);

  const records = [];
  const seen = new Set();
  for (const node of assistantNodes) {
    const text = sanitizeText(node.innerText);
    if (!text || text.length < 20) {
      continue;
    }

    const attrRole = detectRoleFromAttributes(node);
    const role = attrRole === "unknown" ? "assistant" : attrRole;
    if (role !== "assistant") {
      continue;
    }

    const key = `${role}:${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    records.push({ role, text, timestamp: null });
  }

  return records;
}

function extractQueryAnswerBlocks() {
  const userNodes = collectBySelectors([
    "[data-testid*='query']",
    "[data-testid*='question']",
    "[data-testid*='prompt']"
  ]);
  const assistantNodes = collectBySelectors([
    "[data-testid*='answer']",
    "[data-testid*='response']",
    "[data-testid*='assistant']"
  ]);

  const records = [];
  for (const node of userNodes) {
    const text = sanitizeText(node.innerText);
    if (text) {
      records.push({ role: "user", text, timestamp: null, node });
    }
  }
  for (const node of assistantNodes) {
    const text = sanitizeText(node.innerText);
    if (text) {
      records.push({ role: "assistant", text, timestamp: null, node });
    }
  }

  const sorted = sortNodesByDomOrder(records.map((record) => record.node));
  const byNode = new Map(records.map((record) => [record.node, record]));
  const deduped = [];
  const seen = new Set();

  for (const node of sorted) {
    const record = byNode.get(node);
    if (!record) {
      continue;
    }
    const key = `${record.role}:${record.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ role: record.role, text: record.text, timestamp: null });
  }

  return deduped;
}

function extractMessagesFromDom() {
  const nodes = findMessageNodes();
  if (!nodes.length) {
    return [];
  }

  return nodes
    .map((node) => {
      const roleAttr = node.getAttribute("data-message-author-role") || node.getAttribute("data-author") || "";
      const attrRole = detectRoleFromAttributes(node);
      const normalizedRole = normalizeRole(roleAttr);
      const role = attrRole !== "unknown" ? attrRole : normalizedRole !== "unknown" ? normalizedRole : guessRoleFromNode(node);
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
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function extractStringFromContent(content) {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return sanitizeText(content);
  }

  if (Array.isArray(content)) {
    return sanitizeText(
      content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (part && typeof part.text === "string") {
            return part.text;
          }
          if (part && typeof part.content === "string") {
            return part.content;
          }
          return "";
        })
        .join("\n")
    );
  }

  if (typeof content === "object") {
    if (typeof content.text === "string") {
      return sanitizeText(content.text);
    }
    if (typeof content.content === "string") {
      return sanitizeText(content.content);
    }
    if (Array.isArray(content.content)) {
      return extractStringFromContent(content.content);
    }
    if (typeof content.markdown === "string") {
      return sanitizeText(content.markdown);
    }
    if (typeof content.value === "string") {
      return sanitizeText(content.value);
    }
  }

  return "";
}

function walkJson(node, visit, seen) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (seen.has(node)) {
    return;
  }
  seen.add(node);

  visit(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      walkJson(item, visit, seen);
    }
    return;
  }

  for (const value of Object.values(node)) {
    walkJson(value, visit, seen);
  }
}

function extractMessagesFromJsonState() {
  const scripts = Array.from(document.querySelectorAll("script#__NEXT_DATA__, script[type='application/json']"));
  if (!scripts.length) {
    return [];
  }

  const messages = [];

  for (const script of scripts) {
    const parsed = parseJsonSafely(script.textContent || "");
    if (!parsed) {
      continue;
    }

    const seen = new Set();
    walkJson(
      parsed,
      (obj) => {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          return;
        }

        const roleValue = obj.role || obj.author || obj.message_role || obj.speaker;
        const role = normalizeRole(roleValue);

        if (role !== "unknown") {
          const text = extractStringFromContent(obj.content || obj.text || obj.body || obj.message || obj.answer || obj.query);
          if (text) {
            const timestamp = obj.created_at || obj.updated_at || obj.timestamp || null;
            messages.push({ role, text, timestamp });
          }
          return;
        }

        const userText = extractStringFromContent(obj.query || obj.question || obj.prompt || obj.user_message || obj.user);
        const assistantText = extractStringFromContent(
          obj.answer || obj.response || obj.output || obj.final_answer || obj.assistant_message || obj.assistant
        );
        if (userText) {
          messages.push({ role: "user", text: userText, timestamp: obj.created_at || obj.timestamp || null });
        }
        if (assistantText) {
          messages.push({ role: "assistant", text: assistantText, timestamp: obj.updated_at || obj.timestamp || null });
        }
      },
      seen
    );
  }

  const deduped = [];
  const seenKeys = new Set();

  for (const message of messages) {
    const key = `${message.role}:${message.text}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    deduped.push(message);
  }

  return deduped;
}

function normalizeForCompare(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function cleanMessages(messages) {
  const normalized = messages
    .map((message) => ({
      ...message,
      text: sanitizeText(message.text),
      _norm: normalizeForCompare(message.text)
    }))
    .filter((message) => message.text.length > 0);

  const exactDeduped = [];
  const seen = new Set();
  for (const message of normalized) {
    const key = `${message.role}:${message._norm}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    exactDeduped.push(message);
  }

  const keep = new Array(exactDeduped.length).fill(true);
  for (let i = 0; i < exactDeduped.length; i += 1) {
    for (let j = 0; j < exactDeduped.length; j += 1) {
      if (i === j) {
        continue;
      }
      const a = exactDeduped[i];
      const b = exactDeduped[j];
      if (a.role !== b.role) {
        continue;
      }
      if (a._norm.length < 30) {
        continue;
      }
      if (b._norm.length <= a._norm.length) {
        continue;
      }
      if (b._norm.includes(a._norm) && b._norm.length >= a._norm.length * 1.4) {
        keep[i] = false;
      }
    }
  }

  const cleaned = [];
  for (let i = 0; i < exactDeduped.length; i += 1) {
    if (!keep[i]) {
      continue;
    }
    const { _norm, ...message } = exactDeduped[i];
    cleaned.push(message);
  }
  return cleaned;
}

function splitByRole(messages) {
  const users = [];
  const assistants = [];
  for (const message of messages) {
    if (message.role === "user") {
      users.push(message);
    } else if (message.role === "assistant") {
      assistants.push(message);
    }
  }
  return { users, assistants };
}

function mergeByTurns(userMessages, assistantMessages) {
  const result = [];
  const max = Math.max(userMessages.length, assistantMessages.length);
  for (let i = 0; i < max; i += 1) {
    if (i < userMessages.length) {
      result.push(userMessages[i]);
    }
    if (i < assistantMessages.length) {
      result.push(assistantMessages[i]);
    }
  }
  return result;
}

function pickBestMessages() {
  const domMessages = cleanMessages(extractMessagesFromDom());
  const looseDomMessages = cleanMessages(extractLooseMessageBlocks());
  const queryAnswerMessages = cleanMessages(extractQueryAnswerBlocks());
  const assistantCandidateMessages = cleanMessages(extractAssistantCandidateBlocks());
  const jsonMessages = cleanMessages(extractMessagesFromJsonState());
  const candidates = [domMessages, looseDomMessages, queryAnswerMessages, assistantCandidateMessages, jsonMessages].filter(
    (list) => list.length > 0
  );

  const scoreMixed = (list) => {
    const hasUser = list.some((message) => message.role === "user");
    const hasAssistant = list.some((message) => message.role === "assistant");
    if (!(hasUser && hasAssistant)) {
      return -1;
    }
    const transitions = list.reduce((acc, message, index) => {
      if (index === 0) {
        return acc;
      }
      return acc + (list[index - 1].role !== message.role ? 1 : 0);
    }, 0);
    return list.length * 10 + transitions;
  };

  const mixedCandidates = candidates.filter((list) => scoreMixed(list) >= 0);
  if (mixedCandidates.length) {
    mixedCandidates.sort((a, b) => scoreMixed(b) - scoreMixed(a));
    return mixedCandidates[0];
  }

  const roleSplit = candidates.map((list) => ({ list, ...splitByRole(list) }));
  const userSource = [...roleSplit]
    .filter((item) => item.users.length > 0)
    .sort((a, b) => b.users.length - a.users.length)[0];
  const assistantSource = [...roleSplit]
    .filter((item) => item.assistants.length > 0)
    .sort((a, b) => b.assistants.length - a.assistants.length)[0];

  if (userSource && assistantSource) {
    return mergeByTurns(userSource.users, assistantSource.assistants);
  }

  return candidates.sort((a, b) => b.length - a.length)[0] || [];
}

function buildDiagnostics() {
  const selectors = [
    "article[data-testid*='message']",
    "div[data-testid*='message']",
    "[data-message-author-role]",
    "[data-testid*='query']",
    "[data-testid*='answer']",
    "main article",
    "main [role='article']"
  ];

  const counts = {};
  for (const selector of selectors) {
    counts[selector] = queryAllAcrossRoots(selector).length;
  }

  return {
    rootCount: getAllRoots().length,
    frameCount: document.querySelectorAll("iframe, frame").length,
    nextDataCount: document.querySelectorAll("script#__NEXT_DATA__").length,
    jsonScriptCount: document.querySelectorAll("script[type='application/json']").length,
    selectorCounts: counts
  };
}

function extractMessages() {
  const messages = pickBestMessages();

  if (!messages.length) {
    return {
      ok: false,
      error: {
        code: "NO_MESSAGES",
        message: "メッセージ要素が見つかりませんでした。PerplexityのUI変更の可能性があります。",
        url: window.location.href,
        diagnostics: buildDiagnostics()
      }
    };
  }

  const messagesWithTurnIndex = messages.map((message, index) => ({
    ...message,
    turnIndex: index + 1
  }));

  const title = sanitizeText(document.querySelector("h1")?.innerText) || "untitled-chat";
  const hasUser = messagesWithTurnIndex.some((message) => message.role === "user");
  const hasAssistant = messagesWithTurnIndex.some((message) => message.role === "assistant");

  const response = {
    ok: true,
    data: {
      title,
      url: window.location.href,
      exportedAt: new Date().toISOString(),
      messages: messagesWithTurnIndex
    }
  };

  if (!hasUser || !hasAssistant) {
    response.data.warning = !hasUser
      ? "userメッセージを抽出できませんでした。"
      : "assistantメッセージを抽出できませんでした。";
    response.data.diagnostics = buildDiagnostics();
  }

  return response;
}

function collectThreadUrls() {
  const links = queryAllAcrossRoots("a[href]");
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
