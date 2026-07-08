import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatResponse, ExplanationResponse, LlmSettings, LlmSource, ServerLlmConfigResponse, ServerLlmConfigUpdate, StrategyConfigPayload, UiError } from "../types";
import { API_BASE, LLM_SETTINGS_KEY, LLM_SOURCE_KEY } from "../constants";
import { readJson, toUiError } from "../api";

type StoredLlmSettings = {
  baseUrl: string;
  model: string;
  apiKey: string;
  autoGenerate: boolean;
};

const DEFAULT_LLM: StoredLlmSettings = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
  autoGenerate: true,
};

// API key at-rest obfuscation. We use a per-origin random key kept in
// localStorage alongside the ciphertext. This is NOT a security boundary
// against a determined attacker with XSS access — it exists solely to
// prevent a casual glance at DevTools or a synced-tab backup from
// revealing the plaintext key. Operators who need stronger guarantees
// should use a server-side proxy.
const KEY_OBFUSCATION_STORAGE = "dca:llm:obfuscation-key-v1";

function getOrCreateObfuscationKey(): string {
  try {
    const existing = window.localStorage.getItem(KEY_OBFUSCATION_STORAGE);
    if (existing) return existing;
    const buf = new Uint8Array(32);
    window.crypto.getRandomValues(buf);
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(KEY_OBFUSCATION_STORAGE, hex);
    return hex;
  } catch {
    // localStorage disabled (private mode, etc.) — fall back to a
    // stable sentinel so at least the current session works.
    return "fallback-obfuscation-key";
  }
}

