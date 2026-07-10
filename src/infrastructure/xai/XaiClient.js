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

class XaiClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? cfg.XAI_API_KEY;
    this.managementKey = options.managementKey ?? cfg.XAI_MANAGEMENT_API_KEY;
    this.model = options.model ?? cfg.XAI_MODEL;
    this.collectionId = options.collectionId ?? cfg.XAI_COLLECTION_ID;
    this.timeoutMs = options.timeoutMs ?? cfg.XAI_TIMEOUT_MS;
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

  /**
   * Chat completion — OpenAI-compatible format.
   * @returns {Promise<string>} assistant message content
   */
  async chat(messages, opts = {}) {
    if (!this.isConfigured) {
      throw new Error("XAI_API_KEY belum dikonfigurasi. Dapatkan key di https://console.x.ai/");
    }

    const body = {
      model: opts.model ?? this.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4096,
    };

    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const { data } = await axios.post(CHAT_URL, body, {
      headers: this._authHeaders(),
      timeout: this.timeoutMs,
    });

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("xAI tidak mengembalikan respons valid");
    }
    return content;
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
