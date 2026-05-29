import { useEffect, useMemo, useRef, useState } from "react";
import type { ExplanationResponse, LlmSettings, StrategyConfigPayload, UiError } from "../types";
import { API_BASE, LLM_SETTINGS_KEY } from "../constants";
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

function readStoredLlm(): StoredLlmSettings {
  try {
    const raw = window.localStorage.getItem(LLM_SETTINGS_KEY);
    if (!raw) return DEFAULT_LLM;
    const parsed = JSON.parse(raw);
    return {
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_LLM.baseUrl,
      model: typeof parsed.model === "string" && parsed.model ? parsed.model : DEFAULT_LLM.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
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

export function useLlmExplanation(inputs: ExplanationInputs | null) {
  const [llm, setLlm] = useState<StoredLlmSettings>(() => readStoredLlm());
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explanationModel, setExplanationModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);

  const enabled = llm.apiKey.trim().length > 0;

  // Persist credentials (including the key) to localStorage only.
  useEffect(() => {
    window.localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify(llm));
  }, [llm]);

  const payloadSettings = useMemo<LlmSettings>(
    () => ({ baseUrl: llm.baseUrl.trim(), model: llm.model.trim(), apiKey: llm.apiKey.trim() }),
    [llm.baseUrl, llm.model, llm.apiKey],
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
  // overwrite a newer explanation.
  const requestSeq = useRef(0);

  const requestCurrentExplanation = () => {
    if (!canExplain || !symbol || !config || !asOf) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/explanations/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, asOf, config, llm: payloadSettings }),
    })
      .then(readJson<ExplanationResponse>)
      .then((data) => {
        if (seq !== requestSeq.current) return;
        setExplanation(data.explanation);
        setExplanationModel(data.model);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setError(toUiError(err));
        setExplanation(null);
        setExplanationModel(null);
      })
      .finally(() => {
        if (seq !== requestSeq.current) return;
        setLoading(false);
      });
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

  return {
    llm,
    setLlm,
    enabled,
    canExplain,
    explanation,
    explanationModel,
    explanationLoading: loading,
    explanationError: error,
    retryExplanation: requestCurrentExplanation,
  };
}
