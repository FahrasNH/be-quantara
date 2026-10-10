/**
 * XaiClient.js — HTTP client untuk xAI Grok API (console.x.ai)
 *
 * Kompatibel OpenAI REST: chat completions + file upload.
 * Collections memakai Management API terpisah.
 */

const axios = require("axios");
const cfg = require("../../config/env");

const CHAT_URL = "https://api.x.ai/v1/chat/completions";
const FILES_URL = "https://api.x.ai/v1/files";
const SEARCH_URL = "https://api.x.ai/v1/documents/search";
const MGMT_BASE = "https://management-api.x.ai/v1";
const DEFAULT_ERROR_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_PROVIDER_DETAIL_LENGTH = 240;

function extractProviderMessage(error) {
  const data = error?.response?.data;
  const candidates = [
    data?.error?.message,
    data?.error,
    data?.message,
    typeof data === "string" ? data : null,
  ];
  const message = candidates.find((value) => typeof value === "string" && value.trim());
  return String(message || error?.message || "Request xAI gagal")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROVIDER_DETAIL_LENGTH);
}

function parseRetryAfterMs(error) {
  const value = error?.response?.headers?.["retry-after"]
    ?? error?.response?.headers?.["Retry-After"];
  if (value == null) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);

  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp > Date.now()
    ? timestamp - Date.now()
    : 0;
}

function classifyProviderError(error, operation) {
  const status = Number(error?.response?.status) || 0;
  if (!status) return error;

  const providerMessage = extractProviderMessage(error);
  const normalized = providerMessage.toLowerCase();
  let code = `XAI_HTTP_${status}`;
  let message = `xAI ${operation} gagal (HTTP ${status})`;

  if (status === 401) {
    code = "XAI_UNAUTHORIZED";
    message = "xAI menolak API key (401). Periksa XAI_API_KEY inference di console.x.ai.";
  } else if (status === 403 && /credit|spending limit|monthly limit|quota|balance/.test(normalized)) {
    code = "XAI_CREDITS_EXHAUSTED";
    message = "xAI menolak request (403): credit habis atau monthly spending limit tercapai. "
      + "Tambahkan credit atau naikkan spending limit di console.x.ai.";
  } else if (status === 403) {
    code = "XAI_FORBIDDEN";
    message = "xAI menolak request (403): API key/team tidak memiliki permission atau sedang diblokir. "
      + "Periksa team dan permission key di console.x.ai.";
  } else if (status === 429) {
    code = "XAI_RATE_LIMITED";
    message = "xAI rate limit tercapai (429). Request akan dicoba kembali setelah cooldown.";
  } else if (status >= 500) {
    code = "XAI_PROVIDER_UNAVAILABLE";
    message = `xAI sedang tidak tersedia (HTTP ${status}). Request ditahan sementara.`;
  } else if (providerMessage && !/^request failed with status code/i.test(providerMessage)) {
    message += `: ${providerMessage}`;
  }

  const normalizedError = new Error(message);
  normalizedError.name = "XaiProviderError";
  normalizedError.code = code;
  normalizedError.status = status;
  normalizedError.provider = "xAI";
  normalizedError.operation = operation;
  normalizedError.providerMessage = providerMessage;
  normalizedError.retryAfterMs = parseRetryAfterMs(error);
  normalizedError.cause = error;
  return normalizedError;
}

class XaiClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? cfg.XAI_API_KEY;
    this.managementKey = options.managementKey ?? cfg.XAI_MANAGEMENT_API_KEY;
    this.model = options.model ?? cfg.XAI_MODEL;
    this.collectionId = options.collectionId ?? cfg.XAI_COLLECTION_ID;
    this.timeoutMs = options.timeoutMs ?? cfg.XAI_TIMEOUT_MS;
    this.errorCooldownMs = Math.max(
      0,
      Number(options.errorCooldownMs ?? cfg.XAI_ERROR_COOLDOWN_MS ?? DEFAULT_ERROR_COOLDOWN_MS),
    );
    this._cooldownUntil = 0;
    this._cooldownError = null;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  get hasCollection() {
    return Boolean(this.collectionId && this.managementKey);
  }

  _authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  _throwIfCoolingDown() {
    const remainingMs = this._cooldownUntil - Date.now();
    if (!(remainingMs > 0)) {
      this._cooldownUntil = 0;
      this._cooldownError = null;
      return;
    }

    const source = this._cooldownError || new Error("xAI request ditahan sementara");
    const retryError = new Error(
      `${source.message} Retry sekitar ${Math.ceil(remainingMs / 60_000)} menit lagi.`,
    );
    retryError.name = source.name || "XaiProviderError";
    retryError.code = source.code || "XAI_COOLDOWN";
    retryError.status = source.status;
    retryError.provider = "xAI";
    retryError.operation = source.operation;
    retryError.providerMessage = source.providerMessage;
    retryError.retryAfterMs = remainingMs;
    retryError.cooldown = true;
    throw retryError;
  }

  _startErrorCooldown(error) {
    const retryAfterMs = Number(error?.retryAfterMs) > 0
      ? Number(error.retryAfterMs)
      : this.errorCooldownMs;
    if (!(retryAfterMs > 0) || ![401, 403, 429].includes(Number(error?.status))) return;

    this._cooldownUntil = Date.now() + retryAfterMs;
    this._cooldownError = error;
  }

  _clearErrorCooldown() {
    this._cooldownUntil = 0;
    this._cooldownError = null;
  }

  /**
   * Chat completion — OpenAI-compatible format.
   * @returns {Promise<string>} assistant message content
   */
  async chat(messages, opts = {}) {
    if (!this.isConfigured) {
      throw new Error("XAI_API_KEY belum dikonfigurasi. Dapatkan key di https://console.x.ai/");
    }
    this._throwIfCoolingDown();

    const body = {
      model: opts.model ?? this.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4096,
    };

    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    try {
      const { data } = await axios.post(CHAT_URL, body, {
        headers: this._authHeaders(),
        timeout: this.timeoutMs,
      });

      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("xAI tidak mengembalikan respons valid");
      }
      this._clearErrorCooldown();
      return content;
    } catch (error) {
      const normalizedError = classifyProviderError(error, "chat");
      if (normalizedError !== error) this._startErrorCooldown(normalizedError);
      throw normalizedError;
    }
  }

  /**
   * Semantic search di Collections (RAG).
   * @returns {Promise<Array<{text: string, score?: number}>>}
   */
  async searchCollection(query, opts = {}) {
    if (!this.isConfigured || !this.collectionId) return [];

    const { data } = await axios.post(
      SEARCH_URL,
      {
        query,
        source: { collection_ids: [opts.collectionId ?? this.collectionId] },
        retrieval_mode: { type: opts.mode ?? "hybrid" },
        limit: opts.limit ?? 5,
      },
      { headers: this._authHeaders(), timeout: this.timeoutMs }
    );

    const chunks = data?.matches ?? data?.results ?? data?.documents ?? [];
    return chunks.map(c => ({
      text: c.text ?? c.content ?? c.snippet ?? String(c),
      score: c.score ?? c.relevance_score,
    }));
  }

  /**
   * Upload file ke xAI Files API.
   * @returns {Promise<{file_id: string}>}
   */
  async uploadFile(name, data, mimeType = "text/plain") {
    if (!this.isConfigured) {
      throw new Error("XAI_API_KEY belum dikonfigurasi");
    }

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), name);
    form.append("purpose", "assistants");

    const { data: res } = await axios.post(FILES_URL, form, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeout: this.timeoutMs,
      maxBodyLength: Infinity,
    });

    const fileId = res?.id ?? res?.file_id;
    if (!fileId) throw new Error("Upload file xAI gagal — tidak ada file_id");
    return { file_id: fileId };
  }

  /**
   * Tambahkan file yang sudah di-upload ke Collection.
   */
  async addFileToCollection(fileId, collectionId = null) {
    const cid = collectionId ?? this.collectionId;
    const mgmtKey = this.managementKey;
    if (!cid || !mgmtKey) {
      throw new Error("XAI_COLLECTION_ID dan XAI_MANAGEMENT_API_KEY diperlukan untuk Collections");
    }

    await axios.post(
      `${MGMT_BASE}/collections/${cid}/documents/${fileId}`,
      {},
      {
        headers: {
          Authorization: `Bearer ${mgmtKey}`,
          "Content-Type": "application/json",
        },
        timeout: this.timeoutMs,
      }
    );

    return { collection_id: cid, file_id: fileId };
  }

  /**
   * Upload + tambah ke collection (satu langkah).
   */
  async uploadToCollection(name, content, mimeType = "text/plain") {
    const { file_id } = await this.uploadFile(name, content, mimeType);
    await this.addFileToCollection(file_id);
    return { file_id, name };
  }
}

module.exports = XaiClient;