function xorWithKey(plain: string, key: string): string {
  if (!plain) return "";
  let out = "";
  for (let i = 0; i < plain.length; i += 1) {
    out += String.fromCharCode(plain.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

function looksLikePrintableAscii(s: string): boolean {
  // Reject strings containing control characters or replacement chars
  // that indicate a decode failure (wrong key -> binary garbage).
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
    if (code === 0xFFFD) return false;
  }
  return true;
}

function encodeApiKey(plain: string): string {
  if (!plain) return "";
  const key = getOrCreateObfuscationKey();
  return "enc:" + btoa(unescape(encodeURIComponent(xorWithKey(plain, key))));
}

function decodeApiKey(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith("enc:")) {
    // Backwards-compatible: legacy plain key in localStorage. Return
    // verbatim; the next save will re-encrypt it with the current key.
    return stored;
  }
  try {
    const key = getOrCreateObfuscationKey();
    const decoded = decodeURIComponent(escape(atob(stored.slice(4))));
    const result = xorWithKey(decoded, key);
    // If the key was lost (e.g. storage cleared across sessions) and a
    // new random key was generated, XOR with the wrong key produces
    // binary garbage. Detect that and return "" so the user is prompted
    // to re-enter instead of seeing mojibake.
    if (!looksLikePrintableAscii(result)) return "";
    return result;
  } catch {
    return "";
  }
}

function readStoredLlm(): StoredLlmSettings {
  try {
    const raw = window.localStorage.getItem(LLM_SETTINGS_KEY);
    if (!raw) return DEFAULT_LLM;
    const parsed = JSON.parse(raw);
    const apiKey = decodeApiKey(
      typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    );
    return {
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_LLM.baseUrl,
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : DEFAULT_LLM.model,
      apiKey,
      autoGenerate: parsed.autoGenerate !== false,
    };
  } catch {
    return DEFAULT_LLM;
  }
}

type ExplanationInputs = {
  symbol: string;
  config: StrategyConfigPayload;
  asOf: string;
  // Bumps whenever the decision the user is looking at changes, so we
  // re-explain. Kept separate from config so we don't re-call the LLM
  // on every keystroke — the caller decides the granularity.
  decisionKey: string;
};

type SelectionExplanationResponse = {
  symbol: string;
  selectedText: string;
  explanation: string;
  model: string;
  dataSource: string;
  cacheStatus: string;
};

export function useLlmExplanation(inputs: ExplanationInputs | null) {
  const [llm, setLlm] = useState<StoredLlmSettings>(() => readStoredLlm());
  const [source, setSource] = useState<LlmSource>(() => {
    try {
      const saved = window.localStorage.getItem(LLM_SOURCE_KEY);
      return saved === "server" ? "server" : "local";
    } catch {
      return "local";
    }
  });
  const [serverConfig, setServerConfig] = useState<ServerLlmConfigResponse | null>(null);
  const [serverConfigLoading, setServerConfigLoading] = useState(false);
  const [serverConfigError, setServerConfigError] = useState<UiError | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explanationModel, setExplanationModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [selectionExplanation, setSelectionExplanation] = useState<string | null>(null);
  const [selectionModel, setSelectionModel] = useState<string | null>(null);
  const [selectionText, setSelectionText] = useState<string | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState<UiError | null>(null);

  const isServerMode = source === "server";
  const localEnabled = llm.apiKey.trim().length > 0;
  const serverEnabled = serverConfig?.configured === true;
  const enabled = isServerMode ? serverEnabled : localEnabled;

  // Persist source mode to localStorage
  useEffect(() => {
    try {
      window.localStorage.setItem(LLM_SOURCE_KEY, source);
    } catch { /* ignore */ }
  }, [source]);

  // Fetch server config when entering server mode
  const fetchServerConfig = useCallback(() => {
    setServerConfigLoading(true);
    setServerConfigError(null);
    fetch(`${API_BASE}/api/settings/llm`)
      .then(readJson<ServerLlmConfigResponse>)
      .then(setServerConfig)
      .catch((err) => setServerConfigError(toUiError(err)))
      .finally(() => setServerConfigLoading(false));
  }, []);

  useEffect(() => {
    if (isServerMode) fetchServerConfig();
  }, [isServerMode, fetchServerConfig]);

  // Save server-side config
  const saveServerConfig = useCallback((update: ServerLlmConfigUpdate) => {
    setServerConfigLoading(true);
    setServerConfigError(null);
    fetch(`${API_BASE}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    })
      .then(readJson<ServerLlmConfigResponse>)
      .then(setServerConfig)
      .catch((err) => setServerConfigError(toUiError(err)))
      .finally(() => setServerConfigLoading(false));
  }, []);

  // Delete server-side config
  const deleteServerConfig = useCallback(() => {
    setServerConfigLoading(true);
    setServerConfigError(null);
    fetch(`${API_BASE}/api/settings/llm`, { method: "DELETE" })
      .then(() => {
        setServerConfig({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", configured: false });
      })
      .catch((err) => setServerConfigError(toUiError(err)))
      .finally(() => setServerConfigLoading(false));
  }, []);

  // Persist credentials to localStorage. The key is obfuscated before
  // being written so a casual read of devtools doesn't reveal the
  // plaintext (the obfuscation key lives in sessionStorage — see the
  // comment near getOrCreateObfuscationKey for threat model details).
  useEffect(() => {
    const persisted = { ...llm, apiKey: encodeApiKey(llm.apiKey) };
    try {
      window.localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(persisted));
    } catch {
      // localStorage may be full or disabled (private mode); the in-memory
      // hook state still works for the current session, the next page load
      // simply starts from the defaults.
    }
  }, [llm]);

  const payloadSettings = useMemo<LlmSettings>(
    () => isServerMode
      ? { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "", useServerConfig: true }
      : { baseUrl: llm.baseUrl.trim(), model: llm.model.trim(), apiKey: llm.apiKey.trim(), useServerConfig: false },
    [isServerMode, llm.baseUrl, llm.model, llm.apiKey],
  );

  // Auto-generate an explanation whenever the decision changes, as long
  // as the user has supplied an API key. The decisionKey is the trigger
  // so we don't fire on unrelated state churn.
  const decisionKey = inputs?.decisionKey ?? "";
  const symbol = inputs?.symbol;
  const config = inputs?.config;
  const asOf = inputs?.asOf;
  const canExplain = enabled && Boolean(symbol && config && asOf && decisionKey);

  // Track the latest in-flight request so a slow earlier response can't
  // overwrite a newer explanation. The controller is also passed to
  // fetch() so an effect cleanup or unmount can cancel the network
  // call instead of leaving it dangling.
  const requestSeq = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);
  const selectionRequestSeq = useRef(0);
  const selectionAbort = useRef<AbortController | null>(null);
  const chatRequestSeq = useRef(0);
  const chatAbort = useRef<AbortController | null>(null);

  const requestCurrentExplanation = () => {
    if (!canExplain || !symbol || !config || !asOf) return;
    if (requestAbort.current) requestAbort.current.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    setExplanation(null);
    setExplanationModel(null);
    fetch(`${API_BASE}/api/explanations/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, asOf, config, llm: payloadSettings }),
      signal: controller.signal,
    })
      .then(readJson<ExplanationResponse>)
      .then((data) => {
        if (seq !== requestSeq.current) return;
        setExplanation(data.explanation);
        setExplanationModel(data.model);
      })
      .catch((err) => {
        if (seq !== requestSeq.current || err?.name === "AbortError") return;
        setError(toUiError(err));
        setExplanation(null);
        setExplanationModel(null);
      })
      .finally(() => {
        if (seq !== requestSeq.current) return;
        setLoading(false);
      });
  };

  const requestSelectionExplanation = (selectedText: string) => {
    const cleanText = selectedText.trim().replace(/\s+/g, " ");
    if (!canExplain || !symbol || !config || !asOf || cleanText.length < 2) return;
    if (selectionAbort.current) selectionAbort.current.abort();
    const controller = new AbortController();
    selectionAbort.current = controller;
    const seq = ++selectionRequestSeq.current;
    setSelectionText(cleanText);
    setSelectionLoading(true);
    setSelectionError(null);
    setSelectionExplanation(null);
    setSelectionModel(null);
    fetch(`${API_BASE}/api/explanations/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, asOf, config, selectedText: cleanText, llm: payloadSettings }),
      signal: controller.signal,
    })
      .then(readJson<SelectionExplanationResponse>)
      .then((data) => {
        if (seq !== selectionRequestSeq.current) return;
        setSelectionExplanation(data.explanation);
        setSelectionModel(data.model);
        setSelectionText(data.selectedText);
      })
      .catch((err) => {
        if (seq !== selectionRequestSeq.current || err?.name === "AbortError") return;
        setSelectionError(toUiError(err));
        setSelectionExplanation(null);
        setSelectionModel(null);
      })
      .finally(() => {
        if (seq !== selectionRequestSeq.current) return;
        setSelectionLoading(false);
      });
  };

  const clearSelectionExplanation = () => {
    if (selectionAbort.current) selectionAbort.current.abort();
    selectionRequestSeq.current += 1;
    setSelectionExplanation(null);
    setSelectionModel(null);
    setSelectionText(null);
    setSelectionLoading(false);
    setSelectionError(null);
  };

  // ─── Multi-turn chat ───────────────────────────────────────────
  // Conversation history is cleared whenever the decision the user is
  // looking at changes (decisionKey), so stale Q&A from an old
  // recommendation never bleeds into a new context.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<UiError | null>(null);

  const sendChatQuestion = (question: string) => {
    const cleanQuestion = question.trim();
    if (!canExplain || !symbol || !config || !asOf || cleanQuestion.length < 1) return;
    if (chatAbort.current) chatAbort.current.abort();
    const controller = new AbortController();
    chatAbort.current = controller;
    const seq = ++chatRequestSeq.current;
    const history = chatMessages;
    setChatMessages((prev) => [...prev, { role: "user", content: cleanQuestion }]);
    setChatLoading(true);
    setChatError(null);
    fetch(`${API_BASE}/api/explanations/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, asOf, config, question: cleanQuestion, history, llm: payloadSettings }),
      signal: controller.signal,
    })
      .then(readJson<ChatResponse>)
      .then((data) => {
        if (seq !== chatRequestSeq.current) return;
        setChatMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
      })
      .catch((err) => {
        if (seq !== chatRequestSeq.current || err?.name === "AbortError") return;
        setChatError(toUiError(err));
      })
      .finally(() => {
        if (seq !== chatRequestSeq.current) return;
        setChatLoading(false);
      });
  };

  // Cancel any in-flight fetch when the component unmounts so we
  // don't leak listeners or trigger "setState on unmounted component"
  // warnings during HMR / route changes.
  useEffect(() => {
    return () => {
      requestAbort.current?.abort();
      selectionAbort.current?.abort();
      chatAbort.current?.abort();
    };
  }, []);

  const clearChat = () => {
    chatRequestSeq.current += 1;
    setChatMessages([]);
    setChatLoading(false);
    setChatError(null);
  };

  useEffect(() => {
    if (!canExplain) {
      requestSeq.current += 1;
      setLoading(false);
      setExplanation(null);
      setExplanationModel(null);
      setError(null);
      return;
    }
  }, [canExplain]);

  useEffect(() => {
    if (!canExplain || !llm.autoGenerate) return;
    requestCurrentExplanation();
    // payloadSettings is intentionally excluded: we don't want to
    // re-call the LLM the instant the user edits the key field. The
    // decisionKey change is the meaningful auto trigger, and a fresh
    // key takes effect on the next decision change or via the manual
    // button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canExplain, llm.autoGenerate, decisionKey]);

  // Clear chat history when the decision context changes so stale
  // Q&A from an old recommendation doesn't bleed into a new context.
  useEffect(() => {
    clearChat();
  }, [decisionKey]);

  return {
    llm,
    setLlm,
    enabled,
    canExplain,
    source,
    setSource,
    serverConfig,
    serverConfigLoading,
    serverConfigError,
    saveServerConfig,
    deleteServerConfig,
    refreshServerConfig: fetchServerConfig,
    explanation,
    explanationModel,
    explanationLoading: loading,
    explanationError: error,
    retryExplanation: requestCurrentExplanation,
    selectionExplanation,
    selectionModel,
    selectionText,
    selectionLoading,
    selectionError,
    requestSelectionExplanation,
    clearSelectionExplanation,
    chatMessages,
    chatLoading,
    chatError,
    sendChatQuestion,
    clearChat,
  };
}
