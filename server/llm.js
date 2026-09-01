// llm.js
// Thin wrapper over the OpenAI Chat Completions API using plain fetch, so the
// project has no SDK dependency to keep up to date.
//
// The key is read from process.env.OPENAI_API_KEY, which comes from the local
// .env file (gitignored). If there is no key, llmEnabled() is false and the
// pipeline uses its rule-based fallbacks instead.

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
export async function chatJSON({ system, user, temperature = 0.4, maxTokens = 1500 }) {
  if (!llmEnabled()) throw new Error("LLM is not configured (no OPENAI_API_KEY).");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelName(),
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI API error ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty response.");
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}
