// llm.js
// Thin wrapper over the OpenAI Chat Completions API using plain fetch, so the
// project has no SDK dependency to keep up to date.
//
// The key is read from process.env.OPENAI_API_KEY, which comes from the local
// .env file (gitignored). If there is no key, llmEnabled() is false and the
// pipeline uses its rule-based fallbacks instead.
//
// Works across model generations: newer models (gpt-5.x, o-series) reject
// `max_tokens` and custom `temperature`, so we send `max_completion_tokens`
// and drop temperature automatically if the API says it is unsupported.

const API_URL = "https://api.openai.com/v1/chat/completions";

export function llmEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function modelName() {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

/**
 * Ask the model for a JSON object. Uses JSON response mode so we always get
 * parseable output.
 * @param {{system:string, user:string, temperature?:number, maxTokens?:number}} opts
 * @returns {Promise<object>}
 */
export async function chatJSON({ system, user, temperature = 0.4, maxTokens = 4000 }) {
  if (!llmEnabled()) throw new Error("LLM is not configured (no OPENAI_API_KEY).");

  const base = {
    model: modelName(),
    // Reasoning models spend part of this budget thinking, so keep it generous.
    max_completion_tokens: Math.max(maxTokens, 2000),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  // First try with temperature; if this model refuses it, retry without.
  try {
    return await call({ ...base, temperature });
  } catch (err) {
    if (/temperature/i.test(err.message) && /unsupported|not supported|does not support/i.test(err.message)) {
      return await call(base);
    }
    throw err;
  }
}

async function call(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI API error ${res.status}: ${detail.slice(0, 400)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      const why = data?.choices?.[0]?.finish_reason;
      throw new Error(`OpenAI returned an empty response${why ? " (finish_reason: " + why + ")" : ""}.`);
    }
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}
