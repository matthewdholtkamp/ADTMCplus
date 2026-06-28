// ADTMC+ Ask Dr. Holtkamp clinical navigator.
// This feature reads the existing algorithms and may navigate to their entry points,
// but it never changes answers, checkboxes, dispositions, or clinical state.
(() => {
  "use strict";

  const DEFAULT_WORKER_URL = "https://adtmcplus-clinical-ai.mholtkamp.workers.dev/v1/ask";
  const MAX_QUESTION_LENGTH = 3000;
  const MAX_HISTORY_MESSAGES = 8;
  const MAX_CANDIDATES = 5;
  const STOP_WORDS = new Set([
    "a", "an", "and", "are", "at", "be", "for", "from", "has", "have", "i", "in", "is",
    "it", "me", "my", "of", "on", "or", "patient", "show", "the", "this", "to", "what",
    "where", "which", "with", "you"
  ]);

  const state = {
    isOpen: false,
    isSending: false,
    entries: [],
    history: [],
    contextObserver: null,
    contextRefreshTimer: null,
    els: {}
  };

  const PHI_RULES = [
    {
      label: "email address",
      pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
    },
    {
      label: "phone number",
      pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/
    },
    {
      label: "Social Security number",
      pattern: /\b\d{3}-\d{2}-\d{4}\b/
    },
    {
      label: "DoD ID or other 10-digit identifier",
      pattern: /\b\d{10}\b/
    },
    {
      label: "medical record or patient identifier",
      pattern: /\b(?:mrn|medical\s+record|patient\s+id|dod\s+id|edipi)\s*[:#-]?\s*[A-Z0-9-]{5,}\b/i
    },
    {
      label: "date of birth",
      pattern: /\b(?:dob|date\s+of\s+birth|born)\s*[:#-]?\s*(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})\b/i
    },
    {
      label: "exact calendar date",
      pattern: /\b(?:(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}|(?:19|20)\d{2}-\d{2}-\d{2})\b/
    },
    {
      label: "street address",
      pattern: /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct|way)\b/i
    },
    {
      label: "ZIP code",
      pattern: /\b\d{5}(?:-\d{4})?\b/
    },
    {
      label: "rank and name",
      pattern: /\b(?:PVT|PV2|PFC|SPC|CPL|SGT|SSG|SFC|MSG|1SG|SGM|CSM|WO1|CW2|CW3|CW4|CW5|2LT|1LT|CPT|MAJ|LTC|COL)\s+[A-Z][a-z][A-Za-z'-]{1,}\b/
    },
    {
      label: "patient name",
      pattern: /\b(?:(?:[Pp]atient|[Nn]ame)\s*(?:is|:)\s*[A-Z][A-Za-z'-]{1,}(?:\s+[A-Z][A-Za-z'-]{1,})?|[Pp]atient\s+[A-Z][A-Za-z'-]{1,}\s+[A-Z][A-Za-z'-]{1,})\b/
    }
  ];

  function stripHtml(value) {
    const template = document.createElement("template");
    template.innerHTML = String(value || "");
    return (template.content.textContent || "").replace(/\s+/g, " ").trim();
  }

  function sanitizeClinicalValue(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "function") {
      return `[runtime branch: ${String(value).replace(/\s+/g, " ").slice(0, 500)}]`;
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeClinicalValue(item, seen));
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const result = {};
      Object.entries(value).forEach(([key, item]) => {
        result[key] = sanitizeClinicalValue(item, seen);
      });
      seen.delete(value);
      return result;
    }
    return String(value);
  }

  function collectSearchText(value, output = []) {
    if (value === null || value === undefined) return output;
    if (typeof value === "string") {
      output.push(stripHtml(value));
      return output;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      output.push(String(value));
      return output;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectSearchText(item, output));
      return output;
    }
    if (typeof value === "object") {
      Object.values(value).forEach((item) => collectSearchText(item, output));
    }
    return output;
  }

  function buildAlgorithmEntries() {
    const entries = [];

    if (typeof adtmcProtocols !== "undefined") {
      Object.entries(adtmcProtocols).forEach(([categoryId, category]) => {
        Object.entries(category.protocols || {}).forEach(([protocolId, protocol]) => {
          const content = sanitizeClinicalValue(protocol);
          const categoryName = category.category || categoryId;
          const searchText = collectSearchText({
            protocolId,
            categoryName,
            content
          }).join(" ").toLowerCase();

          entries.push({
            tool: "adtmc",
            id: protocolId,
            title: protocol.title || protocolId,
            category: categoryName,
            content: {
              protocolId,
              category: categoryName,
              ...content
            },
            searchText
          });
        });
      });
    }

    if (typeof algorithms !== "undefined") {
      Object.entries(algorithms).forEach(([protocolId, protocol]) => {
        const toolIds = new Set();
        Object.values(protocol.nodes || {}).forEach((node) => {
          (node.tools || []).forEach((toolId) => toolIds.add(toolId));
        });

        const tools = {};
        toolIds.forEach((toolId) => {
          if (typeof clinicalTools !== "undefined" && clinicalTools[toolId]) {
            tools[toolId] = sanitizeClinicalValue(clinicalTools[toolId]);
          }
        });

        const references = typeof bibliographicReferences !== "undefined"
          ? [
              ...(bibliographicReferences.overall || []),
              ...(bibliographicReferences[protocolId] || [])
            ]
          : [];

        const content = {
          protocolId,
          title: protocol.title || protocolId,
          nodes: sanitizeClinicalValue(protocol.nodes || {}),
          clinicalTools: tools,
          references: sanitizeClinicalValue(references)
        };

        entries.push({
          tool: "msk",
          id: protocolId,
          title: protocol.title || protocolId,
          category: "Musculoskeletal Screening",
          content,
          searchText: collectSearchText(content).join(" ").toLowerCase()
        });
      });
    }

    return entries;
  }

  function normalizeSearch(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function searchTokens(value) {
    return normalizeSearch(value)
      .split(" ")
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  }

  function getActiveProtocolId() {
    const active = document.querySelector(".app-container.active");
    if (!active) return "";

    if (active.id === "adtmc-app") {
      const title = document.getElementById("protocol-title")?.textContent || "";
      return title.match(/^([A-Z]-\d+):/)?.[1] || "";
    }

    if (active.id === "msk-app" && typeof algorithms !== "undefined") {
      try {
        if (typeof currentProtocol !== "undefined" && currentProtocol) {
          return Object.entries(algorithms).find(([, protocol]) => protocol === currentProtocol)?.[0] || "";
        }
      } catch (_) {
        // The MSK state may not be initialized yet.
      }
    }

    return "";
  }

  function rankAlgorithms(question, limit = MAX_CANDIDATES) {
    const normalized = normalizeSearch(question);
    const tokens = searchTokens(question);
    const activeProtocolId = getActiveProtocolId();

    return state.entries
      .map((entry) => {
        const id = normalizeSearch(entry.id);
        const title = normalizeSearch(entry.title);
        const category = normalizeSearch(entry.category);
        let score = 0;

        if (normalized === id || normalized.includes(id)) score += 120;
        if (normalized && title.includes(normalized)) score += 65;
        if (normalized && normalized.includes(title)) score += 55;
        if (normalized && category.includes(normalized)) score += 18;
        if (entry.id === activeProtocolId) score += 22;

        tokens.forEach((token) => {
          if (id === token) score += 30;
          if (title.includes(token)) score += 12;
          if (category.includes(token)) score += 5;
          if (entry.searchText.includes(token)) score += 1;
        });

        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
      .slice(0, limit);
  }

  function detectPhi(text) {
    const safeText = String(text || "")
      .replace(/\b(?:LTC|Dr\.?)\s+Holtkamp\b/gi, "assistant");
    const matches = PHI_RULES
      .filter((rule) => rule.pattern.test(safeText))
      .map((rule) => rule.label);
    return {
      detected: matches.length > 0,
      matches: [...new Set(matches)]
    };
  }

  function createButton(className, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "ask-dr-holtkamp-panel");
    button.addEventListener("click", open);
    return button;
  }

  function injectLaunchControls() {
    const toolGrid = document.querySelector("#landing-page .landing-hero > .grid");
    if (toolGrid && !document.getElementById("ask-landing-callout")) {
      const callout = document.createElement("section");
      callout.id = "ask-landing-callout";
      callout.className = "ask-landing-callout slide-in";
      callout.setAttribute("aria-label", "Ask Dr. Holtkamp clinical guidance");

      const title = document.createElement("h2");
      title.textContent = "Ask Dr. Holtkamp's Persona";
      callout.appendChild(title);
      callout.appendChild(createButton("ask-launch-pill", "Ask Dr. Holtkamp"));
      toolGrid.parentNode.insertBefore(callout, toolGrid);
    }

    document.querySelectorAll("#adtmc-app .back-to-home, #msk-app .back-to-home").forEach((homeButton) => {
      if (homeButton.parentElement?.classList.contains("ask-header-actions")) return;

      const wrapper = document.createElement("div");
      wrapper.className = "ask-header-actions";
      homeButton.parentNode.insertBefore(wrapper, homeButton);
      wrapper.appendChild(createButton("ask-header-launch", "Ask Dr. Holtkamp"));
      wrapper.appendChild(homeButton);
    });
  }

  function injectDrawer() {
    if (document.getElementById("ask-dr-holtkamp-panel")) return;

    const panel = document.createElement("section");
    panel.id = "ask-dr-holtkamp-panel";
    panel.className = "ask-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", "ask-panel-title");
    panel.innerHTML = `
      <div class="ask-panel-header">
        <div class="ask-header-title">
          <div class="ask-avatar" aria-hidden="true">★</div>
          <div>
            <div class="ask-panel-kicker">ADTMC+ Clinical AI</div>
            <h2 id="ask-panel-title">Ask Dr. Holtkamp</h2>
          </div>
        </div>
        <div class="ask-header-controls">
          <button class="ask-new-chat" id="ask-new-chat" type="button">New Chat</button>
          <button class="ask-close" id="ask-close" type="button" aria-label="Close assistant">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="ask-context" aria-live="polite">
        <span class="ask-context-label">Current page</span>
        <strong id="ask-context-value">ADTMC+ Home</strong>
      </div>
      <div class="ask-status" id="ask-status" role="status" aria-live="polite">
        Checking clinical AI service…
      </div>
      <div class="ask-messages" id="ask-messages" aria-live="polite"></div>
      <div class="ask-suggestions" id="ask-suggestions" aria-label="Questions for the current page"></div>
      <form class="ask-form" id="ask-form">
        <label class="sr-only" for="ask-input">Ask a de-identified clinical algorithm question</label>
        <div class="ask-attestation-card" id="ask-attestation-card" hidden>
          <div class="ask-attestation-copy">
            <strong>Confirm before sending</strong>
            <span>No names, IDs, dates of birth, contact details, addresses, or identifying dates.</span>
          </div>
          <label class="ask-attestation">
            <input id="ask-attestation" type="checkbox">
            <span>This message contains no PHI or identifying patient information.</span>
          </label>
        </div>
        <div class="ask-input-wrapper">
          <textarea id="ask-input" maxlength="${MAX_QUESTION_LENGTH}" rows="1"
            placeholder="Ask a de-identified clinical question…"></textarea>
          <button class="ask-send" id="ask-send" type="submit" disabled aria-label="Send question">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
        <div class="ask-input-error" id="ask-input-error" role="alert"></div>
      </form>
    `;

    document.body.appendChild(panel);

    state.els = {
      panel,
      close: panel.querySelector("#ask-close"),
      newChat: panel.querySelector("#ask-new-chat"),
      status: panel.querySelector("#ask-status"),
      contextValue: panel.querySelector("#ask-context-value"),
      messages: panel.querySelector("#ask-messages"),
      suggestions: panel.querySelector("#ask-suggestions"),
      form: panel.querySelector("#ask-form"),
      input: panel.querySelector("#ask-input"),
      send: panel.querySelector("#ask-send"),
      attestationCard: panel.querySelector("#ask-attestation-card"),
      attestation: panel.querySelector("#ask-attestation"),
      error: panel.querySelector("#ask-input-error")
    };
  }

  function bindEvents() {
    state.els.close.addEventListener("click", close);
    state.els.newChat.addEventListener("click", newChat);
    state.els.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void send();
    });
    state.els.input.addEventListener("input", () => {
      state.els.error.textContent = "";
      autoSizeInput();
      syncAttestationCard();
      updateSendState();
    });
    state.els.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (state.els.input.value.trim() && !state.els.attestation.checked) {
          requestAttestationAttention();
        } else if (!state.els.send.disabled) {
          void send();
        }
      }
    });
    state.els.attestation.addEventListener("change", () => {
      if (state.els.attestation.checked) state.els.error.textContent = "";
      syncAttestationCard();
      updateSendState();
    });
    state.els.suggestions.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("[data-ask-prompt]");
      if (!button) return;
      state.els.input.value = button.dataset.askPrompt || "";
      state.els.attestation.checked = false;
      state.els.error.textContent = "";
      autoSizeInput();
      syncAttestationCard();
      updateSendState();
      state.els.input.focus();
    });
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    document.addEventListener("click", scheduleContextRefresh);
    document.addEventListener("change", scheduleContextRefresh);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.isOpen) close();
    });

    state.contextObserver = new MutationObserver(scheduleContextRefresh);
    document.querySelectorAll(".app-container").forEach((container) => {
      state.contextObserver.observe(container, {
        attributes: true,
        attributeFilter: ["class"],
        childList: true,
        subtree: true
      });
    });
  }

  function setStatus(text, tone = "") {
    state.els.status.textContent = text;
    state.els.status.className = `ask-status ${tone}`.trim();
    state.els.status.hidden = tone === "ready" || !text;
  }

  function updateConnectivity() {
    if (!navigator.onLine) {
      setStatus("Offline — local pathway finder available", "offline");
      return;
    }
    if (!state.isSending) {
      setStatus("Ready — code-grounded clinical guidance", "ready");
    }
  }

  async function probeWorker() {
    if (!navigator.onLine) {
      updateConnectivity();
      return;
    }

    try {
      const healthUrl = new URL(DEFAULT_WORKER_URL);
      healthUrl.pathname = "/health";
      healthUrl.search = "";
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 4000);
      const response = await fetch(healthUrl.href, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      window.clearTimeout(timer);
      if (!response.ok) throw new Error("Worker health check failed");
      setStatus("Ready — code-grounded clinical guidance", "ready");
    } catch (_) {
      setStatus("Clinical AI unavailable — local pathway finder ready", "error");
    }
  }

  function open() {
    state.isOpen = true;
    state.els.panel.classList.add("open");
    document.querySelectorAll("[aria-controls='ask-dr-holtkamp-panel']").forEach((button) => {
      button.setAttribute("aria-expanded", "true");
    });
    refreshContextUI();
    autoSizeInput();
    window.setTimeout(() => state.els.input.focus(), 120);
  }

  function close() {
    state.isOpen = false;
    state.els.panel.classList.remove("open");
    document.querySelectorAll("[aria-controls='ask-dr-holtkamp-panel']").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
  }

  function autoSizeInput() {
    const input = state.els.input;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 145)}px`;
  }

  function updateSendState() {
    const hasText = state.els.input.value.trim().length > 0;
    state.els.send.disabled = state.isSending || !hasText || !state.els.attestation.checked;
  }

  function syncAttestationCard() {
    const hasText = state.els.input.value.trim().length > 0;
    if (!hasText) {
      state.els.attestation.checked = false;
      state.els.attestationCard.classList.remove("needs-attention");
    }
    state.els.attestationCard.hidden = !hasText;
    state.els.attestationCard.classList.toggle(
      "confirmed",
      hasText && state.els.attestation.checked
    );
    if (state.els.attestation.checked) {
      state.els.attestationCard.classList.remove("needs-attention");
    }
  }

  function requestAttestationAttention(message = "Confirm this message contains no PHI before sending.") {
    if (!state.els.input.value.trim()) return;
    state.els.attestationCard.hidden = false;
    state.els.attestationCard.classList.remove("needs-attention");
    void state.els.attestationCard.offsetWidth;
    state.els.attestationCard.classList.add("needs-attention");
    state.els.error.textContent = message;
    state.els.attestation.focus({ preventScroll: true });
    window.setTimeout(() => {
      state.els.attestationCard.classList.remove("needs-attention");
    }, 1400);
  }

  function clearMessages() {
    state.els.messages.replaceChildren();
  }

  function addInitialMessage() {
    createTextMessage(
      "assistant",
      "I’m Dr. Holtkamp’s AI persona—not Dr. Holtkamp at a keyboard. Tell me what you’re working through, without PHI, and I’ll stay inside the ADTMC+ and MSK code on this page."
    );
  }

  function newChat() {
    state.history = [];
    clearMessages();
    addInitialMessage();
    state.els.input.value = "";
    state.els.attestation.checked = false;
    state.els.error.textContent = "";
    autoSizeInput();
    syncAttestationCard();
    updateSendState();
    state.els.input.focus();
  }

  function createMessageShell(role) {
    const article = document.createElement("article");
    article.className = `ask-message ${role}`;

    const label = document.createElement("div");
    label.className = "ask-message-label";
    label.textContent = role === "user" ? "You" : "Dr. Holtkamp AI persona";

    const body = document.createElement("div");
    body.className = "ask-message-body";
    article.append(label, body);
    state.els.messages.appendChild(article);
    state.els.messages.scrollTop = state.els.messages.scrollHeight;
    return body;
  }

  function createTextMessage(role, text) {
    const body = createMessageShell(role);
    body.textContent = text;
    return body;
  }

  function createPendingMessage() {
    const body = createMessageShell("assistant");
    body.setAttribute("aria-label", "Thinking");
    const typing = document.createElement("div");
    typing.className = "ask-typing";
    typing.innerHTML = "<span></span><span></span><span></span>";
    body.appendChild(typing);
    return body;
  }

  function addSection(body, title, content, className = "") {
    if (!content || (Array.isArray(content) && content.length === 0)) return;
    const section = document.createElement("section");
    section.className = `ask-structured-section ${className}`.trim();
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);

    if (Array.isArray(content)) {
      const list = document.createElement("ul");
      content.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        list.appendChild(li);
      });
      section.appendChild(list);
    } else {
      const paragraph = document.createElement("p");
      paragraph.textContent = content;
      section.appendChild(paragraph);
    }
    body.appendChild(section);
  }

  function validateNavigation(navigation) {
    if (!navigation || navigation.kind === "none") return null;
    const allowedKinds = new Set([
      "adtmc_protocol",
      "adtmc_red_flags",
      "msk_protocol",
      "msk_references"
    ]);
    if (!allowedKinds.has(navigation.kind)) return null;

    if (navigation.kind === "msk_references") {
      return { kind: "msk_references", protocolId: "", label: "Open MSK references" };
    }

    const expectedTool = navigation.kind.startsWith("adtmc") ? "adtmc" : "msk";
    const entry = state.entries.find((item) => (
      item.tool === expectedTool && item.id === navigation.protocolId
    ));
    if (!entry) return null;

    return {
      kind: navigation.kind,
      protocolId: entry.id,
      label: navigation.label || `Open ${entry.id}: ${entry.title}`
    };
  }

  function addNavigationButton(body, result) {
    const navigation = validateNavigation(result.navigation);
    if (!navigation) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ask-open-target";
    button.textContent = `Open and highlight — ${navigation.label}`;
    button.addEventListener("click", () => {
      void performNavigation(navigation);
    });
    body.appendChild(button);
  }

  function addSources(body, sourcesList) {
    if (!Array.isArray(sourcesList) || sourcesList.length === 0) return;
    const section = document.createElement("section");
    section.className = "ask-structured-section ask-sources-section";
    const heading = document.createElement("h3");
    heading.textContent = "Sources";
    const sources = document.createElement("div");
    sources.className = "ask-sources";
    sourcesList.forEach((source) => {
      const chip = document.createElement("span");
      chip.className = "ask-source";
      chip.textContent = source.label || `${source.tool.toUpperCase()} ${source.protocolId}`;
      sources.appendChild(chip);
    });
    section.append(heading, sources);
    body.appendChild(section);
  }

  function getPersonaLead(result) {
    if (result.urgency === "red_flag") return "Stop here—the code has a red flag.";
    if (result.coverage === "clarify") {
      return "I need one detail before I can put you in the right coded lane.";
    }
    if (result.coverage === "closest") {
      return "The code does not directly answer this, but I found the closest lane.";
    }
    if (result.coverage === "unsupported") {
      return "The code does not give me a supported answer here.";
    }
    return "Here’s how I’d run the code.";
  }

  function renderStructuredResult(body, result) {
    body.replaceChildren();
    body.removeAttribute("aria-label");
    body.classList.toggle("ask-urgent", result.urgency === "red_flag");

    const lead = document.createElement("p");
    lead.className = "ask-persona-lead";
    lead.textContent = getPersonaLead(result);
    body.appendChild(lead);

    if (result.urgency === "red_flag") {
      const badge = document.createElement("div");
      badge.className = "ask-urgent-badge";
      badge.textContent = "Coded red flag";
      body.appendChild(badge);
    }

    if (result.coverage === "clarify") {
      addSection(body, "One detail I need", result.nextStep || result.algorithmMatch, "ask-action-section");
      addSection(body, "What the Algorithm Says", result.whatCodeSays, "ask-evidence-section");
      addSources(body, result.sources);
      addSection(body, "Limit", result.limitation, "ask-limit-section");
    } else {
      const actionTitle = result.coverage === "matched" ? "Coded next step" : "Code boundary";
      addSection(body, actionTitle, result.nextStep, "ask-action-section");
      addNavigationButton(body, result);
      addSection(body, "Algorithm match", result.algorithmMatch, "ask-match-section");
      addSection(body, "What the Algorithm Says", result.whatCodeSays, "ask-evidence-section");
      addSources(body, result.sources);
      addSection(body, "Limit", result.limitation, "ask-limit-section");
    }

    state.els.messages.scrollTop = state.els.messages.scrollHeight;
  }

  function resultToHistoryText(result) {
    return [
      result.algorithmMatch || "",
      ...(result.whatCodeSays || []),
      result.nextStep || "",
      result.limitation || ""
    ].filter(Boolean).join("\n").slice(0, 5000);
  }

  function getPageContext() {
    const active = document.querySelector(".app-container.active");
    const context = {
      activeTool: active?.id || "unknown",
      protocolId: getActiveProtocolId(),
      visibleScreen: "",
      visiblePrompt: "",
      selectedOptions: []
    };

    if (active?.id === "adtmc-app") {
      const screen = ["home-screen", "protocol-screen", "disposition-screen", "red-flags-list-screen"]
        .find((id) => !document.getElementById(id)?.classList.contains("hidden"));
      context.visibleScreen = screen || "";
      context.visiblePrompt = [
        document.getElementById("question-text"),
        document.getElementById("action-container")
      ].find((element) => element && !element.classList.contains("hidden"))?.textContent?.trim() || "";
      context.selectedOptions = Array.from(
        document.querySelectorAll("#checklist-container input[type='checkbox']:checked")
      ).map((checkbox) => checkbox.value).slice(0, 20);

      if (screen === "disposition-screen") {
        context.visiblePrompt = document.getElementById("disposition-result")?.textContent?.trim() || "";
      }
    }

    if (active?.id === "msk-app") {
      context.visibleScreen = "msk-pathway";
      try {
        context.visiblePrompt = typeof currentNodeId !== "undefined" && currentNodeId
          ? String(currentNodeId)
          : "";
        context.visitType = typeof visitTypeState !== "undefined" ? String(visitTypeState) : "";
      } catch (_) {
        context.visiblePrompt = "";
      }
    }

    return context;
  }

  function titleCaseIdentifier(value) {
    return String(value || "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim();
  }

  function getContextPresentation() {
    const context = getPageContext();
    const activeTool =
      context.activeTool === "adtmc-app"
        ? "adtmc"
        : context.activeTool === "msk-app"
          ? "msk"
          : "";
    const activeEntry = state.entries.find(
      (entry) => entry.tool === activeTool && entry.id === context.protocolId
    );

    if (context.activeTool === "landing-page" || context.activeTool === "unknown") {
      return {
        label: "ADTMC+ Home",
        prompts: [
          ["Find an ADTMC pathway", "Help me find the closest ADTMC pathway for a nonspecific case. Use only the loaded code."],
          ["Find an MSK pathway", "Help me find the closest MSK pathway for a nonspecific case. Use only the loaded code."]
        ]
      };
    }

    if (context.activeTool === "adtmc-app") {
      if (context.visibleScreen === "home-screen") {
        return {
          label: "ADTMC · Protocol Menu",
          prompts: [
            ["Find the right pathway", "Help me find the closest ADTMC pathway for a nonspecific case. Use only the loaded code."],
            ["Review coded red flags", "Help me locate the ADTMC pathway with the relevant coded red flags. Do not add medical knowledge."]
          ]
        };
      }

      if (context.visibleScreen === "red-flags-list-screen") {
        return {
          label: "ADTMC · All Red Flags",
          prompts: [
            ["Summarize this screen", "Summarize the ADTMC red-flag screen I am viewing. Use only the loaded code."],
            ["Find the matching pathway", "Help me find the matching ADTMC pathway for a nonspecific red-flag question. Use only the loaded code."]
          ]
        };
      }

      const protocolLabel = context.protocolId || activeEntry?.id || "Protocol";
      const redFlagsVisible = context.visibleScreen === "protocol-screen" &&
        !document.getElementById("red-flags-container")?.classList.contains("hidden");
      const stage = context.visibleScreen === "disposition-screen"
        ? "Disposition"
        : redFlagsVisible
          ? "Red Flags"
          : context.visiblePrompt
            ? "Current Question"
            : "Protocol";

      return {
        label: `ADTMC ${protocolLabel} · ${stage}`,
        prompts: [
          ["Summarize this screen", `Summarize the ADTMC ${protocolLabel} screen I am viewing. Use only the loaded code and current page state.`],
          ["What does the algorithm say next?", `Using only ADTMC ${protocolLabel} and the current page state, what is the coded next step? Do not select an answer for me.`],
          ["Show coded red flags", `Show the coded red flags for ADTMC ${protocolLabel} and offer to open that section. Use only the loaded code.`]
        ]
      };
    }

    if (context.activeTool === "msk-app") {
      const root = document.getElementById("msk-app-root");
      const heading = root?.querySelector("h1, h2")?.textContent?.trim() || "";
      if (heading === "Select Protocol") {
        return {
          label: "MSK · Protocol Menu",
          prompts: [
            ["Find the right pathway", "Help me find the closest MSK pathway for a nonspecific case. Use only the loaded code."],
            ["Open clinical references", "Open the MSK clinical references without changing any pathway selections."]
          ]
        };
      }
      if (heading.includes("Clinical References")) {
        return {
          label: "MSK · Clinical References",
          prompts: [
            ["Summarize this screen", "Summarize how the loaded MSK code uses the references on this screen. Do not add outside medical knowledge."],
            ["Return to a pathway", "Help me find the closest MSK pathway using only the loaded code."]
          ]
        };
      }

      const protocolName = activeEntry?.title
        ?.replace(/^Traumatic or Acute\s+/i, "")
        ?.replace(/\s+Pain$/i, "") || titleCaseIdentifier(context.protocolId) || "Pathway";
      const stage = context.visiblePrompt
        ? titleCaseIdentifier(context.visiblePrompt)
        : context.visitType
          ? `${titleCaseIdentifier(context.visitType)} Consult`
          : "Pathway";

      return {
        label: `MSK ${protocolName} · ${stage}`,
        prompts: [
          ["Summarize this screen", `Summarize the MSK ${protocolName} screen I am viewing. Use only the loaded code and current page state.`],
          ["What does the algorithm say next?", `Using only the MSK ${protocolName} code and current page state, what is the coded next step? Do not select an answer for me.`],
          ["Open clinical references", "Open the MSK clinical references without changing any pathway selections."]
        ]
      };
    }

    return { label: "ADTMC+ Clinical Tools", prompts: [] };
  }

  function refreshContextUI() {
    if (!state.els.contextValue || !state.els.suggestions) return;
    const presentation = getContextPresentation();
    state.els.contextValue.textContent = presentation.label;
    state.els.suggestions.replaceChildren();
    presentation.prompts.forEach(([label, prompt]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.askPrompt = prompt;
      state.els.suggestions.appendChild(button);
    });
  }

  function scheduleContextRefresh() {
    if (state.contextRefreshTimer) window.clearTimeout(state.contextRefreshTimer);
    state.contextRefreshTimer = window.setTimeout(() => {
      state.contextRefreshTimer = null;
      refreshContextUI();
    }, 60);
  }

  function buildRequestPayload(question) {
    const ranked = rankAlgorithms(question);
    const candidates = ranked.map(({ entry }) => entry);
    const activeProtocolId = getActiveProtocolId();
    const activeEntry = state.entries.find((entry) => entry.id === activeProtocolId);
    if (activeEntry && !candidates.some((entry) => entry.id === activeEntry.id)) {
      candidates.push(activeEntry);
    }

    return {
      question,
      history: state.history.slice(-MAX_HISTORY_MESSAGES),
      pageContext: getPageContext(),
      algorithmContext: {
        catalog: state.entries.map((entry) => ({
          tool: entry.tool,
          id: entry.id,
          title: entry.title,
          category: entry.category
        })),
        candidates: candidates.slice(0, MAX_CANDIDATES).map((entry) => ({
          tool: entry.tool,
          id: entry.id,
          title: entry.title,
          category: entry.category,
          content: entry.content
        }))
      }
    };
  }

  function renderLocalFallback(body, question, reason) {
    body.replaceChildren();
    body.removeAttribute("aria-label");
    body.classList.remove("ask-urgent");
    const lead = document.createElement("p");
    lead.className = "ask-persona-lead";
    lead.textContent = "I can’t reach the clinical model right now.";
    body.appendChild(lead);
    const intro = document.createElement("p");
    intro.textContent = reason ||
      "I can still locate likely coded pathways, but I cannot interpret the case.";
    body.appendChild(intro);

    const matches = rankAlgorithms(question, 3);
    if (matches.length === 0) {
      const note = document.createElement("p");
      note.style.marginTop = "0.55rem";
      note.textContent = "No likely pathway was found. Use the ADTMC+ and MSK menus directly.";
      body.appendChild(note);
      return;
    }

    matches.forEach(({ entry }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ask-local-result";
      button.textContent = `${entry.tool.toUpperCase()} · ${entry.id} · ${entry.title}`;
      button.addEventListener("click", () => {
        void performNavigation({
          kind: entry.tool === "adtmc" ? "adtmc_protocol" : "msk_protocol",
          protocolId: entry.id,
          label: entry.title
        });
      });
      body.appendChild(button);
    });
  }

  async function send() {
    const question = state.els.input.value.trim();
    if (!question || state.isSending) return;
    if (!state.els.attestation.checked) {
      requestAttestationAttention();
      return;
    }

    const phi = detectPhi(question);
    if (phi.detected) {
      state.els.error.textContent =
        `Message blocked before sending. Remove possible ${phi.matches.join(", ")} and describe only a nonspecific case.`;
      state.els.attestation.checked = false;
      syncAttestationCard();
      state.els.attestationCard.classList.add("needs-attention");
      window.setTimeout(() => {
        state.els.attestationCard.classList.remove("needs-attention");
      }, 1400);
      state.els.input.focus({ preventScroll: true });
      updateSendState();
      return;
    }

    createTextMessage("user", question);
    const priorHistory = state.history.slice(-MAX_HISTORY_MESSAGES);
    state.history.push({ role: "user", text: question });
    state.els.input.value = "";
    state.els.attestation.checked = false;
    state.els.error.textContent = "";
    autoSizeInput();
    syncAttestationCard();

    const pendingBody = createPendingMessage();
    if (!navigator.onLine) {
      renderLocalFallback(pendingBody, question);
      state.history.push({
        role: "assistant",
        text: "Offline local pathway finder used; no clinical interpretation was provided."
      });
      updateConnectivity();
      updateSendState();
      return;
    }

    state.isSending = true;
    updateSendState();
    setStatus("Reviewing the loaded ADTMC+ algorithms…");

    let timer;
    try {
      const payload = buildRequestPayload(question);
      payload.history = priorHistory;
      const controller = new AbortController();
      timer = window.setTimeout(() => controller.abort(), 45000);
      const response = await fetch(DEFAULT_WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      window.clearTimeout(timer);
      timer = undefined;

      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.result) {
        if (data?.code === "possible_phi") {
          throw new Error("The secure service detected possible identifying information.");
        }
        throw new Error(data?.error || `Clinical AI returned HTTP ${response.status}.`);
      }

      renderStructuredResult(pendingBody, data.result);
      state.history.push({ role: "assistant", text: resultToHistoryText(data.result) });
      setStatus("Ready — code-grounded clinical guidance", "ready");
    } catch (error) {
      const reason = error?.name === "AbortError"
        ? "The clinical AI request timed out. Local matching can only locate likely pathways."
        : "Clinical AI is unavailable. Local matching can only locate likely pathways.";
      renderLocalFallback(pendingBody, question, reason);
      state.history.push({
        role: "assistant",
        text: "Clinical AI unavailable; local pathway finder used without clinical interpretation."
      });
      setStatus("Clinical AI unavailable — local pathway finder ready", "error");
    } finally {
      if (timer) window.clearTimeout(timer);
      state.isSending = false;
      updateSendState();
      state.els.messages.scrollTop = state.els.messages.scrollHeight;
    }
  }

  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function highlightTarget(target) {
    if (!target) return;
    document.querySelectorAll(".ask-target-highlight").forEach((element) => {
      element.classList.remove("ask-target-highlight");
    });
    target.classList.add("ask-target-highlight");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => target.classList.remove("ask-target-highlight"), 7000);
  }

  async function performNavigation(navigation) {
    const valid = validateNavigation(navigation);
    if (!valid) return;

    if (valid.kind === "adtmc_protocol" || valid.kind === "adtmc_red_flags") {
      navigateTo("adtmc");
      await waitForPaint();
      const card = Array.from(document.querySelectorAll(".protocol-card")).find(
        (candidate) => candidate.dataset.protocolKey === valid.protocolId
      );
      if (card) card.click();
      await waitForPaint();
      const target = valid.kind === "adtmc_red_flags"
        ? document.getElementById("red-flags-container")
        : document.getElementById("protocol-title")?.closest(".bg-white") || document.getElementById("protocol-screen");
      highlightTarget(target);
      refreshContextUI();
      return;
    }

    if (valid.kind === "msk_protocol") {
      navigateTo("msk");
      await waitForPaint();
      const button = Array.from(document.querySelectorAll("#msk-app-root button")).find((candidate) => {
        const onclick = candidate.getAttribute("onclick") || "";
        return onclick.includes(`msk_startProtocol('${valid.protocolId}')`);
      });
      if (button) button.click();
      await waitForPaint();
      highlightTarget(document.querySelector("#msk-app-root .slide-in"));
      refreshContextUI();
      return;
    }

    if (valid.kind === "msk_references") {
      navigateTo("msk");
      await waitForPaint();
      if (typeof msk_renderReferences === "function") msk_renderReferences();
      await waitForPaint();
      highlightTarget(document.querySelector("#msk-app-root .slide-in"));
      refreshContextUI();
    }
  }

  function init() {
    if (window.ADTMCAskDrHoltkamp?.initialized) return;
    state.entries = buildAlgorithmEntries();
    injectLaunchControls();
    injectDrawer();
    bindEvents();
    addInitialMessage();
    refreshContextUI();
    updateConnectivity();
    void probeWorker();

    window.ADTMCAskDrHoltkamp = {
      initialized: true,
      open,
      close,
      newChat,
      detectPhi,
      rankAlgorithms,
      getAlgorithmCatalog: () => state.entries.map(({ searchText, ...entry }) => entry),
      getPageContext,
      getContextPresentation,
      performNavigation
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
