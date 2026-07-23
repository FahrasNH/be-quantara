"use strict";

/**
 * LocalTextEmbedder — deterministic offline text embeddings (384-d).
 * Uses character n-gram hashing; no external API required (CI/offline safe).
 * Replace with BGE/E5/Voyage when RAG_EMBEDDING_PROVIDER is configured.
 */

const DOC_VECTOR_DIM = 384;

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function hashToBucket(str, dim) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % dim;
}

function embedText(text, dim = DOC_VECTOR_DIM) {
  const vec = new Float32Array(dim);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  for (const tok of tokens) {
    vec[hashToBucket(tok, dim)] += 1;
    for (let i = 0; i < tok.length - 2; i++) {
      vec[hashToBucket(tok.slice(i, i + 3), dim)] += 0.5;
    }
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

module.exports = {
  DOC_VECTOR_DIM,
  embedText,
  tokenize,
};
