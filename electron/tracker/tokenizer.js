const TOKENISH_SYMBOLS = /[{}[\]();.,:+\-*/<>=_|`$#@!~%^&?\\]/g;

export function estimateTokens(text = "") {
  if (!text || typeof text !== "string") {
    return 0;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  const wordCount = trimmed.split(/\s+/u).filter(Boolean).length;
  const symbolCount = (trimmed.match(TOKENISH_SYMBOLS) || []).length;
  const charEstimate = trimmed.length / 4;
  const wordEstimate = wordCount * 1.25;

  return Math.max(1, Math.ceil(Math.max(charEstimate, wordEstimate) + symbolCount * 0.15));
}

export function estimateUsage(prompt = "", output = "") {
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(output);

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    tokenSource: "estimated"
  };
}
