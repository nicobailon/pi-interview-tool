(() => {
  const data = window.__INTERVIEW_DATA__ || {};
  const questions = Array.isArray(data.questions) ? data.questions : [];
  const sessionToken = data.sessionToken || "";
  const sessionId = data.sessionId || "";
  const cwd = data.cwd || "";
  const gitBranch = data.gitBranch || "";
  const timeout = typeof data.timeout === "number" ? data.timeout : 0;
  const askModels = Array.isArray(data.askModels)
    ? data.askModels.filter((model) => model && typeof model.value === "string" && typeof model.provider === "string")
    : [];
  const defaultAskModel = typeof data.defaultAskModel === "string" ? data.defaultAskModel : null;

  const titleEl = document.getElementById("form-title");
  const descriptionEl = document.getElementById("form-description");
  const containerEl = document.getElementById("questions-container");
  const formEl = document.getElementById("interview-form");
  
  const submitBtn = document.getElementById("submit-btn");
  const errorContainer = document.getElementById("error-container");
  const successOverlay = document.getElementById("success-overlay");
  const expiredOverlay = document.getElementById("expired-overlay");
  const closeTabBtn = document.getElementById("close-tab-btn");
  const countdownBadge = document.getElementById("countdown-badge");
  const countdownValue = countdownBadge?.querySelector(".countdown-value");
  const countdownRingProgress = countdownBadge?.querySelector(".countdown-ring-progress");
  const closeCountdown = document.getElementById("close-countdown");
  const stayBtn = document.getElementById("stay-btn");
  const queueToast = document.getElementById("queue-toast");
  const queueToastTitle = queueToast?.querySelector(".queue-toast-header span");
  const queueToastClose = queueToast?.querySelector(".queue-toast-close");
  const queueSessionSelect = document.getElementById("queue-session-select");
  const queueOpenBtn = document.getElementById("queue-open-btn");

  const MAX_SIZE = 5 * 1024 * 1024;
  const MAX_DIMENSION = 4096;
  const MAX_IMAGES = 12;
  const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

  const imageState = new Map();
  const imagePathState = new Map();
  const attachState = new Map();
  const attachPathState = new Map();
  const cameraCaptureState = {
    overlay: null,
    stream: null,
    requestId: 0,
    pendingFile: null,
    pendingUrl: null,
    opener: null,
    target: null,
    selectedDeviceId: "",
    startPending: false,
  };
  const optionKeyState = new Map();
  const choiceNoteState = new Map();
  const optionInsightState = {
    active: null,
    pinned: new Map(),
  };
  const nav = {
    questionIndex: 0,
    optionIndex: 0,
    inSubmitArea: false,
    cards: [],
  };

  const session = {
    storageKey: null,
    expired: false,
    countdownEndTime: 0,
    tickLoopRunning: false,
    ended: false,
    cancelSent: false,
    reloadIntent: false,
  };
  const timers = {
    save: null,
    countdown: null,
    countdownDisplay: null,
    expiration: null,
    heartbeat: null,
    queuePoll: null,
  };
  function closeWindow() {
    closeCameraCapture({ restoreFocus: false });
    if (window.glimpse && typeof window.glimpse.close === "function") {
      window.glimpse.close();
    } else {
      window.close();
    }
  }

  let completionPending = false;
  function showCloseFallback() {
    const note = successOverlay.querySelector("p");
    if (note) {
      note.textContent = "Responses submitted - you can close this page and return to the terminal.";
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (completionPending && !document.hidden) {
      showCloseFallback();
    }
  });

  let filePickerOpen = false;
  const CLOSE_DELAY = 10;
  const RING_CIRCUMFERENCE = 100.53;
  const RELOAD_INTENT_KEY = "pi-interview-reload-intent";
  const queueState = {
    dismissed: false,
    knownIds: new Set(),
  };
  const ASK_PROMPT_CHIPS = [
    { key: "explain", label: "Explain this", prompt: "Explain this better." },
    { key: "why", label: "Why this option?", prompt: "Why is this option like that?" },
    { key: "tradeoffs", label: "Tradeoffs", prompt: "What are the tradeoffs of this option?" },
    { key: "fail", label: "When would this fail?", prompt: "When would this option fail or be the wrong choice?" },
  ];

  function updateCountdownBadge(secondsLeft, totalSeconds) {
    if (!countdownBadge || !countdownValue || !countdownRingProgress) return;
    
    countdownValue.textContent = formatTime(secondsLeft);
    const progress = (totalSeconds - secondsLeft) / totalSeconds;
    countdownRingProgress.style.strokeDashoffset = RING_CIRCUMFERENCE * progress;
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return `${mins}:${secs.toString().padStart(2, "0")}`;
    }
    return String(secs);
  }

  function startCountdownDisplay() {
    if (!countdownBadge || timeout <= 0) return;

    const expandThreshold = 120;
    const urgentThreshold = 30;
    session.countdownEndTime = Date.now() + (timeout * 1000);

    countdownBadge.classList.remove("hidden");
    countdownBadge.classList.add("minimal");

    if (session.tickLoopRunning) return;
    session.tickLoopRunning = true;

    const tick = () => {
      const now = Date.now();
      const millisecondsLeft = session.countdownEndTime - now;
      const remaining = Math.max(0, Math.ceil(millisecondsLeft / 1000));

      updateCountdownBadge(remaining, timeout);

      if (remaining <= expandThreshold) {
        countdownBadge.classList.remove("minimal");
      }

      if (remaining <= urgentThreshold) {
        countdownBadge.classList.add("urgent");
      } else {
        countdownBadge.classList.remove("urgent");
      }

      if (remaining > 0 && !session.expired) {
        const untilNextSecond = millisecondsLeft - ((remaining - 1) * 1000);
        timers.countdownDisplay = setTimeout(tick, Math.max(16, Math.min(1000, untilNextSecond + 1)));
      } else {
        timers.countdownDisplay = null;
        session.tickLoopRunning = false;
      }
    };

    tick();
  }

  function scheduleExpirationCheck() {
    const check = () => {
      const remaining = session.countdownEndTime - Date.now();
      if (remaining > 0 && !session.expired) {
        timers.expiration = setTimeout(check, remaining);
        return;
      }
      timers.expiration = null;
      if (!session.expired) showSessionExpired();
    };

    if (timers.expiration) clearTimeout(timers.expiration);
    timers.expiration = setTimeout(check, Math.max(0, session.countdownEndTime - Date.now()));
  }

  function refreshCountdown() {
    if (session.expired || timeout <= 0) return;
    session.countdownEndTime = Date.now() + (timeout * 1000);
    countdownBadge?.classList.add("minimal");
    countdownBadge?.classList.remove("urgent");
  }

  function showSessionExpired() {
    if (session.expired) return;
    closeCameraCapture({ restoreFocus: false });
    session.expired = true;
    session.tickLoopRunning = false;
    if (timers.countdownDisplay) {
      clearTimeout(timers.countdownDisplay);
      timers.countdownDisplay = null;
    }

    submitBtn.disabled = true;
    countdownBadge?.classList.add("hidden");
    
    expiredOverlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      expiredOverlay.classList.add("visible");
      stayBtn.focus();
    });
    
    let closeIn = CLOSE_DELAY;
    if (closeCountdown) closeCountdown.textContent = closeIn;
    
    timers.countdown = setInterval(() => {
      closeIn--;
      if (closeCountdown) closeCountdown.textContent = closeIn;
      
      if (closeIn <= 0) {
        clearInterval(timers.countdown);
        cancelInterview("timeout").finally(() => closeWindow());
      }
    }, 1000);
  }

  function startHeartbeat() {
    if (timers.heartbeat) return;
    timers.heartbeat = setInterval(() => {
      fetch("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: sessionToken }),
      }).catch(() => {});
    }, 5000);
  }

  function stopHeartbeat() {
    if (timers.heartbeat) {
      clearInterval(timers.heartbeat);
      timers.heartbeat = null;
    }
  }

  function stopQueuePolling() {
    if (timers.queuePoll) {
      clearInterval(timers.queuePoll);
      timers.queuePoll = null;
    }
  }

  function formatRelativeTime(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  function truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    const head = Math.ceil((maxLength - 3) * 0.6);
    const tail = Math.floor((maxLength - 3) * 0.4);
    return `${text.slice(0, head)}...${text.slice(-tail)}`;
  }

  function formatSessionLabel(session) {
    const status = session.status === "active" ? "Active" : "Waiting";
    const branch = session.gitBranch ? ` (${session.gitBranch})` : "";
    const project = session.cwd ? truncateText(session.cwd + branch, 36) : "Unknown";
    const title = truncateText(session.title || "Interview", 32);
    const timeAgo = formatRelativeTime(session.startedAt);
    return `${status}: ${title} — ${project} · ${timeAgo}`;
  }

  function updateQueueToast(sessions) {
    if (!queueToast || !queueSessionSelect || !queueOpenBtn) return;
    const others = sessions.filter((s) => s.id !== sessionId);
    if (others.length === 0) {
      queueToast.classList.add("hidden");
      queueState.dismissed = false;
      queueState.knownIds.clear();
      return;
    }

    const newIds = others.filter((s) => !queueState.knownIds.has(s.id));
    others.forEach((s) => queueState.knownIds.add(s.id));
    if (newIds.length > 0) {
      queueState.dismissed = false;
    }

    if (queueState.dismissed) return;

    const currentSession = sessions.find((s) => s.id === sessionId);
    const sortedOthers = others.slice().sort((a, b) => b.startedAt - a.startedAt);
    const sorted = currentSession ? [currentSession, ...sortedOthers] : sortedOthers;
    const currentValue = queueSessionSelect.value;
    queueSessionSelect.innerHTML = "";
    sorted.forEach((session) => {
      const option = document.createElement("option");
      option.value = session.url;
      if (session.id === sessionId) {
        const branch = session.gitBranch ? ` (${session.gitBranch})` : "";
        const project = session.cwd ? truncateText(session.cwd + branch, 36) : "Unknown";
        const title = truncateText(session.title || "Interview", 32);
        const timeAgo = formatRelativeTime(session.startedAt);
        option.textContent = `Active (this tab): ${title} — ${project} · ${timeAgo}`;
        option.disabled = true;
      } else {
        option.textContent = formatSessionLabel(session);
      }
      queueSessionSelect.appendChild(option);
    });
    const selectedSession =
      (currentValue && sorted.find((s) => s.url === currentValue && s.id !== sessionId)) ||
      sorted.find((s) => s.id !== sessionId);
    if (selectedSession) {
      queueSessionSelect.value = selectedSession.url;
    }

    if (queueToastTitle) {
      queueToastTitle.textContent =
        others.length === 1 ? "Another interview started" : `${others.length} interviews waiting`;
    }

    const selectedOption = queueSessionSelect.options[queueSessionSelect.selectedIndex];
    queueOpenBtn.disabled = !queueSessionSelect.value || selectedOption?.disabled;
    queueToast.classList.remove("hidden");
  }

  async function pollQueueSessions() {
    try {
      const response = await fetch(`/sessions?session=${encodeURIComponent(sessionToken)}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data || !data.ok || !Array.isArray(data.sessions)) return;
      updateQueueToast(data.sessions);
    } catch (_err) {}
  }

  function startQueuePolling() {
    if (!queueToast || timers.queuePoll) return;
    pollQueueSessions();
    timers.queuePoll = setInterval(pollQueueSessions, 6000);
  }

  function markReloadIntent() {
    session.reloadIntent = true;
    try {
      sessionStorage.setItem(RELOAD_INTENT_KEY, "1");
      setTimeout(() => {
        sessionStorage.removeItem(RELOAD_INTENT_KEY);
      }, 2000);
    } catch (_err) {}
  }

  function clearReloadIntent() {
    session.reloadIntent = false;
    try {
      sessionStorage.removeItem(RELOAD_INTENT_KEY);
    } catch (_err) {}
  }

  function hasReloadIntent() {
    if (session.reloadIntent) return true;
    try {
      return sessionStorage.getItem(RELOAD_INTENT_KEY) === "1";
    } catch (_err) {
      return false;
    }
  }

  function sendCancelBeacon(reason) {
    closeCameraCapture({ restoreFocus: false });
    if (session.cancelSent || session.ended) return;
    session.cancelSent = true;
    const responses = collectResponses();
    const payload = JSON.stringify({ token: sessionToken, reason, responses });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon("/cancel", blob);
      return;
    }
    fetch("/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }

  async function cancelInterview(reason) {
    closeCameraCapture({ restoreFocus: false });
    if (session.ended) return;
    session.ended = true;
    session.cancelSent = true;
    stopHeartbeat();
    stopQueuePolling();
    const responses = collectResponses();
    try {
      await fetch("/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: sessionToken, reason, responses }),
      });
    } catch (_err) {}
  }

  function isNetworkError(err) {
    if (err instanceof TypeError) return true;
    if (err.name === "TypeError") return true;
    const msg = String(err.message || "").toLowerCase();
    return msg.includes("fetch") || msg.includes("network") || msg.includes("failed to fetch");
  }

  function escapeSelector(value) {
    if (window.CSS && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function setText(el, text) {
    if (!el) return;
    el.textContent = text || "";
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderLightMarkdown(text) {
    if (!text) return "";
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\n/g, "<br>");
    html = html.replace(/\s(\d+\.)\s/g, "<br>$1 ");
    return html;
  }

  function isMarkdownLang(lang) {
    if (typeof lang !== "string") return false;
    const normalized = lang.trim().toLowerCase();
    return normalized === "md" || normalized === "markdown";
  }

  function renderMarkdownPreviewFallback(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    const paragraph = [];
    let listType = null;
    let inFence = false;
    let fenceLang = "";
    let fenceLines = [];

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      html.push(`<p>${renderLightMarkdown(paragraph.join(" "))}</p>`);
      paragraph.length = 0;
    };

    const closeList = () => {
      if (!listType) return;
      html.push(listType === "ol" ? "</ol>" : "</ul>");
      listType = null;
    };

    for (const rawLine of lines) {
      const line = rawLine ?? "";

      if (inFence) {
        if (/^```/.test(line.trim())) {
          html.push(`<pre class="markdown-fence"><code${fenceLang ? ` data-lang="${escapeHtml(fenceLang)}"` : ""}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
          inFence = false;
          fenceLang = "";
          fenceLines = [];
        } else {
          fenceLines.push(line);
        }
        continue;
      }

      const fenceStart = line.match(/^```\s*([^\s`]*)\s*$/);
      if (fenceStart) {
        flushParagraph();
        closeList();
        inFence = true;
        fenceLang = fenceStart[1] || "";
        fenceLines = [];
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }

      const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        closeList();
        const level = headingMatch[1].length;
        html.push(`<h${level}>${renderLightMarkdown(headingMatch[2].trim())}</h${level}>`);
        continue;
      }

      const quoteMatch = line.match(/^>\s?(.*)$/);
      if (quoteMatch) {
        flushParagraph();
        closeList();
        html.push(`<blockquote><p>${renderLightMarkdown(quoteMatch[1])}</p></blockquote>`);
        continue;
      }

      const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
      if (orderedMatch) {
        flushParagraph();
        if (listType !== "ol") {
          closeList();
          html.push("<ol>");
          listType = "ol";
        }
        html.push(`<li>${renderLightMarkdown(orderedMatch[1])}</li>`);
        continue;
      }

      const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/);
      if (unorderedMatch) {
        flushParagraph();
        if (listType !== "ul") {
          closeList();
          html.push("<ul>");
          listType = "ul";
        }
        html.push(`<li>${renderLightMarkdown(unorderedMatch[1])}</li>`);
        continue;
      }

      closeList();
      paragraph.push(line.trim());
    }

    if (inFence) {
      html.push(`<pre class="markdown-fence"><code${fenceLang ? ` data-lang="${escapeHtml(fenceLang)}"` : ""}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
    }

    flushParagraph();
    closeList();
    return html.join("\n");
  }

  function getOptionLabel(option) {
    return typeof option === "string" ? option : option.label;
  }

  function normalizeRecommendationMatchText(value) {
    return value.normalize("NFC").trim();
  }

  function resolveRecommendedLabels(recommended, options) {
    if (!recommended || !Array.isArray(options)) return [];

    const labelsByNormalized = new Map();
    options.forEach((option) => {
      const label = getOptionLabel(option);
      const normalized = normalizeRecommendationMatchText(label);
      if (!normalized || labelsByNormalized.has(normalized)) return;
      labelsByNormalized.set(normalized, label);
    });

    const resolved = [];
    const candidates = Array.isArray(recommended) ? recommended : [recommended];
    candidates.forEach((candidate) => {
      if (typeof candidate !== "string") return;
      const match = labelsByNormalized.get(normalizeRecommendationMatchText(candidate));
      if (match && !resolved.includes(match)) {
        resolved.push(match);
      }
    });
    return resolved;
  }

  function isChoiceResponseValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) && typeof value.option === "string";
  }

  function normalizeChoiceResponseValue(value) {
    if (!isChoiceResponseValue(value)) return null;
    const option = value.option.trim();
    if (!option) return null;
    const note = typeof value.note === "string" ? value.note.trim() : "";
    return note ? { option, note } : { option };
  }

  function preserveChoiceAnswerValue(question, value, validLabels) {
    if (question.type === "single") {
      const choiceValue = normalizeChoiceResponseValue(value);
      if (!choiceValue || !validLabels.has(choiceValue.option)) return "";
      return choiceValue;
    }

    if (question.type === "multi") {
      if (!Array.isArray(value)) return [];
      return value
        .map((item) => normalizeChoiceResponseValue(item))
        .filter((item) => item && validLabels.has(item.option));
    }

    return value;
  }

  function getChoiceNotes(questionId) {
    return choiceNoteState.get(questionId) || new Map();
  }

  function getChoiceNote(questionId, optionLabel) {
    return getChoiceNotes(questionId).get(optionLabel) || "";
  }

  function setChoiceNote(questionId, optionLabel, note) {
    const normalizedNote = typeof note === "string" ? note.trim() : "";
    const existing = choiceNoteState.get(questionId) || new Map();
    if (!normalizedNote) {
      existing.delete(optionLabel);
      if (existing.size === 0) {
        choiceNoteState.delete(questionId);
        return;
      }
      choiceNoteState.set(questionId, existing);
      return;
    }
    existing.set(optionLabel, normalizedNote);
    choiceNoteState.set(questionId, existing);
  }

  function clearChoiceNotes(questionId) {
    choiceNoteState.delete(questionId);
  }

  function getSelectedOptionLabels(questionId) {
    return Array.from(
      formEl.querySelectorAll(`input[name="${escapeSelector(questionId)}"]:checked`)
    )
      .map((input) => input.value)
      .filter((value) => value && value !== "__other__");
  }

  function isRichOption(option) {
    return typeof option === "object" && option !== null && "label" in option;
  }

  function syncRecommendations(question, options) {
    if (!question.recommended) return;
    const resolvedRecommended = resolveRecommendedLabels(question.recommended, options);

    if (question.type === "single") {
      if (resolvedRecommended.length > 0) {
        question.recommended = resolvedRecommended[0];
        return;
      }
      delete question.recommended;
      delete question.conviction;
      return;
    }

    if (question.type !== "multi") {
      delete question.recommended;
      delete question.conviction;
      return;
    }

    if (resolvedRecommended.length === 0) {
      delete question.recommended;
      delete question.conviction;
      return;
    }
    question.recommended = resolvedRecommended;
  }

  function makeClientId(prefix = "id") {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function questionSupportsOptionInsights(question) {
    return (question.type === "single" || question.type === "multi") &&
      Array.isArray(question.options) &&
      question.options.length > 0;
  }

  function questionCanAskAboutOption(question) {
    return !!data.canGenerate && questionSupportsOptionInsights(question);
  }

  function normalizeOptionKeysFromData() {
    const raw = data.optionKeysByQuestion && typeof data.optionKeysByQuestion === "object"
      ? data.optionKeysByQuestion
      : {};

    questions.forEach((question) => {
      if (!questionSupportsOptionInsights(question)) return;
      const rawKeys = Array.isArray(raw[question.id]) ? raw[question.id] : [];
      const keys = rawKeys.length === question.options.length && rawKeys.every((key) => typeof key === "string" && key)
        ? [...rawKeys]
        : question.options.map(() => makeClientId(`opt-${question.id}`));
      optionKeyState.set(question.id, keys);
    });
  }

  function getOptionKeys(questionId) {
    return optionKeyState.get(questionId) || [];
  }

  function setOptionKeys(questionId, keys) {
    optionKeyState.set(questionId, Array.isArray(keys) ? [...keys] : []);
  }

  function getOptionIndexByKey(questionId, optionKey) {
    return getOptionKeys(questionId).indexOf(optionKey);
  }

  function getOptionTextByKey(questionId, optionKey) {
    const question = questions.find((q) => q.id === questionId);
    if (!question || !Array.isArray(question.options)) return "";
    const index = getOptionIndexByKey(questionId, optionKey);
    if (index < 0 || index >= question.options.length) return "";
    return getOptionLabel(question.options[index]);
  }

  function providerLabel(provider) {
    if (!provider) return "";
    if (provider === "openai") return "OpenAI";
    if (provider === "google") return "Google";
    if (provider === "anthropic") return "Anthropic";
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  function parseModelValue(modelValue) {
    if (typeof modelValue !== "string") return { provider: "", model: "" };
    const slashIndex = modelValue.indexOf("/");
    if (slashIndex <= 0 || slashIndex === modelValue.length - 1) {
      return { provider: "", model: modelValue };
    }
    return {
      provider: modelValue.slice(0, slashIndex),
      model: modelValue.slice(slashIndex + 1),
    };
  }

  function getModelsForProvider(provider) {
    return askModels.filter((model) => model.provider === provider);
  }

  function getFirstProvider() {
    return askModels[0]?.provider || "";
  }

  const ASK_DEPTH_OPTIONS = [
    { key: "quick", label: "Quick" },
    { key: "standard", label: "Standard" },
    { key: "deep", label: "Deep" },
  ];

  function createDefaultActiveInsight(questionId, optionKey) {
    const selectedModel = askModels.some((model) => model.value === defaultAskModel)
      ? defaultAskModel
      : (askModels[0]?.value || null);
    const parsed = parseModelValue(selectedModel);
    return {
      questionId,
      optionKey,
      prompt: "",
      selectedChip: null,
      loading: false,
      error: "",
      result: null,
      advancedOpen: false,
      selectedProvider: parsed.provider || getFirstProvider(),
      selectedModel,
      selectedDepth: "standard",
      savedInsightId: null,
      abortController: null,
    };
  }

  function getActiveInsight(questionId, optionKey) {
    const active = optionInsightState.active;
    return active && active.questionId === questionId && active.optionKey === optionKey
      ? active
      : null;
  }

  function getPinnedInsights(questionId, optionKey) {
    const questionInsights = optionInsightState.pinned.get(questionId) || [];
    return questionInsights.filter((insight) => insight.optionKey === optionKey);
  }

  function normalizeSavedOptionInsights(input) {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : makeClientId("insight"),
        questionId: typeof item.questionId === "string" ? item.questionId : "",
        optionKey: typeof item.optionKey === "string" ? item.optionKey : "",
        optionText: typeof item.optionText === "string" ? item.optionText : "",
        prompt: typeof item.prompt === "string" ? item.prompt : "",
        summary: typeof item.summary === "string" ? item.summary : "",
        bullets: Array.isArray(item.bullets)
          ? item.bullets.filter((bullet) => typeof bullet === "string" && bullet.trim()).map((bullet) => bullet.trim())
          : [],
        suggestedText: typeof item.suggestedText === "string" ? item.suggestedText : undefined,
        modelUsed: typeof item.modelUsed === "string" ? item.modelUsed : item.modelUsed === null ? null : undefined,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      }))
      .filter((item) => item.questionId && item.optionKey && item.summary);
  }

  function restoreSavedOptionInsights(input) {
    optionInsightState.pinned.clear();
    normalizeSavedOptionInsights(input).forEach((insight) => {
      const existing = optionInsightState.pinned.get(insight.questionId) || [];
      existing.push(insight);
      optionInsightState.pinned.set(insight.questionId, existing);
    });
  }

  function serializeSavedOptionInsights() {
    return Array.from(optionInsightState.pinned.values())
      .flat()
      .map((insight) => ({
        id: insight.id,
        questionId: insight.questionId,
        optionKey: insight.optionKey,
        optionText: insight.optionText,
        prompt: insight.prompt,
        summary: insight.summary,
        bullets: Array.isArray(insight.bullets) ? [...insight.bullets] : [],
        suggestedText: insight.suggestedText,
        modelUsed: insight.modelUsed ?? null,
        createdAt: insight.createdAt,
      }));
  }

  function removePinnedInsight(questionId, insightId) {
    const existing = optionInsightState.pinned.get(questionId) || [];
    const next = existing.filter((insight) => insight.id !== insightId);
    if (next.length > 0) {
      optionInsightState.pinned.set(questionId, next);
    } else {
      optionInsightState.pinned.delete(questionId);
    }
  }

  function pruneQuestionOptionInsights(questionId) {
    const validKeys = new Set(getOptionKeys(questionId));
    const existing = optionInsightState.pinned.get(questionId) || [];
    const next = existing.filter((insight) => validKeys.has(insight.optionKey));
    if (next.length > 0) {
      optionInsightState.pinned.set(questionId, next);
    } else {
      optionInsightState.pinned.delete(questionId);
    }

    const active = optionInsightState.active;
    if (!active || active.questionId !== questionId || validKeys.has(active.optionKey)) {
      return;
    }
    if (active.abortController) {
      active.abortController.abort();
    }
    optionInsightState.active = null;
  }

  function closeOptionInsightPanel(questionId, optionKey) {
    const active = optionInsightState.active;
    if (!active) return;
    if (questionId && active.questionId !== questionId) return;
    if (optionKey && active.optionKey !== optionKey) return;
    if (active.abortController) {
      active.abortController.abort();
    }
    optionInsightState.active = null;
  }

  function openOptionInsightPanel(question, optionKey) {
    if (!questionCanAskAboutOption(question)) return;
    const currentValue = getQuestionValue(question);
    const active = getActiveInsight(question.id, optionKey);
    if (active) {
      closeOptionInsightPanel(question.id, optionKey);
      replaceQuestionOptionList(question, currentValue, optionKey);
      return;
    }

    const previousActive = optionInsightState.active;
    if (previousActive?.abortController) {
      previousActive.abortController.abort();
    }
    if (previousActive && (previousActive.questionId !== question.id || previousActive.optionKey !== optionKey)) {
      const previousQuestion = questions.find((item) => item.id === previousActive.questionId);
      if (previousQuestion) {
        const previousValue = getQuestionValue(previousQuestion);
        optionInsightState.active = null;
        replaceQuestionOptionList(previousQuestion, previousValue, previousActive.optionKey);
      }
    }

    optionInsightState.active = createDefaultActiveInsight(question.id, optionKey);
    replaceQuestionOptionList(question, currentValue, optionKey, { focusComposer: true });
  }

  function getSelectedInsightModel(activeInsight) {
    if (!activeInsight) return null;
    return typeof activeInsight.selectedModel === "string" && activeInsight.selectedModel
      ? activeInsight.selectedModel
      : defaultAskModel;
  }

  function getInsightModelLabel(activeInsight) {
    const selectedModel = getSelectedInsightModel(activeInsight);
    if (!selectedModel) return "No model selected";
    const parsed = parseModelValue(selectedModel);
    return `${providerLabel(parsed.provider)} / ${parsed.model}`;
  }

  function applyQuestionValue(question, value) {
    populateQuestion(question, { [question.id]: value }, { preserveChoiceNotes: true });
    if (question.type === "multi") {
      updateDoneState(question.id);
    }
  }

  function replaceQuestionOptionList(question, preserveValue, focusOptionKey, options = {}) {
    const card = containerEl.querySelector(`.question-card[data-question-id="${escapeSelector(question.id)}"]`);
    const currentList = card?.querySelector('.option-list');
    const title = card?.querySelector('.question-title');
    if (!card || !currentList || !title) return;

    const nextList = createChoiceQuestionList(question, title, options);
    currentList.replaceWith(nextList);
    applyQuestionValue(question, preserveValue);

    if (nav.cards[nav.questionIndex] === card && !nav.inSubmitArea && focusOptionKey) {
      const optionIndex = getOptionIndexByKey(question.id, focusOptionKey);
      if (optionIndex >= 0) {
        nav.optionIndex = optionIndex;
        highlightOption(card, optionIndex, false);
      }
    }

    if (options.focusComposer) {
      requestAnimationFrame(() => {
        const composer = card.querySelector(`.option-insight-input[data-question-id="${escapeSelector(question.id)}"][data-option-key="${escapeSelector(focusOptionKey || "")}"]`);
        composer?.focus();
      });
    }
  }

  async function submitOptionInsight(question, optionKey) {
    const active = getActiveInsight(question.id, optionKey);
    if (!active) return;
    const prompt = active.prompt.trim();
    if (!prompt) {
      active.error = "Prompt is required";
      replaceQuestionOptionList(question, getQuestionValue(question), optionKey, { focusComposer: true });
      return;
    }

    if (active.loading) {
      active.abortController?.abort();
      return;
    }

    active.loading = true;
    active.error = "";
    active.result = null;
    active.savedInsightId = null;
    active.abortController = new AbortController();
    replaceQuestionOptionList(question, getQuestionValue(question), optionKey);

    try {
      const modelOverride = getSelectedInsightModel(active);
      const response = await fetch("/option-insight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: sessionToken,
          questionId: question.id,
          optionKey,
          prompt,
          model: modelOverride && modelOverride !== defaultAskModel ? modelOverride : null,
          depth: active.selectedDepth || "standard",
        }),
        signal: active.abortController.signal,
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || "Option insight failed");
      active.result = {
        summary: result.summary,
        bullets: Array.isArray(result.bullets) ? result.bullets : [],
        suggestedText: typeof result.suggestedText === "string" ? result.suggestedText : undefined,
        modelUsed: typeof result.modelUsed === "string" ? result.modelUsed : null,
      };
      active.error = "";
      const optionText = typeof result.optionText === "string" ? result.optionText : getOptionTextByKey(question.id, optionKey);
      saveActiveInsight(question, optionKey, optionText);
      refreshCountdown();
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        active.error = err instanceof Error ? err.message : "Option insight failed";
      }
    } finally {
      if (optionInsightState.active && optionInsightState.active.questionId === question.id && optionInsightState.active.optionKey === optionKey) {
        optionInsightState.active.loading = false;
        optionInsightState.active.abortController = null;
      }
      replaceQuestionOptionList(question, getQuestionValue(question), optionKey);
    }
  }

  function saveActiveInsight(question, optionKey, optionText) {
    const active = getActiveInsight(question.id, optionKey);
    if (!active || !active.result) return;
    const insightId = active.savedInsightId || makeClientId("insight");
    const questionInsights = optionInsightState.pinned.get(question.id) || [];
    const nextInsight = {
      id: insightId,
      questionId: question.id,
      optionKey,
      optionText,
      prompt: active.prompt.trim(),
      summary: active.result.summary,
      bullets: Array.isArray(active.result.bullets) ? [...active.result.bullets] : [],
      suggestedText: active.result.suggestedText,
      modelUsed: active.result.modelUsed ?? null,
      createdAt: new Date().toISOString(),
    };
    const existingIndex = questionInsights.findIndex((insight) => insight.id === insightId);
    if (existingIndex === -1) {
      questionInsights.push(nextInsight);
    } else {
      questionInsights[existingIndex] = nextInsight;
    }
    active.savedInsightId = insightId;
    optionInsightState.pinned.set(question.id, questionInsights);
    debounceSave();
  }

  function createPinnedInsightCard(question, optionKey, insight) {
    const card = document.createElement("div");
    card.className = "option-insight-pinned";

    const head = document.createElement("div");
    head.className = "option-insight-pinned-head";

    const prompt = document.createElement("div");
    prompt.className = "option-insight-pinned-prompt";
    prompt.textContent = insight.prompt;
    head.appendChild(prompt);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "option-insight-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removePinnedInsight(question.id, insight.id);
      debounceSave();
      replaceQuestionOptionList(question, getQuestionValue(question), optionKey);
    });
    head.appendChild(remove);
    card.appendChild(head);

    const summary = document.createElement("p");
    summary.className = "option-insight-summary pinned";
    summary.textContent = insight.summary;
    card.appendChild(summary);

    if (Array.isArray(insight.bullets) && insight.bullets.length > 0) {
      const list = document.createElement("ul");
      list.className = "option-insight-bullets";
      insight.bullets.forEach((bullet) => {
        const item = document.createElement("li");
        item.textContent = bullet;
        list.appendChild(item);
      });
      card.appendChild(list);
    }

    if (insight.suggestedText) {
      const suggestion = document.createElement("code");
      suggestion.className = "option-insight-suggested-text compact";
      suggestion.textContent = insight.suggestedText;
      card.appendChild(suggestion);
    }

    if (insight.modelUsed) {
      const meta = document.createElement("div");
      meta.className = "option-insight-meta";
      meta.textContent = insight.modelUsed;
      card.appendChild(meta);
    }

    return card;
  }

  function createOptionInsightPanel(question, optionKey) {
    const active = getActiveInsight(question.id, optionKey);
    if (!active) return null;

    const panel = document.createElement("div");
    panel.className = "option-insight-panel";
    panel.dataset.optionInsightFor = optionKey;

    const chips = document.createElement("div");
    chips.className = "option-insight-chips";
    ASK_PROMPT_CHIPS.forEach((chip) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option-insight-chip" + (active.selectedChip === chip.key ? " active" : "");
      btn.textContent = chip.label;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        active.selectedChip = chip.key;
        active.prompt = chip.prompt;
        active.error = "";
        replaceQuestionOptionList(question, getQuestionValue(question), optionKey, { focusComposer: true });
      });
      chips.appendChild(btn);
    });
    panel.appendChild(chips);

    const input = document.createElement("textarea");
    input.className = "option-insight-input";
    input.rows = 2;
    input.placeholder = "Ask why it works, where it fails, or how to rewrite it...";
    input.dataset.questionId = question.id;
    input.dataset.optionKey = optionKey;
    input.value = active.prompt;
    input.addEventListener("input", () => {
      active.prompt = input.value;
      active.selectedChip = null;
      active.error = "";
    });
    input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submitOptionInsight(question, optionKey);
      }
    });
    panel.appendChild(input);

    const metaRow = document.createElement("div");
    metaRow.className = "option-insight-meta-row";

    const modelBadge = document.createElement("button");
    modelBadge.type = "button";
    modelBadge.className = "option-insight-model-badge";
    const badgeLabel = document.createElement("span");
    badgeLabel.className = "badge-label";
    badgeLabel.textContent = "Model";
    const badgeValue = document.createElement("span");
    badgeValue.textContent = getInsightModelLabel(active);
    const badgeCaret = document.createElement("span");
    badgeCaret.className = "badge-caret";
    badgeCaret.textContent = active.advancedOpen ? "▾" : "▸";
    modelBadge.appendChild(badgeLabel);
    modelBadge.appendChild(badgeValue);
    modelBadge.appendChild(badgeCaret);
    modelBadge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      active.advancedOpen = !active.advancedOpen;
      replaceQuestionOptionList(question, getQuestionValue(question), optionKey);
    });
    metaRow.appendChild(modelBadge);

    panel.appendChild(metaRow);

    if (active.advancedOpen) {
      const advanced = document.createElement("div");
      advanced.className = "option-insight-advanced";

      const providers = [...new Set(askModels.map((model) => model.provider))];
      const providerRow = document.createElement("div");
      providerRow.className = "option-insight-provider-row";
      providers.forEach((provider) => {
        const btn = document.createElement("button");
        btn.type = "button";
        const isSelected = (active.selectedProvider || providers[0] || "") === provider;
        btn.className = "option-insight-provider-btn" + (isSelected ? " is-selected" : "");
        btn.textContent = providerLabel(provider);
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          active.selectedProvider = provider;
          const providerModels = getModelsForProvider(provider);
          active.selectedModel = providerModels[0]?.value || null;
          replaceQuestionOptionList(question, getQuestionValue(question), optionKey);
        });
        providerRow.appendChild(btn);
      });
      advanced.appendChild(providerRow);

      const providerModels = getModelsForProvider(active.selectedProvider);
      const modelRow = document.createElement("div");
      modelRow.className = "option-insight-model-row";
      providerModels.forEach((modelOption) => {
        const btn = document.createElement("button");
        btn.type = "button";
        const isSelected = active.selectedModel === modelOption.value;
        btn.className = "option-insight-model-btn" + (isSelected ? " is-selected" : "");
        btn.textContent = modelOption.label;
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          active.selectedModel = modelOption.value;
          replaceQuestionOptionList(question, getQuestionValue(question), optionKey);
        });
        modelRow.appendChild(btn);
      });
      advanced.appendChild(modelRow);

      const depthRow = document.createElement("div");
      depthRow.className = "option-insight-depth-row";
      ASK_DEPTH_OPTIONS.forEach((depth) => {
        const btn = document.createElement("button");
        btn.type = "button";
        const isSelected = active.selectedDepth === depth.key;
        btn.className = "option-insight-depth-btn" + (isSelected ? " is-selected" : "");
        btn.textContent = depth.label;
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          active.selectedDepth = depth.key;
          replaceQuestionOptionList(question, getQuestionValue(question), optionKey);
        });
        depthRow.appendChild(btn);
      });
      advanced.appendChild(depthRow);

      panel.appendChild(advanced);
    }

    const actions = document.createElement("div");
    actions.className = "option-insight-actions";

    const askButton = document.createElement("button");
    askButton.type = "button";
    askButton.className = "option-insight-submit" + (active.loading ? " loading" : "");
    askButton.textContent = active.loading ? "Cancel" : "Ask";
    askButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      submitOptionInsight(question, optionKey);
    });
    actions.appendChild(askButton);

    panel.appendChild(actions);

    if (active.loading && !active.result) {
      const loading = document.createElement("div");
      loading.className = "option-insight-loading";
      const spinner = document.createElement("span");
      spinner.className = "option-insight-spinner";
      spinner.textContent = "Thinking";
      loading.appendChild(spinner);
      const dots = document.createElement("span");
      dots.className = "option-insight-dots";
      dots.textContent = "...";
      loading.appendChild(dots);
      panel.appendChild(loading);
    }

    if (active.error) {
      const error = document.createElement("div");
      error.className = "option-insight-error";
      error.textContent = active.error;
      panel.appendChild(error);
    }

    if (active.result) {
      const result = document.createElement("div");
      result.className = "option-insight-result";

      const summary = document.createElement("p");
      summary.className = "option-insight-summary";
      summary.textContent = active.result.summary;
      result.appendChild(summary);

      if (Array.isArray(active.result.bullets) && active.result.bullets.length > 0) {
        const list = document.createElement("ul");
        list.className = "option-insight-bullets";
        active.result.bullets.forEach((bullet) => {
          const item = document.createElement("li");
          item.textContent = bullet;
          list.appendChild(item);
        });
        result.appendChild(list);
      }

      if (active.result.suggestedText) {
        const suggestionLabel = document.createElement("div");
        suggestionLabel.className = "option-insight-suggestion-label";
        suggestionLabel.textContent = "Suggested rewrite";
        result.appendChild(suggestionLabel);

        const suggestion = document.createElement("code");
        suggestion.className = "option-insight-suggested-text";
        suggestion.textContent = active.result.suggestedText;
        result.appendChild(suggestion);
      }

      if (active.result.modelUsed) {
        const meta = document.createElement("div");
        meta.className = "option-insight-meta";
        meta.textContent = active.result.modelUsed;
        result.appendChild(meta);
      }

      panel.appendChild(result);
    }

    return panel;
  }

  function createOptionNoteInput(question, optionLabel, isSelected) {
    if (!questionSupportsOptionInsights(question) || !isSelected) return null;

    const wrap = document.createElement("div");
    wrap.className = "option-note-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "option-note-input";
    input.placeholder = "Optional clarification...";
    input.dataset.questionId = question.id;
    input.dataset.optionLabel = optionLabel;
    input.value = getChoiceNote(question.id, optionLabel);
    input.addEventListener("input", () => {
      setChoiceNote(question.id, optionLabel, input.value);
      debounceSave();
    });
    wrap.appendChild(input);

    return wrap;
  }

  function createChoiceOptionRow(question, option, optionIndex, options = {}) {
    const optionLabel = getOptionLabel(option);
    const optionContent = isRichOption(option) ? option.content : null;
    const optionKey = getOptionKeys(question.id)[optionIndex] || null;
    const generatedSet = options.generatedKeys || new Set();
    const insightable = questionSupportsOptionInsights(question) && !!optionKey;
    const askable = questionCanAskAboutOption(question) && !!optionKey;
    const activeInsight = optionKey ? getActiveInsight(question.id, optionKey) : null;

    const row = document.createElement("div");
    row.className = "option-row";
    if (generatedSet.has(optionKey)) {
      row.classList.add("generated");
    }
    if (activeInsight) {
      row.classList.add("ask-open");
    }

    const main = document.createElement("div");
    main.className = "option-row-main";

    const item = document.createElement("div");
    item.className = "option-item";
    if (optionContent) {
      item.classList.add("has-code");
    }
    const input = document.createElement("input");
    input.type = question.type === "single" ? "radio" : "checkbox";
    input.name = question.id;
    input.value = optionLabel;
    input.id = `q-${question.id}-${optionIndex}`;

    input.addEventListener("change", () => {
      debounceSave();
      if (question.type === "multi") {
        updateDoneState(question.id);
      }
      replaceQuestionOptionList(question, getQuestionValue(question), optionKey);
    });

    const body = document.createElement("div");
    body.className = "option-item-body";

    const text = document.createElement("span");
    text.className = "option-item-label";
    text.id = `${input.id}-label`;
    text.textContent = optionLabel;
    input.setAttribute("aria-labelledby", text.id);

    const recommendedList = resolveRecommendedLabels(question.recommended, question.options || []);
    const shouldPreselect = recommendedList.length > 0 && question.conviction !== "slight";

    if (recommendedList.includes(optionLabel)) {
      const pill = document.createElement("span");
      pill.className = "recommended-pill";
      pill.textContent = "Recommended";
      text.appendChild(pill);
      if (shouldPreselect) {
        input.checked = true;
      }
    }

    body.appendChild(text);

    if (optionContent) {
      const contentBlockEl = renderContentBlock(optionContent);
      if (contentBlockEl) {
        body.appendChild(contentBlockEl);
      }
    }

    item.appendChild(input);
    item.appendChild(body);
    item.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target === input || event.target.closest("button, input, textarea, select, a")) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && item.contains(selection.anchorNode) && item.contains(selection.focusNode)) {
        return;
      }
      input.click();
    });

    main.appendChild(item);
    const selectedLabels = new Set(getSelectedOptionLabels(question.id));
    const noteInput = createOptionNoteInput(question, optionLabel, input.checked || selectedLabels.has(optionLabel));

    if (insightable && optionKey) {
      if (askable) {
        const askButton = document.createElement("button");
        askButton.type = "button";
        askButton.className = "option-ask-btn";
        askButton.textContent = activeInsight ? "Hide" : "Ask";
        askButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openOptionInsightPanel(question, optionKey);
        });
        main.appendChild(askButton);

        const panel = createOptionInsightPanel(question, optionKey);
        row.appendChild(main);
        if (noteInput) row.appendChild(noteInput);
        if (panel) row.appendChild(panel);
      } else {
        row.appendChild(main);
        if (noteInput) row.appendChild(noteInput);
      }

      const pinnedInsights = getPinnedInsights(question.id, optionKey)
        .filter((insight) => insight.id !== activeInsight?.savedInsightId);
      if (pinnedInsights.length > 0) {
        const pinnedWrap = document.createElement("div");
        pinnedWrap.className = "option-insight-pinned-list";
        pinnedInsights.forEach((insight) => {
          pinnedWrap.appendChild(createPinnedInsightCard(question, optionKey, insight));
        });
        row.appendChild(pinnedWrap);
      }

      return row;
    }

    row.appendChild(main);
    if (noteInput) row.appendChild(noteInput);
    return row;
  }

  function createChoiceQuestionList(question, title, options = {}) {
    const list = document.createElement("div");
    list.className = "option-list";
    list.setAttribute("role", question.type === "single" ? "radiogroup" : "group");
    list.setAttribute("aria-labelledby", title.id);

    const generatedKeys = new Set(options.generatedKeys || []);

    question.options.forEach((option, optionIndex) => {
      list.appendChild(createChoiceOptionRow(question, option, optionIndex, { generatedKeys }));
    });

    const generateMoreEl = createGenerateMoreUI(question, list);
    if (generateMoreEl) list.appendChild(generateMoreEl);

    const otherLabel = document.createElement("label");
    otherLabel.className = "option-item option-other";
    const otherCheck = document.createElement("input");
    otherCheck.type = question.type === "single" ? "radio" : "checkbox";
    otherCheck.name = question.id;
    otherCheck.value = "__other__";
    otherCheck.id = `q-${question.id}-other`;
    const otherInput = document.createElement("textarea");
    otherInput.className = "other-input";
    otherInput.placeholder = "Other...";
    otherInput.rows = 1;
    otherInput.dataset.questionId = question.id;
    const autoResizeOther = () => {
      otherInput.style.height = "auto";
      otherInput.style.height = otherInput.scrollHeight + "px";
    };
    otherInput.addEventListener("input", () => {
      autoResizeOther();
      if (otherInput.value && !otherCheck.checked) {
        otherCheck.checked = true;
        if (question.type === "multi") updateDoneState(question.id);
      }
      debounceSave();
    });
    otherInput.addEventListener("focus", () => {
      if (!otherCheck.checked) {
        otherCheck.checked = true;
        if (question.type === "multi") updateDoneState(question.id);
        debounceSave();
      }
    });
    otherCheck.addEventListener("change", () => {
      debounceSave();
      if (question.type === "multi") updateDoneState(question.id);
      if (otherCheck.checked) otherInput.focus();
    });
    otherLabel.appendChild(otherCheck);
    otherLabel.appendChild(otherInput);
    list.appendChild(otherLabel);

    if (question.type === "multi") {
      const doneItem = document.createElement("div");
      doneItem.className = "option-item done-item disabled";
      doneItem.setAttribute("tabindex", "0");
      doneItem.dataset.doneFor = question.id;
      doneItem.innerHTML = '<span class="done-check">✓</span><span>Done</span>';
      doneItem.addEventListener("click", () => {
        if (!doneItem.classList.contains("disabled")) {
          nextQuestion();
        }
      });
      doneItem.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !doneItem.classList.contains("disabled")) {
          e.preventDefault();
          e.stopPropagation();
          nextQuestion();
        }
      });
      list.appendChild(doneItem);
    }

    return list;
  }

  function renderContentBlock(block) {
    if (!block || !block.source) return null;

    const markdownPreview = isMarkdownLang(block.lang) && block.showSource !== true;
    const container = document.createElement("div");
    container.className = "code-block";
    if (markdownPreview) {
      container.classList.add("markdown-content-block");
    }

    if (block.file || block.lines || block.lang || block.title) {
      const header = document.createElement("div");
      header.className = "code-block-header";

      if (block.title) {
        const titleEl = document.createElement("span");
        titleEl.className = "code-block-title";
        titleEl.textContent = block.title;
        header.appendChild(titleEl);
      }

      if (block.file) {
        const fileEl = document.createElement("span");
        fileEl.className = "code-block-file";
        fileEl.textContent = block.file;
        header.appendChild(fileEl);
      }

      if (block.lines) {
        const linesEl = document.createElement("span");
        linesEl.className = "code-block-lines";
        linesEl.textContent = `L${block.lines}`;
        header.appendChild(linesEl);
      }

      if (block.lang && block.lang !== "diff") {
        const langEl = document.createElement("span");
        langEl.className = "code-block-lang";
        langEl.textContent = block.lang;
        header.appendChild(langEl);
      }

      container.appendChild(header);
    }

    if (markdownPreview) {
      const preview = document.createElement("div");
      preview.className = "markdown-preview";
      preview.innerHTML = renderMarkdownPreviewFallback(block.source);
      container.appendChild(preview);
      return container;
    }

    const showLineNumbers = !!block.file || !!block.lines;
    const isDiff = block.lang === "diff";
    const lines = block.source.split("\n");
    const highlights = new Set(block.highlights || []);

    let startLineNum = 1;
    if (block.lines) {
      const match = block.lines.match(/^(\d+)/);
      if (match) startLineNum = parseInt(match[1], 10);
    }

    const pre = document.createElement("pre");
    const code = document.createElement("code");

    if (showLineNumbers || isDiff || highlights.size > 0) {
      const linesContainer = document.createElement("div");
      linesContainer.className = "code-block-lines-container";

      lines.forEach((lineText, i) => {
        const lineNum = startLineNum + i;
        const lineEl = document.createElement("div");
        lineEl.className = "code-block-line";

        if (highlights.has(i + 1)) {
          lineEl.classList.add("highlighted");
        }

        if (isDiff) {
          if (lineText.startsWith("+") && !lineText.startsWith("+++")) {
            lineEl.classList.add("diff-add");
          } else if (lineText.startsWith("-") && !lineText.startsWith("---")) {
            lineEl.classList.add("diff-remove");
          } else if (lineText.startsWith("@@") || lineText.startsWith("---") || lineText.startsWith("+++")) {
            lineEl.classList.add("diff-header");
          }
        }

        if (showLineNumbers) {
          const numEl = document.createElement("span");
          numEl.className = "code-block-line-number";
          numEl.textContent = String(lineNum);
          lineEl.appendChild(numEl);
        }

        const contentEl = document.createElement("span");
        contentEl.className = "code-block-line-content";
        contentEl.textContent = lineText;
        lineEl.appendChild(contentEl);

        linesContainer.appendChild(lineEl);
      });

      code.appendChild(linesContainer);
    } else {
      code.textContent = block.source;
    }

    pre.appendChild(code);
    container.appendChild(pre);

    return container;
  }

  function renderMediaImage(media) {
    const figure = document.createElement("figure");
    figure.className = "media-block media-image";

    const img = document.createElement("img");
    const isUrl = media.src.startsWith("http://") || media.src.startsWith("https://") || media.src.startsWith("data:");
    img.src = isUrl ? media.src : `/media?path=${encodeURIComponent(media.src)}&session=${encodeURIComponent(sessionToken)}`;
    img.alt = media.alt || "";
    img.loading = "lazy";

    figure.appendChild(img);
    if (media.caption) {
      const capEl = document.createElement("div");
      capEl.className = "media-caption";
      capEl.textContent = media.caption;
      figure.appendChild(capEl);
    }
    return figure;
  }

  function renderMediaTable(media) {
    const t = media.table;
    const wrapper = document.createElement("div");
    wrapper.className = "media-block media-table";

    const tableScroll = document.createElement("div");
    tableScroll.className = "media-table-scroll";

    const table = document.createElement("table");
    table.className = "data-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    t.headers.forEach(h => {
      const th = document.createElement("th");
      th.textContent = h;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const highlights = new Set(t.highlights || []);
    t.rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      if (highlights.has(i)) tr.classList.add("highlighted-row");
      row.forEach(cell => {
        const td = document.createElement("td");
        td.innerHTML = renderLightMarkdown(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    tableScroll.appendChild(table);
    wrapper.appendChild(tableScroll);

    if (media.caption) {
      const capEl = document.createElement("div");
      capEl.className = "media-caption";
      capEl.textContent = media.caption;
      wrapper.appendChild(capEl);
    }
    return wrapper;
  }

  function renderMediaChart(media) {
    const wrapper = document.createElement("div");
    wrapper.className = "media-block media-chart";

    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 300;
    wrapper.appendChild(canvas);

    if (media.caption) {
      const capEl = document.createElement("div");
      capEl.className = "media-caption";
      capEl.textContent = media.caption;
      wrapper.appendChild(capEl);
    }

    requestAnimationFrame(() => {
      if (typeof Chart === "undefined") return;
      const chartConfig = JSON.parse(JSON.stringify(media.chart));
      chartConfig.options = chartConfig.options || {};
      chartConfig.options.responsive = true;
      chartConfig.options.maintainAspectRatio = true;
      new Chart(canvas, chartConfig);
    });

    return wrapper;
  }

  function renderMediaMermaid(media) {
    const wrapper = document.createElement("div");
    wrapper.className = "media-block media-mermaid";

    const pre = document.createElement("pre");
    pre.className = "mermaid";
    pre.textContent = media.mermaid;
    wrapper.appendChild(pre);

    if (media.caption) {
      const capEl = document.createElement("div");
      capEl.className = "media-caption";
      capEl.textContent = media.caption;
      wrapper.appendChild(capEl);
    }
    return wrapper;
  }

  function renderMediaHtml(media) {
    const wrapper = document.createElement("div");
    wrapper.className = "media-block media-html";
    wrapper.innerHTML = media.html;
    wrapper.querySelectorAll("script").forEach(s => s.remove());

    if (media.caption) {
      const capEl = document.createElement("div");
      capEl.className = "media-caption";
      capEl.textContent = media.caption;
      wrapper.appendChild(capEl);
    }
    return wrapper;
  }

  function renderMediaBlock(media) {
    if (!media || !media.type) return null;
    if (media.maxHeight) {
      const el = renderMediaBlockByType(media);
      if (el) el.style.maxHeight = media.maxHeight;
      return el;
    }
    return renderMediaBlockByType(media);
  }

  function renderMediaBlockByType(media) {
    switch (media.type) {
      case "image": return renderMediaImage(media);
      case "table": return renderMediaTable(media);
      case "chart": return renderMediaChart(media);
      case "mermaid": return renderMediaMermaid(media);
      case "html": return renderMediaHtml(media);
      default: return null;
    }
  }

  function isPrintableKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    return event.key.length === 1;
  }

  function isQuestionNavShortcut(event, direction) {
    const key = direction === "prev" ? "ArrowLeft" : "ArrowRight";
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const modPressed = isMac ? event.metaKey : event.ctrlKey;
    const otherModPressed = isMac ? event.ctrlKey : event.metaKey;
    return event.key === key && modPressed && !otherModPressed && !event.altKey && !event.shiftKey;
  }

  function isEditableTextControl(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return ["password", "search", "tel", "text", "url"].includes(element.type);
  }

  function handlePaste(event) {
    const active = document.activeElement;
    if (!isEditableTextControl(active)) return;

    const text = event.clipboardData?.getData("text/plain");
    if (typeof text !== "string" || text.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    const start = active.selectionStart ?? active.value.length;
    const end = active.selectionEnd ?? start;
    active.setRangeText(text, start, end, "end");
    active.dispatchEvent(new Event("input", { bubbles: true }));
    refreshCountdown();
    debounceSave();
  }

  function maybeStartOtherInput(event) {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement)) return false;
    if ((active.type !== "radio" && active.type !== "checkbox") || active.value !== "__other__") return false;
    if (!isPrintableKey(event)) return false;
    const card = active.closest(".question-card");
    const otherInput = card?.querySelector(".other-input");
    if (!otherInput) return false;

    event.preventDefault();
    if (!active.checked) {
      active.checked = true;
      const question = questions.find((q) => q.id === active.name);
      if (question?.type === "multi") updateDoneState(active.name);
      debounceSave();
    }
    otherInput.focus();
    otherInput.value += event.key;
    otherInput.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  const themeConfig = data.theme || {};
  const themeMode = themeConfig.mode || "dark";
  const themeToggleHotkey =
    typeof themeConfig.toggleHotkey === "string" ? themeConfig.toggleHotkey : "";
  const themeLinkLight = document.querySelector('link[data-theme-link="light"]');
  const themeLinkDark = document.querySelector('link[data-theme-link="dark"]');
  const THEME_OVERRIDE_KEY = "pi-interview-theme-override";

  function getSystemTheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function getStoredThemeOverride() {
    const value = localStorage.getItem(THEME_OVERRIDE_KEY);
    return value === "light" || value === "dark" ? value : null;
  }

  function setStoredThemeOverride(value) {
    if (!value) {
      localStorage.removeItem(THEME_OVERRIDE_KEY);
      return;
    }
    localStorage.setItem(THEME_OVERRIDE_KEY, value);
  }

  function setThemeLinkEnabled(link, enabled) {
    if (!link) return;
    link.disabled = !enabled;
    link.media = enabled ? "all" : "not all";
  }

  function applyTheme(mode) {
    document.documentElement.dataset.theme = mode;
    setThemeLinkEnabled(themeLinkLight, mode === "light");
    setThemeLinkEnabled(themeLinkDark, mode === "dark");
  }

  function getEffectiveThemeMode() {
    const override = getStoredThemeOverride();
    if (override) return override;
    if (themeMode === "auto") return getSystemTheme();
    return themeMode;
  }

  function parseHotkey(value) {
    if (!value) return null;
    const parts = value.toLowerCase().split("+").map(part => part.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    const hotkey = { key, mod: false, shift: false, alt: false };

    mods.forEach((mod) => {
      if (mod === "mod" || mod === "cmd" || mod === "meta" || mod === "ctrl" || mod === "control") {
        hotkey.mod = true;
      } else if (mod === "shift") {
        hotkey.shift = true;
      } else if (mod === "alt" || mod === "option") {
        hotkey.alt = true;
      }
    });

    return key ? hotkey : null;
  }

  function updateThemeShortcutDisplay(hotkey) {
    const shortcut = document.querySelector("[data-theme-shortcut]");
    if (!shortcut) return;
    if (!hotkey) {
      shortcut.classList.add("hidden");
      return;
    }

    const keysEl = shortcut.querySelector("[data-theme-keys]");
    if (!keysEl) return;
    keysEl.innerHTML = "";

    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const parts = [];
    if (hotkey.mod) parts.push(isMac ? "⌘" : "Ctrl");
    if (hotkey.shift) parts.push("Shift");
    if (hotkey.alt) parts.push(isMac ? "Option" : "Alt");
    parts.push(hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key.toUpperCase());

    parts.forEach((part) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = part;
      keysEl.appendChild(kbd);
    });

    shortcut.classList.remove("hidden");
  }

  function matchesHotkey(event, hotkey) {
    const key = event.key.toLowerCase();
    if (key !== hotkey.key) return false;
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const modPressed = isMac ? event.metaKey : event.ctrlKey;
    if (hotkey.mod !== modPressed) return false;
    if (hotkey.shift !== event.shiftKey) return false;
    if (hotkey.alt !== event.altKey) return false;
    if (!hotkey.mod && (event.metaKey || event.ctrlKey)) return false;
    if (!hotkey.shift && event.shiftKey) return false;
    if (!hotkey.alt && event.altKey) return false;
    return true;
  }

  function toggleTheme() {
    const current = getEffectiveThemeMode();
    const next = current === "dark" ? "light" : "dark";
    if (themeMode === "auto") {
      const system = getSystemTheme();
      if (next === system) {
        setStoredThemeOverride(null);
      } else {
        setStoredThemeOverride(next);
      }
    } else {
      setStoredThemeOverride(next);
    }
    applyTheme(next);
  }

  function initTheme() {
    applyTheme(getEffectiveThemeMode());

    if (themeMode === "auto") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", () => {
        if (!getStoredThemeOverride()) {
          applyTheme(getSystemTheme());
        }
      });
    }

    const hotkey = parseHotkey(themeToggleHotkey);
    updateThemeShortcutDisplay(hotkey);
    if (hotkey) {
      document.addEventListener("keydown", (event) => {
        if (matchesHotkey(event, hotkey)) {
          event.preventDefault();
          toggleTheme();
        }
      });
    }
  }

  function normalizePath(path) {
    let normalized = path.replace(/\\ /g, " ");  // Shell escape: backslash-space to space
    // macOS screenshots use narrow no-break space (\u202f) before AM/PM in "Screenshot YYYY-MM-DD at H.MM.SS AM/PM.png"
    normalized = normalized.replace(/(\d{1,2}\.\d{2}\.\d{2}) (AM|PM)(\.\w+)?$/i, "$1\u202f$2$3");
    return normalized;
  }

  function debounceSave() {
    if (timers.save) {
      window.clearTimeout(timers.save);
    }
    timers.save = window.setTimeout(() => {
      saveProgress();
    }, 500);
  }

  function createImageManager(options) {
    const {
      fileState,
      pathState,
      containerSelector,
      onUpdate,
      onRenderComplete,
      removeLabel = "×",
    } = options;

    const manager = {
      render(questionId) {
        const container = document.querySelector(containerSelector(questionId));
        if (!container) return;
        container.innerHTML = "";

        const entry = fileState.get(questionId);
        if (entry) {
          const item = document.createElement("div");
          item.className = "selected-item selected-image";

          const img = document.createElement("img");
          const url = URL.createObjectURL(entry.file);
          img.src = url;
          img.onload = () => URL.revokeObjectURL(url);

          const name = document.createElement("span");
          name.className = "selected-item-name";
          name.textContent = entry.file.name;

          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "selected-item-remove";
          removeBtn.textContent = removeLabel;
          removeBtn.addEventListener("click", () => {
            fileState.delete(questionId);
            manager.render(questionId);
            onUpdate();
          });

          item.appendChild(img);
          item.appendChild(name);
          item.appendChild(removeBtn);
          container.appendChild(item);
        }

        const paths = pathState.get(questionId) || [];
        paths.forEach(path => {
          const item = document.createElement("div");
          item.className = "selected-item selected-path";

          const pathText = document.createElement("span");
          pathText.className = "selected-item-path";
          pathText.textContent = path;

          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "selected-item-remove";
          removeBtn.textContent = removeLabel;
          removeBtn.addEventListener("click", () => {
            const arr = pathState.get(questionId) || [];
            const idx = arr.indexOf(path);
            if (idx > -1) arr.splice(idx, 1);
            manager.render(questionId);
            onUpdate();
          });

          item.appendChild(pathText);
          item.appendChild(removeBtn);
          container.appendChild(item);
        });

        if (onRenderComplete) onRenderComplete(questionId, manager);
      },

      addFile(questionId, file) {
        fileState.set(questionId, { file });
        manager.render(questionId);
        onUpdate();
      },

      removeFile(questionId) {
        fileState.delete(questionId);
        manager.render(questionId);
        onUpdate();
      },

      addPath(questionId, path) {
        const paths = pathState.get(questionId) || [];
        if (!paths.includes(path)) {
          paths.push(path);
          pathState.set(questionId, paths);
          manager.render(questionId);
          onUpdate();
        }
      },

      removePath(questionId, path) {
        const paths = pathState.get(questionId) || [];
        const index = paths.indexOf(path);
        if (index > -1) {
          paths.splice(index, 1);
          pathState.set(questionId, paths);
          manager.render(questionId);
          onUpdate();
        }
      },

      getFile(questionId) {
        return fileState.get(questionId);
      },

      getPaths(questionId) {
        return pathState.get(questionId) || [];
      },

      hasContent(questionId) {
        return fileState.has(questionId) || (pathState.get(questionId) || []).length > 0;
      },

      countFiles() {
        return fileState.size;
      },
    };

    return manager;
  }

  const questionImages = createImageManager({
    fileState: imageState,
    pathState: imagePathState,
    containerSelector: (id) => `[data-selected-for="${escapeSelector(id)}"]`,
    onUpdate: debounceSave,
  });

  const attachments = createImageManager({
    fileState: attachState,
    pathState: attachPathState,
    containerSelector: (id) => `[data-attach-items-for="${escapeSelector(id)}"]`,
    onUpdate: debounceSave,
    removeLabel: "x",
    onRenderComplete: (questionId, manager) => {
      const btn = document.querySelector(
        `.attach-btn[data-question-id="${escapeSelector(questionId)}"]`
      );
      const panel = document.querySelector(
        `[data-attach-inline-for="${escapeSelector(questionId)}"]`
      );
      const hasContent = manager.hasContent(questionId);
      if (btn) btn.classList.toggle("has-attachment", hasContent);
      if (panel && hasContent) panel.classList.remove("hidden");
    },
  });

  function updateDoneState(questionId) {
    const doneItem = document.querySelector(`[data-done-for="${escapeSelector(questionId)}"]`);
    if (!doneItem) return;
    const hasSelection = document.querySelectorAll(`input[name="${escapeSelector(questionId)}"]:checked`).length > 0;
    doneItem.classList.toggle("disabled", !hasSelection);
  }

  function clearGlobalError() {
    if (!errorContainer) return;
    errorContainer.textContent = "";
    errorContainer.classList.add("hidden");
  }

  function showGlobalError(message) {
    if (!errorContainer) return;
    errorContainer.textContent = message;
    errorContainer.classList.remove("hidden");
  }

  function setFieldError(id, message) {
    const field = document.querySelector(`[data-error-for="${escapeSelector(id)}"]`);
    if (!field) return;
    field.textContent = message || "";
  }

  function clearFieldErrors() {
    const fields = document.querySelectorAll(".field-error");
    fields.forEach((el) => {
      el.textContent = "";
    });
  }

  const formFooter = document.querySelector('.form-footer');

  function getOptionsForCard(card) {
    const inputs = Array.from(card.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    const dropzone = card.querySelector('.file-dropzone');
    const pathInput = card.querySelector('.image-path-input');
    const cameraButton = card.querySelector('.file-input .camera-open-btn');
    const doneItem = card.querySelector('.done-item');
    
    const items = [...inputs];
    if (dropzone) items.push(dropzone);
    if (cameraButton) items.push(cameraButton);
    if (pathInput) items.push(pathInput);
    if (doneItem) items.push(doneItem);
    
    return items;
  }

  function getTabStopsForCard(card) {
    return Array.from(
      card.querySelectorAll('input[type="radio"], input[type="checkbox"], .option-note-input, .option-ask-btn, .file-dropzone, .file-input .camera-open-btn, .image-path-input, .done-item')
    );
  }

  function isPathInput(el) {
    return el && (el.classList.contains('image-path-input') || el.classList.contains('attach-inline-path') || el.classList.contains('other-input') || el.classList.contains('option-note-input'));
  }

  function isDropzone(el) {
    return el && el.classList.contains('file-dropzone');
  }

  function isCameraButton(el) {
    return el && el.classList.contains('camera-open-btn');
  }

  function isOptionInput(el) {
    return el && (el.type === 'radio' || el.type === 'checkbox');
  }

  function isDoneItem(el) {
    return el && el.classList.contains('done-item');
  }

  function setupDropzone(dropzone, fileInput) {
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("dragover");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("dragover");
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const dt = new DataTransfer();
        dt.items.add(files[0]);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change"));
      }
    });
  }

  function highlightOption(card, optionIndex, isKeyboard = true) {
    const options = getOptionsForCard(card);
    options.forEach((opt, i) => {
      const item = isOptionInput(opt) ? (opt.closest('.option-row') || opt.closest('.option-item')) : opt;
      item?.classList.toggle('focused', i === optionIndex);
    });
    const current = options[optionIndex];
    if (current) {
      current.focus();
    }
    if (isKeyboard) {
      card.classList.add('keyboard-nav');
    }
  }

  function focusCardTabStop(card, target, isKeyboard = true) {
    if (!target) return;

    clearOptionHighlight(card);

    const row = target.closest?.('.option-row');
    const highlightTarget = row || (isOptionInput(target) ? target.closest('.option-item') : target);
    highlightTarget?.classList.add('focused');

    const rowInput = row?.querySelector('input[type="radio"], input[type="checkbox"]');
    const options = getOptionsForCard(card);
    const navTarget = rowInput || target;
    const nextIndex = options.indexOf(navTarget);
    if (nextIndex >= 0) {
      nav.optionIndex = nextIndex;
    }

    target.focus();
    if (isKeyboard) {
      card.classList.add('keyboard-nav');
    }
  }

  function clearOptionHighlight(card) {
    card.querySelectorAll('.option-row, .option-item, .done-item, .file-dropzone, .image-path-input').forEach(item => {
      item.classList.remove('focused');
    });
  }

  function ensureElementVisible(el) {
    const rect = el.getBoundingClientRect();
    const margin = 80;
    if (rect.top < margin || rect.bottom > window.innerHeight - margin) {
      el.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
  }

  function focusQuestion(index, fromDirection = 'next') {
    while (index >= 0 && index < nav.cards.length && nav.cards[index].classList.contains('info-panel')) {
      index += fromDirection === 'prev' ? -1 : 1;
    }
    if (index < 0 || index >= nav.cards.length) return false;
    
    deactivateSubmitArea();
    
    const prevCard = nav.cards[nav.questionIndex];
    if (prevCard) {
      prevCard.classList.remove('active', 'keyboard-nav');
      clearOptionHighlight(prevCard);
    }
    
    nav.questionIndex = index;
    const card = nav.cards[index];
    card.classList.add('active');
    ensureElementVisible(card);
    
    const options = getOptionsForCard(card);
    const dropzone = card.querySelector('.file-dropzone');
    const textarea = card.querySelector('textarea');
    
    if (dropzone) {
      nav.optionIndex = 0;
      highlightOption(card, nav.optionIndex);
    } else if (options.length > 0) {
      nav.optionIndex = fromDirection === 'prev' ? options.length - 1 : 0;
      highlightOption(card, nav.optionIndex);
    } else if (textarea) {
      textarea.focus();
      if (fromDirection === 'prev') {
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      }
    }
    return true;
  }

  function nextQuestion() {
    if (nav.questionIndex < nav.cards.length - 1) {
      if (!focusQuestion(nav.questionIndex + 1, 'next')) {
        activateSubmitArea();
      }
    } else {
      activateSubmitArea();
    }
  }

  function activateSubmitArea() {
    const prevCard = nav.cards[nav.questionIndex];
    if (prevCard) {
      prevCard.classList.remove('active', 'keyboard-nav');
      clearOptionHighlight(prevCard);
    }
    nav.inSubmitArea = true;
    formFooter?.classList.add('active');
    submitBtn.focus();
    if (formFooter) ensureElementVisible(formFooter);
  }

  function deactivateSubmitArea() {
    nav.inSubmitArea = false;
    formFooter?.classList.remove('active');
  }

  function prevQuestion() {
    if (nav.questionIndex > 0) {
      focusQuestion(nav.questionIndex - 1, 'prev');
    }
  }

  function handleQuestionKeydown(event) {
    if (event.key === 'Escape') {
      if (!expiredOverlay.classList.contains('hidden')) {
        if (timers.countdown) clearInterval(timers.countdown);
        cancelInterview("user").finally(() => closeWindow());
        return;
      }
      showSessionExpired();
      return;
    }
    
    const isMeta = event.metaKey || event.ctrlKey;
    if (event.key === 'Enter' && isMeta) {
      event.preventDefault();
      formEl.requestSubmit();
      return;
    }

    if (maybeStartOtherInput(event)) return;

    if (nav.inSubmitArea) return;
    
    const card = nav.cards[nav.questionIndex];
    if (!card) return;
    
    const options = getOptionsForCard(card);
    const textarea = card.querySelector('textarea');
    const isTextFocused = document.activeElement === textarea;
    const inAskArea = document.activeElement?.closest('.option-insight-panel, .option-ask-btn, .option-insight-pinned');
    const inOptionNote = document.activeElement?.closest('.option-note-wrap');

    if (event.key === 'Tab') {
      const inAttachArea = document.activeElement?.closest('.attach-inline');
      const inGenerateArea = document.activeElement?.closest('.generate-more');
      if (inAttachArea || inGenerateArea || inAskArea || inOptionNote) return;
      
      const tabStops = getTabStopsForCard(card);
      if (tabStops.length === 0) {
        return;
      }

      event.preventDefault();

      const activeIndex = tabStops.indexOf(document.activeElement);
      const fallbackIndex = options[nav.optionIndex] ? tabStops.indexOf(options[nav.optionIndex]) : -1;
      const currentIndex = activeIndex >= 0 ? activeIndex : (fallbackIndex >= 0 ? fallbackIndex : 0);
      const nextIndex = event.shiftKey
        ? (currentIndex - 1 + tabStops.length) % tabStops.length
        : (currentIndex + 1) % tabStops.length;
      focusCardTabStop(card, tabStops[nextIndex]);
      return;
    }

    if (inAskArea || inOptionNote) return;

    if (isQuestionNavShortcut(event, "prev")) {
      if (isEditableTextControl(document.activeElement)) return;
      event.preventDefault();
      prevQuestion();
      return;
    }

    if (isQuestionNavShortcut(event, "next")) {
      if (isEditableTextControl(document.activeElement)) return;
      event.preventDefault();
      nextQuestion();
      return;
    }
    
    if (options.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        nav.optionIndex = (nav.optionIndex + 1) % options.length;
        highlightOption(card, nav.optionIndex);
        return;
      }
      
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        nav.optionIndex = (nav.optionIndex - 1 + options.length) % options.length;
        highlightOption(card, nav.optionIndex);
        return;
      }
      
      if (event.key === 'Enter' || event.key === ' ') {
      if (isPathInput(document.activeElement)) {
        return;
      }
      if (document.activeElement?.closest('.attach-inline')) {
        return;
      }
      if (document.activeElement?.closest('.generate-more')) {
        return;
      }
      if (document.activeElement?.closest('.option-insight-panel, .option-ask-btn')) {
        return;
      }
      event.preventDefault();
        const option = options[nav.optionIndex];
        if (option) {
          if (isDoneItem(option)) {
            if (!option.classList.contains('disabled')) {
              nextQuestion();
            }
          } else if (isDropzone(option)) {
            if (!filePickerOpen) {
              filePickerOpen = true;
              const fileInput = card.querySelector('input[type="file"]');
              if (fileInput) fileInput.click();
            }
          } else if (isCameraButton(option)) {
            option.click();
          } else if (option.type === 'radio') {
            option.checked = true;
            debounceSave();
            if (option.value === '__other__') {
              const otherInput = card.querySelector('.other-input');
              if (otherInput) otherInput.focus();
            } else {
              nextQuestion();
            }
          } else if (option.type === 'checkbox') {
            option.checked = !option.checked;
            debounceSave();
            const questionId = option.name;
            updateDoneState(questionId);
            if (option.value === '__other__' && option.checked) {
              const otherInput = card.querySelector('.other-input');
              if (otherInput) otherInput.focus();
            }
          }
        }
        return;
      }

      if ((event.key === 'a' || event.key === 'A') && isOptionInput(document.activeElement)) {
        event.preventDefault();
        const focusedInput = options[nav.optionIndex];
        const row = focusedInput?.closest('.option-row');
        const askButton = row?.querySelector('.option-ask-btn');
        if (askButton) {
          askButton.click();
        }
        return;
      }
    }
    
    if (textarea && !isTextFocused) {
      if (event.key === 'Enter') {
        event.preventDefault();
        textarea.focus();
        return;
      }
    }
    
    if (isTextFocused && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      nextQuestion();
      return;
    }
    
    if (document.activeElement?.type === 'file') {
      if (event.key === 'Enter' || event.key === ' ') {
        return;
      }
    }
  }

  function initQuestionNavigation() {
    nav.cards = Array.from(containerEl.querySelectorAll('.question-card'));
    
    nav.cards.forEach((card, index) => {
      card.setAttribute('tabindex', '0');
      card.addEventListener('focus', () => {
        if (nav.questionIndex !== index) {
          focusQuestion(index);
        }
      });
      card.addEventListener('click', (e) => {
        card.classList.remove('keyboard-nav');
        if (nav.questionIndex !== index) {
          if (e.target.closest('.option-item')) {
            nav.questionIndex = index;
            const prevCard = nav.cards.find(c => c.classList.contains('active'));
            if (prevCard && prevCard !== card) {
              prevCard.classList.remove('active', 'keyboard-nav');
              clearOptionHighlight(prevCard);
            }
            card.classList.add('active');
          } else {
            focusQuestion(index);
          }
        }
      });
    });
    
    containerEl.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(input => {
      input.setAttribute('tabindex', '-1');
    });
    
    document.addEventListener("paste", handlePaste, true);
    document.addEventListener('keydown', handleQuestionKeydown);
    
    if (nav.cards.length > 0) {
      setTimeout(() => {
        if (!focusQuestion(0)) {
          activateSubmitArea();
        }
      }, 100);
    }
  }

  function createGenerateMoreUI(question, list) {
    if (!data.canGenerate) return null;

    const container = document.createElement("div");
    container.className = "generate-more";

    const btnRow = document.createElement("div");
    btnRow.className = "generate-more-row";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "generate-more-btn";
    addBtn.innerHTML = '<span class="generate-more-icon">✦</span> Generate more';

    const reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "generate-more-btn";
    reviewBtn.innerHTML = '<span class="generate-more-icon">↻</span> Review options';

    const status = document.createElement("div");
    status.className = "generate-more-status hidden";

    btnRow.appendChild(addBtn);
    btnRow.appendChild(reviewBtn);
    container.appendChild(btnRow);
    container.appendChild(status);

    let generating = false;
    let abortController = null;
    let statusTimer = null;

    function clearStatus() {
      if (statusTimer !== null) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      status.classList.add("hidden");
      status.classList.remove("error");
    }

    function showStatus(message, timeoutMs, isError = false) {
      if (statusTimer !== null) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }

      status.textContent = message;
      status.classList.remove("hidden");
      status.classList.toggle("error", isError);

      if (timeoutMs == null) {
        return;
      }

      statusTimer = setTimeout(() => {
        status.classList.add("hidden");
        statusTimer = null;
      }, timeoutMs);
    }

    async function runGenerate(btn, mode) {
      if (generating) {
        if (abortController) abortController.abort();
        return;
      }

      generating = true;
      const icon = btn.querySelector(".generate-more-icon").textContent;
      btn.innerHTML = '<span class="generate-more-icon">' + icon + '</span> Cancel';
      btn.classList.add("loading");
      addBtn.disabled = true;
      reviewBtn.disabled = true;
      btn.disabled = false;
      clearStatus();

      abortController = new AbortController();
      const currentValue = getQuestionValue(question);

      try {
        const response = await fetch("/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: sessionToken,
            questionId: question.id,
            mode,
          }),
          signal: abortController.signal,
        });

        const result = await response.json();
        if (!result.ok) throw new Error(result.error || "Generation failed");
        if (!Array.isArray(result.options)) {
          throw new Error("Generation returned invalid options");
        }
        if (mode === "review" && result.options.length === 0) {
          throw new Error("No options generated");
        }
        if (Array.isArray(result.optionKeys)) {
          setOptionKeys(question.id, result.optionKeys);
          pruneQuestionOptionInsights(question.id);
        }

        if (mode === "review") {
          if (typeof result.question !== "string" || !result.question.trim()) {
            throw new Error("No revised question returned");
          }

          const revisedOptions = result.options;

          question.question = result.question.trim();
          question.options = revisedOptions;
          syncRecommendations(question, revisedOptions);
          const title = list.closest('.question-card')?.querySelector('.question-title');
          if (title) {
            title.innerHTML = renderLightMarkdown(question.question);
          }
          const revisedLabels = new Set(revisedOptions.map((option) => getOptionLabel(option)));
          const nextValue = preserveChoiceAnswerValue(question, currentValue, revisedLabels);
          replaceQuestionOptionList(question, nextValue);
          debounceSave();
          showStatus(
            "Question updated and " + revisedOptions.length + " option" + (revisedOptions.length > 1 ? "s" : "") + " revised",
            2500,
          );
        } else {
          const newOptions = result.options;

          if (newOptions.length === 0) {
            showStatus("All generated options already exist", 3000);
          } else {
            question.options = question.options.concat(newOptions);
            const optionKeys = getOptionKeys(question.id);
            const generatedKeys = optionKeys.slice(-newOptions.length);
            replaceQuestionOptionList(question, currentValue, generatedKeys[0] || null, {
              generatedKeys,
            });
            debounceSave();
            showStatus(
              newOptions.length + " option" + (newOptions.length > 1 ? "s" : "") + " added",
              2500,
            );
          }
        }
        refreshCountdown();
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          showStatus(err instanceof Error ? err.message : "Generation failed", null, true);
        }
      } finally {
        generating = false;
        addBtn.innerHTML = '<span class="generate-more-icon">✦</span> Generate more';
        reviewBtn.innerHTML = '<span class="generate-more-icon">↻</span> Review options';
        addBtn.classList.remove("loading");
        reviewBtn.classList.remove("loading");
        addBtn.disabled = false;
        reviewBtn.disabled = false;
        abortController = null;
      }
    }

    addBtn.addEventListener("click", () => runGenerate(addBtn, "add"));
    reviewBtn.addEventListener("click", () => runGenerate(reviewBtn, "review"));

    return container;
  }

  function createQuestionCard(question, index, badgeNumber) {
    const card = document.createElement("section");
    card.className = "question-card";
    card.setAttribute("role", "listitem");
    card.dataset.questionId = question.id;

    const colors = ['--q-color-1', '--q-color-2', '--q-color-3', '--q-color-4', '--q-color-5', '--q-color-6'];
    card.style.setProperty('--card-accent', `var(${colors[index % colors.length]})`);
    card.style.setProperty('--i', String(index));

    if (question.weight === "minor") card.classList.add("weight-minor");
    if (question.weight === "critical") card.classList.add("weight-critical");

    const header = document.createElement('div');
    header.className = 'question-header';

    const title = document.createElement("h2");
    title.className = "question-title";
    title.id = `q-${question.id}-title`;
    title.innerHTML = renderLightMarkdown(question.question);

    if (badgeNumber !== null) {
      const badge = document.createElement('span');
      badge.className = 'question-badge';
      badge.textContent = String(badgeNumber);
      header.appendChild(badge);
    }
    header.appendChild(title);
    card.appendChild(header);

    if (question.context) {
      const context = document.createElement("p");
      context.className = "question-context";
      context.innerHTML = renderLightMarkdown(question.context);
      card.appendChild(context);
    }

    if (question.content) {
      const contentBlockEl = renderContentBlock(question.content);
      if (contentBlockEl) {
        contentBlockEl.classList.add("question-code-block");
        card.appendChild(contentBlockEl);
      }
    }

    let belowMedia = [];
    let sideMedia = [];
    if (question.media) {
      const mediaList = Array.isArray(question.media) ? question.media : [question.media];
      const aboveMedia = mediaList.filter(m => !m.position || m.position === "above");
      belowMedia = mediaList.filter(m => m.position === "below");
      sideMedia = mediaList.filter(m => m.position === "side");

      aboveMedia.forEach(m => {
        const el = renderMediaBlock(m);
        if (el) card.appendChild(el);
      });
    }

    if (question.type === "info") {
      card.classList.add("info-panel");
      belowMedia.forEach(m => {
        const el = renderMediaBlock(m);
        if (el) card.appendChild(el);
      });
      if (sideMedia.length > 0) {
        applySideLayout(card, sideMedia);
      }
      return card;
    }

    if (question.type === "single" || question.type === "multi") {
      card.appendChild(createChoiceQuestionList(question, title));
    }

    if (question.type === "text") {
      const textarea = document.createElement("textarea");
      textarea.dataset.questionId = question.id;
      textarea.addEventListener("input", () => {
        debounceSave();
      });
      card.appendChild(textarea);
    }

    if (question.type === "image") {
      imagePathState.set(question.id, []);
      
      const wrapper = document.createElement("div");
      wrapper.className = "file-input";

      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/gif,image/webp";
      input.dataset.questionId = question.id;

      input.addEventListener("change", () => {
        setTimeout(() => { filePickerOpen = false; }, 200);
        clearGlobalError();
        handleFileChange(question.id, input, questionImages, {
          onEmpty: () => clearImage(question.id),
        });
      });
      input.addEventListener("cancel", () => {
        setTimeout(() => { filePickerOpen = false; }, 200);
      });
      input.addEventListener("blur", () => {
        setTimeout(() => { filePickerOpen = false; }, 500);
      });

      const dropzone = document.createElement("div");
      dropzone.className = "file-dropzone";
      dropzone.setAttribute("tabindex", "0");
      dropzone.innerHTML = `
        <span class="file-dropzone-icon">+</span>
        <span class="file-dropzone-text">Click to upload</span>
        <span class="file-dropzone-hint">PNG, JPG, GIF, WebP (max 5MB)</span>
      `;
      
      const pathInput = document.createElement("input");
      pathInput.type = "text";
      pathInput.className = "image-path-input";
      pathInput.placeholder = "Or paste image path/URL and press Enter...";
      pathInput.dataset.questionId = question.id;
      pathInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && pathInput.value.trim()) {
          e.preventDefault();
          e.stopPropagation();
          questionImages.addPath(question.id, normalizePath(pathInput.value.trim()));
          pathInput.value = "";
        }
      });
      
      const selectedItems = document.createElement("div");
      selectedItems.className = "image-selected-items";
      selectedItems.dataset.selectedFor = question.id;
      dropzone.addEventListener("click", () => {
        if (!filePickerOpen) {
          filePickerOpen = true;
          input.click();
        }
      });
      dropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          if (!filePickerOpen) {
            filePickerOpen = true;
            input.click();
          }
        }
        if (isQuestionNavShortcut(e, "next")) {
          e.preventDefault();
          e.stopPropagation();
          nextQuestion();
        }
        if (isQuestionNavShortcut(e, "prev")) {
          e.preventDefault();
          e.stopPropagation();
          prevQuestion();
        }
      });
      
      setupDropzone(dropzone, input);

      const sourceActions = document.createElement("div");
      sourceActions.className = "image-source-actions";
      sourceActions.appendChild(createCameraButton(question.id, questionImages));

      wrapper.appendChild(input);
      wrapper.appendChild(dropzone);
      wrapper.appendChild(sourceActions);
      wrapper.appendChild(pathInput);
      wrapper.appendChild(selectedItems);
      card.appendChild(wrapper);
    }

    if (question.type !== "image") {
      attachPathState.set(question.id, []);
      
      const attachHint = document.createElement("div");
      attachHint.className = "attach-hint";
      
      const attachBtn = document.createElement("button");
      attachBtn.type = "button";
      attachBtn.className = "attach-btn";
      attachBtn.innerHTML = '<span>+</span> attach';
      attachBtn.dataset.questionId = question.id;
      
      const attachInline = document.createElement("div");
      attachInline.className = "attach-inline hidden";
      attachInline.dataset.attachInlineFor = question.id;
      
      const attachFileInput = document.createElement("input");
      attachFileInput.type = "file";
      attachFileInput.accept = "image/png,image/jpeg,image/gif,image/webp";
      attachFileInput.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
      
      const attachDrop = document.createElement("div");
      attachDrop.className = "attach-inline-drop";
      attachDrop.setAttribute("tabindex", "0");
      attachDrop.textContent = "Drop image or click";

      const attachCameraBtn = createCameraButton(question.id, attachments, {
        onAccept: () => revealAttachmentArea(question.id),
      });
      
      const attachPath = document.createElement("input");
      attachPath.type = "text";
      attachPath.className = "attach-inline-path";
      attachPath.placeholder = "Or paste path/URL and press Enter";
      
      const attachItems = document.createElement("div");
      attachItems.className = "attach-inline-items";
      attachItems.dataset.attachItemsFor = question.id;
      
      attachBtn.addEventListener("click", () => {
        const isHidden = attachInline.classList.contains("hidden");
        attachInline.classList.toggle("hidden", !isHidden);
        if (isHidden) attachDrop.focus();
      });
      
      attachFileInput.addEventListener("change", () => {
        setTimeout(() => { filePickerOpen = false; }, 200);
        handleFileChange(question.id, attachFileInput, attachments);
      });
      
      attachDrop.addEventListener("click", () => {
        if (!filePickerOpen) {
          filePickerOpen = true;
          attachFileInput.click();
        }
      });
      attachDrop.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!filePickerOpen) {
            filePickerOpen = true;
            attachFileInput.click();
          }
        }
        if (e.key === "Tab") {
          e.preventDefault();
          if (e.shiftKey) {
            attachBtn.focus();
          } else {
            attachCameraBtn.focus();
          }
        }
        if (e.key === "Escape") {
          attachBtn.click();
          attachBtn.focus();
        }
      });
      setupDropzone(attachDrop, attachFileInput);
      
      attachPath.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && attachPath.value.trim()) {
          e.preventDefault();
          attachments.addPath(question.id, normalizePath(attachPath.value.trim()));
          attachPath.value = "";
        }
        if (e.key === "Tab") {
          e.preventDefault();
          if (e.shiftKey) {
            attachCameraBtn.focus();
          } else {
            attachBtn.click();
            attachBtn.focus();
          }
        }
        if (e.key === "Escape") {
          attachBtn.click();
          attachBtn.focus();
        }
      });
      
      attachInline.appendChild(attachFileInput);
      attachInline.appendChild(attachDrop);
      attachInline.appendChild(attachCameraBtn);
      attachInline.appendChild(attachPath);
      attachInline.appendChild(attachItems);
      
      attachHint.appendChild(attachBtn);
      card.appendChild(attachHint);
      card.appendChild(attachInline);
    }

    const error = document.createElement("div");
    error.className = "field-error";
    error.dataset.errorFor = question.id;
    error.setAttribute("aria-live", "polite");
    card.appendChild(error);

    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      card.classList.add("dragover");
    });
    card.addEventListener("dragleave", (e) => {
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove("dragover");
      }
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("dragover");
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (!file.type.startsWith("image/")) return;
        void addDroppedImage(question, file);
      }
    });

    belowMedia.forEach(m => {
      const el = renderMediaBlock(m);
      if (el) card.appendChild(el);
    });

    if (sideMedia.length > 0) {
      applySideLayout(card, sideMedia);
    }

    return card;
  }

  function applySideLayout(card, sideMedia) {
    const grid = document.createElement("div");
    grid.className = "question-side-layout";

    const mediaCol = document.createElement("div");
    mediaCol.className = "question-side-media";
    sideMedia.forEach(m => {
      const el = renderMediaBlock(m);
      if (el) mediaCol.appendChild(el);
    });

    const contentCol = document.createElement("div");
    contentCol.className = "question-side-content";
    while (card.firstChild) {
      contentCol.appendChild(card.firstChild);
    }

    grid.appendChild(mediaCol);
    grid.appendChild(contentCol);
    card.appendChild(grid);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => resolve(img);
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to load image"));
      };
      img.src = url;
    });
  }

  async function validateImage(file) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return { valid: false, error: "Invalid file type. Use PNG, JPG, GIF, or WebP." };
    }
    if (file.size > MAX_SIZE) {
      return { valid: false, error: "Image exceeds 5MB limit." };
    }

    const img = await loadImage(file);
    if (img.src) URL.revokeObjectURL(img.src);
    if (img.width > MAX_DIMENSION || img.height > MAX_DIMENSION) {
      return { valid: false, error: `Image exceeds ${MAX_DIMENSION}x${MAX_DIMENSION} limit.` };
    }
    return { valid: true };
  }

  function cameraUnavailableMessage() {
    if (!window.isSecureContext) {
      return "Camera capture requires a secure localhost or HTTPS page.";
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      return "Camera capture is not supported by this browser.";
    }
    return "";
  }

  function cameraErrorMessage(err) {
    const name = err && typeof err === "object" ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "Camera permission was denied. Allow access in the browser and try again.";
    }
    if (name === "NotFoundError") {
      return "No camera was found.";
    }
    if (name === "NotReadableError" || name === "AbortError") {
      return "The camera is still waking, busy, or unavailable. Wait a moment and retry, close other camera apps, or select a virtual camera.";
    }
    if (name === "OverconstrainedError") {
      return "The selected camera cannot satisfy the requested video settings.";
    }
    return err instanceof Error ? err.message : "Unable to start the camera.";
  }

  function releaseCameraStream() {
    const stream = cameraCaptureState.stream;
    cameraCaptureState.stream = null;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    const video = cameraCaptureState.overlay?.querySelector(".camera-preview-video");
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  }

  function clearCameraStill() {
    cameraCaptureState.pendingFile = null;
    if (cameraCaptureState.pendingUrl) {
      URL.revokeObjectURL(cameraCaptureState.pendingUrl);
      cameraCaptureState.pendingUrl = null;
    }
  }

  function closeCameraCapture(options = {}) {
    const { restoreFocus = true } = options;
    cameraCaptureState.requestId += 1;
    cameraCaptureState.startPending = false;
    releaseCameraStream();
    clearCameraStill();
    if (cameraCaptureState.deviceChangeHandler && typeof navigator.mediaDevices?.removeEventListener === "function") {
      navigator.mediaDevices.removeEventListener("devicechange", cameraCaptureState.deviceChangeHandler);
    }
    const overlay = cameraCaptureState.overlay;
    const opener = cameraCaptureState.opener;
    cameraCaptureState.overlay = null;
    cameraCaptureState.opener = null;
    cameraCaptureState.target = null;
    cameraCaptureState.deviceChangeHandler = null;
    overlay?.remove();
    document.body.classList.remove("camera-capture-open");
    if (restoreFocus && opener?.isConnected) opener.focus();
  }

  function setCameraStatus(message, kind = "info") {
    const status = cameraCaptureState.overlay?.querySelector(".camera-capture-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }

  async function populateCameraDevices() {
    const overlay = cameraCaptureState.overlay;
    const select = overlay?.querySelector(".camera-device-select");
    if (!select || !navigator.mediaDevices?.enumerateDevices) return;

    try {
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === "videoinput");
      if (!cameraCaptureState.overlay || select !== cameraCaptureState.overlay.querySelector(".camera-device-select")) return;

      const activeId = cameraCaptureState.stream?.getVideoTracks()[0]?.getSettings().deviceId || "";
      const preferredId = cameraCaptureState.selectedDeviceId || select.value || activeId;
      const selected = devices.find((device) => device.deviceId === preferredId) ||
        devices.find((device) => device.deviceId === activeId) || devices[0];
      select.replaceChildren();
      devices.forEach((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1}`;
        option.selected = device.deviceId === selected?.deviceId;
        select.appendChild(option);
      });
      cameraCaptureState.selectedDeviceId = selected?.deviceId || "";
      select.disabled = devices.length === 0 || cameraCaptureState.startPending;
      if (devices.length === 0) {
        const option = document.createElement("option");
        option.textContent = "No cameras found";
        select.appendChild(option);
      }
    } catch (err) {
      setCameraStatus(cameraErrorMessage(err), "error");
    }
  }

  async function startCameraStream(deviceId = cameraCaptureState.selectedDeviceId) {
    const overlay = cameraCaptureState.overlay;
    if (!overlay || !cameraCaptureState.target) return;

    const requestId = ++cameraCaptureState.requestId;
    const startBtn = overlay.querySelector(".camera-start-btn");
    const captureBtn = overlay.querySelector(".camera-take-btn");
    const deviceSelect = overlay.querySelector(".camera-device-select");
    const video = overlay.querySelector(".camera-preview-video");
    const selectedLabel = deviceSelect.selectedOptions[0]?.textContent || "camera";
    cameraCaptureState.selectedDeviceId = deviceId || "";
    cameraCaptureState.startPending = true;
    releaseCameraStream();
    clearCameraStill();
    startBtn.disabled = true;
    deviceSelect.disabled = true;
    captureBtn.disabled = true;
    video.classList.add("hidden");
    setCameraStatus(`Starting ${selectedLabel}… Some cameras take a few seconds to wake.`);

    const videoConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920, max: MAX_DIMENSION }, height: { ideal: 1080, max: MAX_DIMENSION } }
      : { width: { ideal: 1920, max: MAX_DIMENSION }, height: { ideal: 1080, max: MAX_DIMENSION } };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      if (requestId !== cameraCaptureState.requestId || !cameraCaptureState.overlay) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      cameraCaptureState.stream = stream;
      const track = stream.getVideoTracks()[0];
      cameraCaptureState.selectedDeviceId = track?.getSettings().deviceId || cameraCaptureState.selectedDeviceId;
      video.srcObject = stream;
      video.classList.remove("hidden");
      await video.play();
      if (requestId !== cameraCaptureState.requestId || overlay !== cameraCaptureState.overlay) return;
      track?.addEventListener("ended", () => {
        if (cameraCaptureState.stream !== stream) return;
        captureBtn.disabled = true;
        setCameraStatus("The camera stopped. Start it again to continue.", "error");
      }, { once: true });
      startBtn.textContent = "Switch / restart camera";
      captureBtn.disabled = false;
      setCameraStatus("Camera preview is live. Capture is ready; video stays local until you choose Use photo.", "success");
      captureBtn.focus();
      void populateCameraDevices();
    } catch (err) {
      if (requestId !== cameraCaptureState.requestId) return;
      releaseCameraStream();
      captureBtn.disabled = true;
      setCameraStatus(cameraErrorMessage(err), "error");
    } finally {
      if (requestId === cameraCaptureState.requestId && cameraCaptureState.overlay) {
        cameraCaptureState.startPending = false;
        startBtn.disabled = false;
        void populateCameraDevices();
      }
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode the captured frame."));
      }, type, quality);
    });
  }

  function isCurrentCameraOperation(operation) {
    return operation.requestId === cameraCaptureState.requestId &&
      operation.overlay === cameraCaptureState.overlay &&
      operation.target === cameraCaptureState.target;
  }

  async function captureCameraFrame() {
    const operation = {
      requestId: cameraCaptureState.requestId,
      overlay: cameraCaptureState.overlay,
      target: cameraCaptureState.target,
    };
    const video = operation.overlay?.querySelector(".camera-preview-video");
    const takeBtn = operation.overlay?.querySelector(".camera-take-btn");
    if (!operation.overlay || !operation.target || !video || !takeBtn || !cameraCaptureState.stream) return;
    if (!video.videoWidth || !video.videoHeight) {
      setCameraStatus("The camera preview is not ready yet.", "error");
      return;
    }

    takeBtn.disabled = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The browser could not prepare the camera canvas.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
      if (!isCurrentCameraOperation(operation)) return;

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = new File([blob], `camera-${stamp}.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
      const validation = await validateImage(file);
      if (!isCurrentCameraOperation(operation)) return;
      if (!validation.valid) {
        setCameraStatus(validation.error, "error");
        return;
      }

      clearCameraStill();
      cameraCaptureState.pendingFile = file;
      cameraCaptureState.pendingUrl = URL.createObjectURL(file);
      const still = operation.overlay.querySelector(".camera-captured-image");
      still.src = cameraCaptureState.pendingUrl;
      still.classList.remove("hidden");
      video.classList.add("hidden");
      video.pause();
      takeBtn.classList.add("hidden");
      const retakeBtn = operation.overlay.querySelector(".camera-retake-btn");
      const useBtn = operation.overlay.querySelector(".camera-use-btn");
      retakeBtn.disabled = false;
      useBtn.disabled = false;
      retakeBtn.classList.remove("hidden");
      useBtn.classList.remove("hidden");
      setCameraStatus(`Captured ${canvas.width}×${canvas.height} JPEG (${Math.ceil(file.size / 1024)} KB). Review it before use.`, "success");
      operation.overlay.querySelector(".camera-use-btn").focus();
    } catch (err) {
      if (isCurrentCameraOperation(operation)) {
        setCameraStatus(cameraErrorMessage(err), "error");
      }
    } finally {
      if (isCurrentCameraOperation(operation) && !cameraCaptureState.pendingFile) {
        takeBtn.disabled = false;
      }
    }
  }

  function retakeCameraFrame() {
    const overlay = cameraCaptureState.overlay;
    if (!overlay || !cameraCaptureState.stream) return;
    cameraCaptureState.requestId += 1;
    clearCameraStill();
    const video = overlay.querySelector(".camera-preview-video");
    const takeBtn = overlay.querySelector(".camera-take-btn");
    overlay.querySelector(".camera-captured-image").classList.add("hidden");
    video.classList.remove("hidden");
    video.play().catch((err) => setCameraStatus(cameraErrorMessage(err), "error"));
    overlay.querySelector(".camera-retake-btn").classList.add("hidden");
    overlay.querySelector(".camera-use-btn").classList.add("hidden");
    takeBtn.disabled = false;
    takeBtn.classList.remove("hidden");
    setCameraStatus("Camera preview is live. Capture when ready.", "success");
  }

  async function checkImageFile(questionId, file) {
    if (countUploadedFiles(questionId) + 1 > MAX_IMAGES) {
      return { valid: false, error: `Only ${MAX_IMAGES} images allowed.` };
    }

    try {
      return await validateImage(file);
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Failed to validate image.",
      };
    }
  }

  async function acceptImageFile(questionId, file, manager) {
    const result = await checkImageFile(questionId, file);
    if (!result.valid) {
      setFieldError(questionId, result.error);
      return result;
    }
    setFieldError(questionId, "");
    manager.addFile(questionId, file);
    return result;
  }

  async function useCameraFrame() {
    const operation = {
      requestId: cameraCaptureState.requestId,
      overlay: cameraCaptureState.overlay,
      target: cameraCaptureState.target,
      file: cameraCaptureState.pendingFile,
    };
    const useBtn = operation.overlay?.querySelector(".camera-use-btn");
    const retakeBtn = operation.overlay?.querySelector(".camera-retake-btn");
    if (!operation.overlay || !operation.target || !operation.file || !useBtn || !retakeBtn) return;

    useBtn.disabled = true;
    retakeBtn.disabled = true;
    const result = await checkImageFile(operation.target.questionId, operation.file);
    if (!isCurrentCameraOperation(operation) || operation.file !== cameraCaptureState.pendingFile) return;
    if (!result.valid) {
      setFieldError(operation.target.questionId, result.error);
      setCameraStatus(result.error || "Captured image was rejected.", "error");
      useBtn.disabled = false;
      retakeBtn.disabled = false;
      return;
    }

    setFieldError(operation.target.questionId, "");
    operation.target.manager.addFile(operation.target.questionId, operation.file);
    operation.target.onAccept?.();
    closeCameraCapture();
  }

  function trapCameraFocus(event, dialog) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialog.querySelectorAll(
      'button:not([disabled]):not(.hidden), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openCameraCapture(questionId, manager, opener, options = {}) {
    const unavailable = cameraUnavailableMessage();
    if (unavailable) {
      setFieldError(questionId, unavailable);
      return;
    }

    closeCameraCapture({ restoreFocus: false });
    setFieldError(questionId, "");
    cameraCaptureState.opener = opener;
    cameraCaptureState.target = { questionId, manager, onAccept: options.onAccept };

    const overlay = document.createElement("div");
    overlay.className = "camera-capture-overlay";
    overlay.innerHTML = `
      <section class="camera-capture-dialog" role="dialog" aria-modal="true" aria-labelledby="camera-capture-title" aria-describedby="camera-capture-help">
        <header class="camera-capture-header">
          <div>
            <h2 id="camera-capture-title">Capture an image</h2>
            <p id="camera-capture-help">Choose Start camera, select a video input such as OBSBOT Virtual Camera, then capture and review one still image.</p>
          </div>
          <button type="button" class="camera-close-btn" aria-label="Close camera">×</button>
        </header>
        <div class="camera-device-row">
          <label for="camera-device-select">Camera</label>
          <select id="camera-device-select" class="camera-device-select" disabled>
            <option>Looking for cameras…</option>
          </select>
          <button type="button" class="btn-primary camera-start-btn">Start camera</button>
        </div>
        <div class="camera-preview-shell">
          <div class="camera-preview-placeholder">Camera is off</div>
          <video class="camera-preview-video hidden" autoplay muted playsinline></video>
          <img class="camera-captured-image hidden" alt="Captured camera still preview">
        </div>
        <p class="camera-capture-privacy">No audio is requested. Nothing is attached until you choose Use photo.</p>
        <p class="camera-capture-status" role="status" aria-live="polite">Camera access has not started.</p>
        <footer class="camera-capture-actions">
          <button type="button" class="btn-secondary camera-cancel-btn">Cancel</button>
          <button type="button" class="btn-secondary camera-retake-btn hidden">Retake</button>
          <button type="button" class="btn-primary camera-take-btn" disabled>Capture</button>
          <button type="button" class="btn-primary camera-use-btn hidden">Use photo</button>
        </footer>
      </section>`;

    cameraCaptureState.overlay = overlay;
    document.body.classList.add("camera-capture-open");
    document.body.appendChild(overlay);
    const dialog = overlay.querySelector(".camera-capture-dialog");
    const startBtn = overlay.querySelector(".camera-start-btn");
    const deviceSelect = overlay.querySelector(".camera-device-select");
    const close = () => closeCameraCapture();

    overlay.querySelector(".camera-close-btn").addEventListener("click", close);
    overlay.querySelector(".camera-cancel-btn").addEventListener("click", close);
    overlay.querySelector(".camera-take-btn").addEventListener("click", captureCameraFrame);
    overlay.querySelector(".camera-retake-btn").addEventListener("click", retakeCameraFrame);
    overlay.querySelector(".camera-use-btn").addEventListener("click", useCameraFrame);
    startBtn.addEventListener("click", () => startCameraStream(cameraCaptureState.selectedDeviceId));
    deviceSelect.addEventListener("change", () => {
      cameraCaptureState.selectedDeviceId = deviceSelect.value;
      if (cameraCaptureState.stream) {
        startBtn.textContent = "Switch camera";
        setCameraStatus(`Selected ${deviceSelect.selectedOptions[0]?.textContent || "camera"}. Choose Switch camera to apply it.`);
      }
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      trapCameraFocus(event, dialog);
      event.stopPropagation();
    });
    if (typeof navigator.mediaDevices.addEventListener === "function") {
      cameraCaptureState.deviceChangeHandler = () => populateCameraDevices();
      navigator.mediaDevices.addEventListener("devicechange", cameraCaptureState.deviceChangeHandler);
    }
    void populateCameraDevices();
    startBtn.focus();
  }

  function createCameraButton(questionId, manager, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-secondary camera-open-btn";
    button.textContent = "Use camera";
    const unavailable = cameraUnavailableMessage();
    if (unavailable) {
      button.classList.add("camera-unavailable");
      button.title = unavailable;
    }
    button.addEventListener("click", () => openCameraCapture(questionId, manager, button, options));
    return button;
  }

  function clearImage(id) {
    const input = document.querySelector(
      `input[type="file"][data-question-id="${escapeSelector(id)}"]`
    );
    if (input) input.value = "";
    questionImages.removeFile(id);
    setFieldError(id, "");
  }

  async function handleFileChange(questionId, input, manager, options = {}) {
    const { onEmpty } = options;
    setFieldError(questionId, "");

    const file = input.files && input.files[0];
    if (!file) {
      if (onEmpty) onEmpty();
      else manager.removeFile(questionId);
      return;
    }

    const result = await acceptImageFile(questionId, file, manager);
    if (!result.valid) input.value = "";
  }

  function revealAttachmentArea(questionId) {
    const attachInline = document.querySelector(
      `[data-attach-inline-for="${escapeSelector(questionId)}"]`
    );
    if (!attachInline?.classList.contains("hidden")) return;
    attachInline.classList.remove("hidden");
  }

  async function addDroppedImage(question, file) {
    const manager = question.type === "image" ? questionImages : attachments;
    const result = await acceptImageFile(question.id, file, manager);
    if (result.valid && question.type !== "image") {
      revealAttachmentArea(question.id);
    }
  }

  function countUploadedFiles(excludingId) {
    let count = 0;
    imageState.forEach((_value, key) => {
      if (key !== excludingId) count += 1;
    });
    attachState.forEach((_value, key) => {
      if (key !== excludingId) count += 1;
    });
    return count;
  }

  function getOtherValue(questionId) {
    const otherInput = formEl.querySelector(`.other-input[data-question-id="${escapeSelector(questionId)}"]`);
    return otherInput ? otherInput.value : "";
  }

  function getQuestionValue(question) {
    const id = question.id;
    if (question.type === "single") {
      const selected = formEl.querySelector(`input[name="${escapeSelector(id)}"]:checked`);
      if (!selected) return "";
      if (selected.value === "__other__") {
        const otherValue = getOtherValue(id).trim();
        return otherValue ? { option: otherValue } : "";
      }
      const note = questionSupportsOptionInsights(question) ? getChoiceNote(id, selected.value) : "";
      return note ? { option: selected.value, note } : { option: selected.value };
    }
    if (question.type === "multi") {
      return Array.from(
        formEl.querySelectorAll(`input[name="${escapeSelector(id)}"]:checked`)
      ).map((input) => {
        if (input.value === "__other__") {
          const otherValue = getOtherValue(id).trim();
          return otherValue ? { option: otherValue } : null;
        }
        const note = questionSupportsOptionInsights(question) ? getChoiceNote(id, input.value) : "";
        return note ? { option: input.value, note } : { option: input.value };
      }).filter((value) => value && value.option);
    }
    if (question.type === "text") {
      const textarea = formEl.querySelector(`textarea[data-question-id="${escapeSelector(id)}"]`);
      return textarea ? textarea.value : "";
    }
    if (question.type === "image") {
      return questionImages.getPaths(id);
    }
    return "";
  }

  function collectResponses() {
    return questions
      .filter((question) => question.type !== "info")
      .map((question) => {
        const resp = { id: question.id, value: getQuestionValue(question) };
        if (question.type !== "image") {
          const attachPaths = attachments.getPaths(question.id);
          if (attachPaths.length > 0) resp.attachments = attachPaths;
        }
        return resp;
      });
  }

  function collectPersistedData() {
    const answers = {};
    questions.forEach((question) => {
      if (question.type === "info" || question.type === "image") return;
      answers[question.id] = getQuestionValue(question);
    });
    return {
      answers,
      savedOptionInsights: serializeSavedOptionInsights(),
    };
  }

  function getSavedSingleChoiceValue(value) {
    return normalizeChoiceResponseValue(value);
  }

  function getSavedMultiChoiceValues(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => normalizeChoiceResponseValue(item)).filter(Boolean);
  }

  function populateQuestion(question, saved, options = {}) {
    const { preserveChoiceNotes = false } = options;
    const hasSavedValue = saved && Object.prototype.hasOwnProperty.call(saved, question.id);
    const value = hasSavedValue ? saved[question.id] : undefined;

    if (question.type === "single") {
      if (!hasSavedValue) return;
      const radios = formEl.querySelectorAll(
        `input[name="${escapeSelector(question.id)}"]`
      );
      radios.forEach((radio) => {
        radio.checked = false;
      });
      if (!preserveChoiceNotes) {
        clearChoiceNotes(question.id);
      }
      const choiceValue = getSavedSingleChoiceValue(value);
      if (!choiceValue) return;
      if (choiceValue.option !== "") {
        const input = formEl.querySelector(
          `input[name="${escapeSelector(question.id)}"][value="${escapeSelector(choiceValue.option)}"]`
        );
        if (input) {
          input.checked = true;
          if (questionSupportsOptionInsights(question) && choiceValue.note) {
            setChoiceNote(question.id, choiceValue.option, choiceValue.note);
          }
        } else {
          const otherCheck = formEl.querySelector(
            `input[name="${escapeSelector(question.id)}"][value="__other__"]`
          );
          const otherInput = formEl.querySelector(
            `.other-input[data-question-id="${escapeSelector(question.id)}"]`
          );
          if (otherCheck && otherInput) {
            otherCheck.checked = true;
            otherInput.value = choiceValue.option;
            otherInput.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
      return;
    }

    if (question.type === "multi") {
      if (!hasSavedValue) return;
      const checkboxes = formEl.querySelectorAll(
        `input[name="${escapeSelector(question.id)}"]`
      );
      checkboxes.forEach((checkbox) => {
        checkbox.checked = false;
      });
      if (!preserveChoiceNotes) {
        clearChoiceNotes(question.id);
      }
      const choiceValues = getSavedMultiChoiceValues(value);
      let otherValue = "";
      choiceValues.forEach((choiceValue) => {
        const input = formEl.querySelector(
          `input[name="${escapeSelector(question.id)}"][value="${escapeSelector(choiceValue.option)}"]`
        );
        if (input) {
          input.checked = true;
          if (questionSupportsOptionInsights(question) && choiceValue.note) {
            setChoiceNote(question.id, choiceValue.option, choiceValue.note);
          }
        } else if (choiceValue.option) {
          otherValue = choiceValue.option;
        }
      });
      if (otherValue) {
        const otherCheck = formEl.querySelector(
          `input[name="${escapeSelector(question.id)}"][value="__other__"]`
        );
        const otherInput = formEl.querySelector(
          `.other-input[data-question-id="${escapeSelector(question.id)}"]`
        );
        if (otherCheck && otherInput) {
          otherCheck.checked = true;
          otherInput.value = otherValue;
          otherInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      return;
    }

    if (question.type === "text" && hasSavedValue && typeof value === "string") {
      const textarea = formEl.querySelector(
        `textarea[data-question-id="${escapeSelector(question.id)}"]`
      );
      if (textarea) textarea.value = value;
    }
  }

  function populateForm(saved, options = {}) {
    if (!saved) return;
    questions.forEach((question) => {
      populateQuestion(question, saved, options);
    });
  }

  function saveProgress() {
    if (!session.storageKey) return;
    const data = collectPersistedData();
    try {
      localStorage.setItem(session.storageKey, JSON.stringify(data));
    } catch (_err) {
      // ignore storage errors
    }
  }

  function rerenderChoiceQuestions() {
    questions.forEach((question) => {
      if (question.type !== "single" && question.type !== "multi") return;
      replaceQuestionOptionList(question, getQuestionValue(question));
    });
  }

  function loadProgress() {
    if (!session.storageKey) return;
    let loaded = false;
    try {
      const saved = localStorage.getItem(session.storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        const answers = parsed && typeof parsed === "object" && parsed.answers && typeof parsed.answers === "object"
          ? parsed.answers
          : parsed;
        populateForm(answers);
        restoreSavedOptionInsights(parsed?.savedOptionInsights);
        questions.forEach((q) => {
          if (q.type === "multi") updateDoneState(q.id);
        });
        rerenderChoiceQuestions();
        loaded = true;
      }
    } catch (_err) {
      // ignore storage errors
    }
    if (!loaded) {
      questions.forEach(q => {
        if (q.type !== "multi") return;
        const recs = Array.isArray(q.recommended) ? q.recommended : q.recommended ? [q.recommended] : [];
        if (recs.length > 0 && q.conviction !== "slight") {
          updateDoneState(q.id);
        }
      });
    }
  }

  function clearProgress() {
    if (!session.storageKey) return;
    try {
      localStorage.removeItem(session.storageKey);
    } catch (_err) {
      // ignore storage errors
    }
  }

  async function hashQuestions() {
    const json = JSON.stringify(questions);
    const encoder = new TextEncoder();
    const data = encoder.encode(json);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return hashHex.slice(0, 8);
  }

  async function initStorage() {
    try {
      const hash = await hashQuestions();
      session.storageKey = `pi-interview-${hash}`;
      loadProgress();
    } catch (_err) {
      session.storageKey = null;
    }
  }

  // Set storage key without loading (for revival from saved interview)
  async function initStorageKeyOnly() {
    try {
      const hash = await hashQuestions();
      session.storageKey = `pi-interview-${hash}`;
    } catch (_err) {
      session.storageKey = null;
    }
  }

  function populateFromSavedAnswers(savedAnswers) {
    const valueMap = {};
    savedAnswers.forEach((ans) => {
      const question = questions.find((q) => q.id === ans.id);
      if (question?.type !== "image") {
        valueMap[ans.id] = ans.value;
      }
    });
    populateForm(valueMap);

    savedAnswers.forEach((ans) => {
      if (ans.attachments && ans.attachments.length > 0) {
        attachPathState.set(ans.id, [...ans.attachments]);
        attachments.render(ans.id);
        const panel = document.querySelector(
          `[data-attach-inline-for="${escapeSelector(ans.id)}"]`
        );
        if (panel) panel.classList.remove("hidden");
        const btn = document.querySelector(
          `.attach-btn[data-question-id="${escapeSelector(ans.id)}"]`
        );
        if (btn) btn.classList.add("has-attachment");
      }
    });

    savedAnswers.forEach((ans) => {
      const question = questions.find((q) => q.id === ans.id);
      if (question?.type === "image" && ans.value) {
        const paths = Array.isArray(ans.value) ? ans.value : [ans.value];
        const validPaths = paths.filter((p) => typeof p === "string" && p);
        if (validPaths.length > 0) {
          imagePathState.set(ans.id, validPaths);
          questionImages.render(ans.id);
        }
      }
    });

    questions.forEach((q) => {
      if (q.type === "multi") {
        updateDoneState(q.id);
      }
    });
    rerenderChoiceQuestions();
  }

  function populateFromSavedOptionInsights(savedOptionInsights) {
    restoreSavedOptionInsights(savedOptionInsights);
    rerenderChoiceQuestions();
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error(`Failed to read file: unexpected FileReader result type ${typeof reader.result}`));
          return;
        }
        const parts = reader.result.split(",");
        resolve(parts[1] || "");
      };
      reader.onerror = () => reject(new Error(reader.error?.message || "Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  async function buildPayload() {
    const responses = collectResponses();
    const images = [];

    for (const question of questions) {
      const imageEntry = questionImages.getFile(question.id);
      if (imageEntry) {
        const file = imageEntry.file;
        const data = await readFileBase64(file);
        images.push({
          id: question.id,
          filename: file.name,
          mimeType: file.type,
          data,
        });
      }

      if (question.type !== "image") {
        const attachEntry = attachments.getFile(question.id);
        if (attachEntry) {
          const file = attachEntry.file;
          const data = await readFileBase64(file);
          images.push({
            id: question.id,
            filename: file.name,
            mimeType: file.type,
            data,
            isAttachment: true,
          });
        }
      }
    }

    return { responses, images };
  }

  async function saveInterview(options = {}) {
    const { submitted = false } = options;

    try {
      const payload = await buildPayload();
      const response = await fetch("/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: sessionToken,
          responses: payload.responses,
          images: payload.images,
          savedOptionInsights: serializeSavedOptionInsights(),
          submitted,
        }),
      });
      const result = await response.json();
      if (result.ok) {
        showSaveSuccess(result.relativePath);
        return true;
      } else {
        if (!submitted) showSaveError(result.error);
        return false;
      }
    } catch (err) {
      if (!submitted) {
        const message = err instanceof Error ? err.message : String(err);
        showSaveError(`Failed to save interview: ${message}`);
      }
      return false;
    }
  }

  function showSaveSuccess(savePath) {
    const toast = document.getElementById("save-toast");
    if (!toast) return;
    toast.textContent = `Saved to ${savePath}`;
    toast.className = "save-toast success";
    setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  function showSaveError(message) {
    const toast = document.getElementById("save-toast");
    if (!toast) return;
    toast.textContent = message || "Save failed";
    toast.className = "save-toast error";
    setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  async function submitForm(event) {
    event.preventDefault();
    closeCameraCapture({ restoreFocus: false });
    clearGlobalError();
    clearFieldErrors();

    submitBtn.disabled = true;

    try {
      const payload = await buildPayload();
      const response = await fetch("/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: sessionToken, ...payload }),
      });

      let submitResult;
      try {
        submitResult = await response.json();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showGlobalError(`Invalid server response: ${message}`);
        submitBtn.disabled = false;
        return;
      }

      if (!response.ok || !submitResult.ok) {
        if (submitResult.field) {
          setFieldError(submitResult.field, submitResult.error || "Invalid input");
        } else {
          showGlobalError(submitResult.error || "Submission failed.");
        }
        submitBtn.disabled = false;
        return;
      }

      if (data.autoSaveOnSubmit !== false) {
        saveInterview({ submitted: true });
      }

      clearProgress();
      stopHeartbeat();
      stopQueuePolling();
      session.ended = true;

      if (submitResult.nextUrl) {
        window.location.href = submitResult.nextUrl;
        return;
      }

      successOverlay.classList.remove("hidden");
      completionPending = true;
      setTimeout(() => closeWindow(), 800);
      // In-app browsers (Moshi) and tabs we didn't open ignore window.close().
      // If we're still here after the close attempt, tell the user the ball is
      // back in the terminal. The visibility listener handles pages that were
      // backgrounded when this timer fired.
      setTimeout(() => {
        if (!document.hidden) {
          showCloseFallback();
        }
      }, 1200);
    } catch (err) {
      if (isNetworkError(err)) {
        showSessionExpired();
      } else {
        const message = err instanceof Error ? err.message : String(err);
        showGlobalError(`Failed to submit responses: ${message}`);
        submitBtn.disabled = false;
      }
    }
  }

  function init() {
    initTheme();
    clearReloadIntent();
    normalizeOptionKeysFromData();

    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    document.querySelectorAll(".mod-key").forEach((modKey) => {
      modKey.textContent = isMac ? "⌘" : "Ctrl";
    });
    
    setText(titleEl, data.title || "Interview");
    setText(descriptionEl, data.description || "");

    const sessionProjectEl = document.getElementById("session-project");
    const sessionIdEl = document.getElementById("session-id");
    if (sessionProjectEl && cwd) {
      const pathDisplay = cwd.length > 40 ? "..." + cwd.slice(-37) : cwd;
      const branchSuffix = gitBranch ? ` (${gitBranch})` : "";
      sessionProjectEl.textContent = pathDisplay + branchSuffix;
    }
    if (sessionIdEl && sessionId) {
      sessionIdEl.textContent = sessionId.slice(0, 8);
    }
    const projectName = cwd.split("/").filter(Boolean).pop() || "interview";
    const shortId = sessionId.slice(0, 8);
    document.title = `${projectName}${gitBranch ? ` (${gitBranch})` : ""} | ${shortId}`;

    let badgeCount = 0;
    questions.forEach((question, index) => {
      const showBadge = question.type !== "info";
      if (showBadge) badgeCount++;
      containerEl.appendChild(createQuestionCard(question, index, showBadge ? badgeCount : null));
    });

    // Pre-populate: savedAnswers takes precedence over localStorage
    if (data.savedAnswers && Array.isArray(data.savedAnswers)) {
      populateFromSavedAnswers(data.savedAnswers);
      if (Array.isArray(data.savedOptionInsights)) {
        populateFromSavedOptionInsights(data.savedOptionInsights);
      }
      initStorageKeyOnly();
    } else {
      initStorage();
    }

    startHeartbeat();
    startQueuePolling();

    formEl.addEventListener("submit", submitForm);

    // Wire up save buttons
    const saveBtnHeader = document.getElementById("save-btn-header");
    const saveBtnFooter = document.getElementById("save-btn-footer");
    if (saveBtnHeader) {
      saveBtnHeader.addEventListener("click", () => saveInterview());
    }
    if (saveBtnFooter) {
      saveBtnFooter.addEventListener("click", () => saveInterview());
    }
    if (queueToastClose) {
      queueToastClose.addEventListener("click", () => {
        queueState.dismissed = true;
        queueToast?.classList.add("hidden");
      });
    }

    if (queueSessionSelect && queueOpenBtn) {
      queueSessionSelect.addEventListener("change", () => {
        const selectedOption = queueSessionSelect.options[queueSessionSelect.selectedIndex];
        queueOpenBtn.disabled = !queueSessionSelect.value || selectedOption?.disabled;
      });
      queueOpenBtn.addEventListener("click", () => {
        closeCameraCapture({ restoreFocus: false });
        const url = queueSessionSelect.value;
        if (!url) return;
        const selectedOption = queueSessionSelect.options[queueSessionSelect.selectedIndex];
        if (selectedOption?.disabled) return;
        const opened = window.open(url, "_blank", "noopener");
        if (!opened) {
          window.location.href = url;
        }
      });
    }
    window.addEventListener("pagehide", (event) => {
      closeCameraCapture({ restoreFocus: false });
      if (session.ended) return;
      if (event.persisted) return;
      if (hasReloadIntent()) return;
      sendCancelBeacon("user");
    });

    window.addEventListener(
      "keydown",
      (event) => {
        const key = event.key.toLowerCase();
        if ((event.metaKey || event.ctrlKey) && key === "r") {
          markReloadIntent();
        } else if (event.key === "F5") {
          markReloadIntent();
        }
      },
      true
    );
    submitBtn.addEventListener("keydown", (e) => {
      if (isQuestionNavShortcut(e, "prev") || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        focusQuestion(nav.cards.length - 1, 'prev');
      }
    });
    
    closeTabBtn.addEventListener("click", async () => {
      if (timers.countdown) clearInterval(timers.countdown);
      await cancelInterview("user");
      closeWindow();
    });

    stayBtn.addEventListener("click", () => {
      if (timers.countdown) clearInterval(timers.countdown);
      expiredOverlay.classList.remove("visible");
      expiredOverlay.classList.add("hidden");
      
      session.expired = false;
      submitBtn.disabled = false;
      
      if (timeout > 0) {
        startCountdownDisplay();
        scheduleExpirationCheck();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (expiredOverlay.classList.contains("visible")) {
        if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          if (document.activeElement === stayBtn) {
            closeTabBtn.focus();
          } else {
            stayBtn.focus();
          }
        }
      }
    }, true);
    if (timeout > 0) {
      startCountdownDisplay();
      scheduleExpirationCheck();

      ["click", "keydown", "input", "change"].forEach(event => {
        formEl.addEventListener(event, refreshCountdown, { passive: true });
      });
      document.addEventListener("mousemove", refreshCountdown, { passive: true });
    }

    initQuestionNavigation();

    if (typeof mermaid !== "undefined") {
      const isDark = document.documentElement.dataset.theme === "dark" ||
        (!document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
      });
      mermaid.run();
    }
  }

  window.__INTERVIEW_API__ = {
    questions,
    nav,
    formEl,
    sessionToken,
    data,
    focusQuestion,
    getQuestionValue,
    debounceSave,
    escapeSelector,
    populateForm,
    updateDoneState,
    setFieldError,
    clearFieldErrors,
  };

  init();
})();
