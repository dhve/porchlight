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

/**
 * One turn of a tool-using conversation (OpenAI function calling). The caller
 * owns the message history and appends the assistant message plus any tool
 * results before calling again. Messages may carry image parts
 * ({type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}) so an
 * agent can look at a page as well as read it.
 * @param {{system:string, messages:object[], tools:object[], maxTokens?:number, toolChoice?:string|object}} opts
 * @returns {Promise<{message:object, finishReason:string, usage:object|null}>}
 */
export async function chatTools({ system, messages, tools, maxTokens = 3000, toolChoice = "auto", reasoningEffort = "none" }) {
  if (!llmEnabled()) throw new Error("LLM is not configured (no OPENAI_API_KEY).");
  const body = {
    model: modelName(),
    max_completion_tokens: Math.max(maxTokens, 1500),
    messages: [{ role: "system", content: system }, ...messages],
    tools,
    tool_choice: toolChoice,
  };
  // gpt-5.x on chat completions only accepts function tools with reasoning_effort "none";
  // older models reject the parameter altogether, so drop it if the API says so.
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(`OpenAI API error ${res.status}: ${detail.slice(0, 400)}`);
        if (res.status === 429 || res.status >= 500) { lastErr = err; continue; }
        if (body.reasoning_effort && /reasoning_effort/i.test(detail) && /unsupported|not supported|unknown|unrecognized|invalid/i.test(detail)) {
          delete body.reasoning_effort; lastErr = err; continue;
        }
        throw err;
      }
      const data = await res.json();
      const choice = data?.choices?.[0];
      if (!choice?.message) throw new Error("OpenAI returned no message.");
      return { message: choice.message, finishReason: choice.finish_reason || "", usage: data.usage || null };
    } catch (err) {
      lastErr = err;
      if (err.name === "AbortError") continue;
      if (!/OpenAI API error (429|5\d\d)/.test(err.message)) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("OpenAI call failed.");
}
