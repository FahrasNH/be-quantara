"use strict";

/**
 * KnowledgeIngestionPipeline — Sprint 21 / Task 1
 * Ingests structured trades, unstructured docs, and methodology markdown.
 */

const fs = require("fs");
const path = require("path");
const { embedText } = require("./LocalTextEmbedder");

const DOCS_ROOT = path.resolve(__dirname, "../../../../docs");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s*:\s*you\s+are/i,
  /<\/?script/i,
  /javascript:/i,
];

function sanitizeContent(text) {
  let clean = String(text || "").slice(0, 50000);
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(clean)) {
      clean = clean.replace(pat, "[filtered]");
    }
  }
  return clean.trim();
}

function chunkByHeadings(markdown, maxChunk = 1200) {
  const lines = String(markdown || "").split("\n");
  const chunks = [];
  let current = [];
  let heading = "";

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      if (current.length > 0) {
        chunks.push({ heading, text: current.join("\n").trim() });
        current = [];
      }
      heading = line.replace(/^#+\s*/, "");
    }
    current.push(line);
    if (current.join("\n").length >= maxChunk) {
      chunks.push({ heading, text: current.join("\n").trim() });
      current = [];
    }
  }
  if (current.length > 0) {
    chunks.push({ heading, text: current.join("\n").trim() });
  }
  return chunks.filter((c) => c.text.length > 40);
}

function slidingWindow(text, size = 800, overlap = 120) {
  const chunks = [];
  const t = String(text || "");
  for (let i = 0; i < t.length; i += size - overlap) {
    const slice = t.slice(i, i + size).trim();
    if (slice.length > 40) chunks.push(slice);
  }
  return chunks;
}

class KnowledgeIngestionPipeline {
  constructor(docStore, { prisma } = {}) {
    this.docStore = docStore;
    this.prisma = prisma;
  }

  async ingestMarkdownFile(filePath, meta = {}) {
    if (!fs.existsSync(filePath)) return { filePath, chunks: 0, skipped: true };
    const raw = fs.readFileSync(filePath, "utf8");
    const content = sanitizeContent(raw);
    const baseName = path.basename(filePath, path.extname(filePath));
    const docId = meta.docId || `md:${baseName}`;
    const structured = chunkByHeadings(content);
    const pieces = structured.length > 0
      ? structured.map((c) => (c.heading ? `# ${c.heading}\n${c.text}` : c.text))
      : slidingWindow(content);

    let inserted = 0;
    for (let i = 0; i < pieces.length; i++) {
      const text = pieces[i];
      await this.docStore.upsertChunk({
        docId,
        chunkIndex: i,
        content: text,
        vector: embedText(text),
        metadata: {
          docType: meta.docType || "methodology",
          source: filePath.replace(REPO_ROOT, ""),
          title: baseName,
          version: meta.version || "1.0",
          ...meta,
        },
      });
      inserted += 1;
    }
    return { filePath, docId, chunks: inserted };
  }

  async ingestDocsDirectory(dir = DOCS_ROOT, docType = "methodology") {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    const results = [];
    for (const f of files) {
      results.push(await this.ingestMarkdownFile(path.join(dir, f), { docType }));
    }
    return results;
  }

  async ingestStructuredTrades({ strategyKey, limit = 200 } = {}) {
    if (!this.prisma) return { chunks: 0, skipped: true };
    const where = strategyKey ? { strategyKey } : {};
    const trades = await this.prisma.tradeResearchDataset.findMany({
      where,
      orderBy: { entryTime: "desc" },
      take: limit,
    });

    let inserted = 0;
    for (const t of trades) {
      const text = sanitizeContent(
        `Trade ${t.tradeId}: ${t.side} ${t.symbol} ${t.strategyKey} ` +
        `regime=${t.dailyRegime || "N/A"} result=${t.result || "N/A"} ` +
        `pnl=${t.pnlNet ?? t.pnlGross ?? "N/A"} exit=${t.exitReason || "N/A"} ` +
        `score=${t.gradedScore ?? "N/A"} session=${t.sessionName || "N/A"}`
      );
      await this.docStore.upsertChunk({
        docId: `trade:${t.tradeId}`,
        chunkIndex: 0,
        content: text,
        vector: embedText(text),
        metadata: {
          docType: "structured",
          tradeId: t.tradeId,
          strategyKey: t.strategyKey,
          symbol: t.symbol,
          regime: t.dailyRegime,
          outcome: t.result,
          source: "TradeResearchDataset",
        },
      });
      inserted += 1;
    }
    return { chunks: inserted, trades: trades.length };
  }

  async runFullIngest(opts = {}) {
    const mdResults = await this.ingestDocsDirectory(opts.docsDir);
    const tradeResult = await this.ingestStructuredTrades(opts);
    return {
      markdown: mdResults,
      structured: tradeResult,
      totalChunks: mdResults.reduce((s, r) => s + (r.chunks || 0), 0) + (tradeResult.chunks || 0),
    };
  }
}

module.exports = {
  KnowledgeIngestionPipeline,
  sanitizeContent,
  chunkByHeadings,
  slidingWindow,
  INJECTION_PATTERNS,
};
