import type { LlmProvider } from "@/lib/types";

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_ZHIPU_MAX_TOKENS = 2048;

type Message = {
  role: "system" | "user";
  content: string;
};

type LlmRequest = {
  messages: Message[];
  temperature?: number;
};

type LlmCallOptions = {
  provider?: LlmProvider;
  model?: string;
  apiKey?: string;
  apiUrl?: string;
};

function readProvider(): LlmProvider {
  const provider = (process.env.LLM_PROVIDER ?? "zhipu").toLowerCase();
  if (provider === "zhipu" || provider === "minimax" || provider === "doubao") {
    return provider;
  }
  throw new Error("LLM_PROVIDER 仅支持 zhipu/minimax/doubao。");
}

function readApiKey(provider: LlmProvider, override?: string): string | null {
  if (override?.trim()) return override.trim();
  if (provider === "zhipu") {
    return process.env.ZHIPU_API_KEY ?? process.env.LLM_API_KEY ?? null;
  }
  if (provider === "minimax") {
    return process.env.MINIMAX_API_KEY ?? process.env.LLM_API_KEY ?? null;
  }
  return process.env.DOUBAO_API_KEY ?? process.env.LLM_API_KEY ?? null;
}

function readTimeout(): number {
  const raw = process.env.LLM_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function readBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function readPositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function extractTextFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;

  const choices = body.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const text = content
            .map((part) => {
              if (typeof part === "string") return part;
              if (part && typeof part === "object") {
                const maybeText = (part as Record<string, unknown>).text;
                if (typeof maybeText === "string") return maybeText;
              }
              return "";
            })
            .join("");
          if (text.trim().length > 0) return text;
        }
      }
    }
  }

  const directContent = body.content;
  if (typeof directContent === "string") return directContent;

  const reply = body.reply;
  if (typeof reply === "string") return reply;

  const outputText = body.output_text;
  if (typeof outputText === "string") return outputText;

  return null;
}

async function requestJson(
  url: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeout = readTimeout();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new Error(
          `LLM 请求超时（${timeout}ms）。请提高 LLM_TIMEOUT_MS 或降低 ZHIPU_MAX_TOKENS。`,
        );
      }
      throw new Error(`LLM 网络异常：${error.message}`);
    }
    throw error;
  }

  const bodyText = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = bodyText.length ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }

  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : bodyText;
    throw new Error(`LLM 请求失败: ${response.status} ${message}`);
  }
  return body;
}

function buildOpenAiLikePayload(
  model: string,
  request: LlmRequest,
): Record<string, unknown> {
  return {
    model,
    messages: request.messages,
    temperature: request.temperature ?? 0.4,
    response_format: { type: "json_object" },
  };
}

export async function callLlm(
  request: LlmRequest,
  options?: LlmCallOptions,
): Promise<{ content: string; provider: LlmProvider; model: string }> {
  const provider = options?.provider ?? readProvider();
  const apiKey = readApiKey(provider, options?.apiKey);
  if (!apiKey) {
    throw new Error("缺少可用 API Key，请设置 LLM_API_KEY 或对应厂商 API Key。");
  }

  if (provider === "zhipu") {
    const url =
      options?.apiUrl ??
      process.env.ZHIPU_API_URL ??
      process.env.LLM_API_URL ??
      "https://open.bigmodel.cn/api/paas/v4/chat/completions";
    const model =
      options?.model ?? process.env.ZHIPU_MODEL ?? process.env.LLM_MODEL ?? "glm-5";
    const payload = buildOpenAiLikePayload(model, request);
    const thinkingType = (process.env.ZHIPU_THINKING_TYPE ?? "disabled")
      .trim()
      .toLowerCase();
    if (thinkingType === "enabled" || thinkingType === "disabled") {
      payload.thinking = { type: thinkingType };
    }
    const doSample = readBoolean(process.env.ZHIPU_DO_SAMPLE);
    if (typeof doSample === "boolean") {
      payload.do_sample = doSample;
    }
    const maxTokens =
      readPositiveNumber(process.env.ZHIPU_MAX_TOKENS) ??
      DEFAULT_ZHIPU_MAX_TOKENS;
    payload.max_tokens = maxTokens;
    const body = await requestJson(url, apiKey, payload);
    const content = extractTextFromPayload(body);
    if (!content) throw new Error("智谱返回内容为空。");
    return { content, provider, model };
  }

  if (provider === "minimax") {
    const url =
      options?.apiUrl ??
      process.env.MINIMAX_API_URL ??
      process.env.LLM_API_URL ??
      "https://api.minimax.chat/v1/text/chatcompletion_v2";
    const model =
      options?.model ??
      process.env.MINIMAX_MODEL ??
      process.env.LLM_MODEL ??
      "MiniMax-Text-01";
    const payload = buildOpenAiLikePayload(model, request);
    const body = await requestJson(url, apiKey, payload);
    const content = extractTextFromPayload(body);
    if (!content) throw new Error("Minimax 返回内容为空。");
    return { content, provider, model };
  }

  const url =
    options?.apiUrl ??
    process.env.DOUBAO_API_URL ??
    process.env.LLM_API_URL ??
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
  const model =
    options?.model ?? process.env.DOUBAO_MODEL ?? process.env.LLM_MODEL ?? "doubao-pro";
  const payload = buildOpenAiLikePayload(model, request);
  const body = await requestJson(url, apiKey, payload);
  const content = extractTextFromPayload(body);
  if (!content) throw new Error("豆包返回内容为空。");
  return { content, provider, model };
}
