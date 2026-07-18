"use strict";

/**
 * ResearchDatasetService — CRUD + migration for TradeResearchDataset SSOT.
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const prisma = require("../../../infrastructure/db/prismaClient");
const { mapExportRowToDataset } = require("./ResearchDatasetMapper");
const { scoreTierFor, CORE_REQUIRED_FIELDS } = require("../../../models/researchDatasetSchema");

const DEFAULT_XLSX_WINDOWS = Object.freeze([
  "/Users/fahras/Desktop/22-10-2021 - 30-08-2022.xlsx",
  "/Users/fahras/Desktop/29-08-2022 - 06-07-2023.xlsx",
  "/Users/fahras/Desktop/06-07-2023 - 11-05-2024.xlsx",
  "/Users/fahras/Desktop/11-05-2024 - 17-03-2025.xlsx",
  "/Users/fahras/Desktop/17-03-2025 - 21-01-2026.xlsx",
  "/Users/fahras/Desktop/21-01-2026 - 17-07-2026.xlsx",
]);

function migrationBatchFromPath(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base.replace(/\s+/g, "_").toLowerCase();
}

function readRowsFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") {
    const wb = XLSX.readFile(filePath, { type: "file" });
    const sheet = wb.SheetNames[0];
    return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: null });
  }
  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.SheetNames.find((n) => /specific|core|trades/i.test(n)) || wb.SheetNames[0];
    return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: null });
  }
  throw new Error(`Unsupported file type: ${filePath}`);
}

function isCompleteRecord(rec) {
  for (const f of CORE_REQUIRED_FIELDS) {
    const v = rec[f];
    if (v == null || v === "") return false;
  }
  return true;
}

class ResearchDatasetService {
  /** @param {string[]} [filePaths] */
  async migrateFromFiles(filePaths = DEFAULT_XLSX_WINDOWS, { dryRun = false, clearBatch = false } = {}) {
    const results = { files: [], totalRows: 0, inserted: 0, updated: 0, skipped: 0, completePct: 0 };

    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        results.files.push({ filePath, error: "not_found", rows: 0 });
        continue;
      }
      const batch = migrationBatchFromPath(filePath);
      const rows = readRowsFromFile(filePath);
      let fileInserted = 0;
      let fileUpdated = 0;

      if (clearBatch && !dryRun) {
        await prisma.tradeResearchDataset.deleteMany({ where: { migrationBatch: batch } });
      }

      for (let i = 0; i < rows.length; i++) {
        const mapped = mapExportRowToDataset(rows[i], {
          migrationBatch: batch,
          sourceFile: filePath,
          rowIndex: i,
        });
        results.totalRows += 1;
        if (dryRun) continue;

        const existing = await prisma.tradeResearchDataset.findUnique({
          where: { tradeId: mapped.tradeId },
        });
        if (existing) {
          await prisma.tradeResearchDataset.update({ where: { tradeId: mapped.tradeId }, data: mapped });
          fileUpdated += 1;
        } else {
          await prisma.tradeResearchDataset.create({ data: mapped });
          fileInserted += 1;
        }
      }

      results.inserted += fileInserted;
      results.updated += fileUpdated;
      results.files.push({
        filePath,
        batch,
        rows: rows.length,
        inserted: fileInserted,
        updated: fileUpdated,
      });
    }

    if (!dryRun) {
      const all = await prisma.tradeResearchDataset.findMany();
      const complete = all.filter(isCompleteRecord).length;
      results.completePct = all.length ? (complete / all.length) * 100 : 0;
    }

    return results;
  }

  async getSummary({ strategyKey } = {}) {
    const where = strategyKey ? { strategyKey } : {};
    const [total, byResult, avgScore] = await Promise.all([
      prisma.tradeResearchDataset.count({ where }),
      prisma.tradeResearchDataset.groupBy({
        by: ["result"],
        where,
        _count: { result: true },
      }),
      prisma.tradeResearchDataset.aggregate({
        where,
        _avg: { gradedScore: true },
      }),
    ]);
    return {
      total,
      byResult: Object.fromEntries(byResult.map((r) => [r.result, r._count.result])),
      avgGradedScore: avgScore._avg.gradedScore,
    };
  }

  async getTradesByScoreTier({ strategyKey, tier, limit = 100, offset = 0 } = {}) {
    const bounds = { low: [0, 33], mid: [33, 66], high: [66, 100] };
    const b = bounds[tier];
    if (!b) throw new Error(`Invalid tier: ${tier}`);
    const where = {
      gradedScore: { gte: b[0], lt: b[1] + (tier === "high" ? 1 : 0) },
    };
    if (strategyKey) where.strategyKey = strategyKey;

    const [rows, count] = await Promise.all([
      prisma.tradeResearchDataset.findMany({
        where,
        orderBy: { entryTime: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.tradeResearchDataset.count({ where }),
    ]);
    return { tier, count, rows };
  }

  async queryTrades(filters = {}) {
    const {
      strategyKey,
      symbol,
      result,
      minScore,
      maxScore,
      migrationBatch,
      limit = 100,
      offset = 0,
    } = filters;
    const where = {};
    if (strategyKey) where.strategyKey = strategyKey;
    if (symbol) where.symbol = symbol;
    if (result) where.result = result;
    if (migrationBatch) where.migrationBatch = migrationBatch;
    if (minScore != null || maxScore != null) {
      where.gradedScore = {};
      if (minScore != null) where.gradedScore.gte = minScore;
      if (maxScore != null) where.gradedScore.lte = maxScore;
    }

    const [rows, count] = await Promise.all([
      prisma.tradeResearchDataset.findMany({
        where,
        orderBy: { entryTime: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.tradeResearchDataset.count({ where }),
    ]);
    return { count, rows };
  }

  async getDataQualityReport() {
    const all = await prisma.tradeResearchDataset.findMany({
      select: {
        tradeId: true,
        gradedScore: true,
        dataQualityFlags: true,
        strategyKey: true,
        symbol: true,
        result: true,
        entryTime: true,
        sessionName: true,
        dailyRegime: true,
        htfTrend: true,
        atr: true,
        exitReason: true,
      },
    });
    const complete = all.filter(isCompleteRecord);
    const flagged = all.filter((r) => (r.dataQualityFlags || []).length > 0);
    return {
      total: all.length,
      complete: complete.length,
      completePct: all.length ? (complete.length / all.length) * 100 : 0,
      flagged: flagged.length,
      flaggedPct: all.length ? (flagged.length / all.length) * 100 : 0,
      flagCounts: flagged.reduce((acc, r) => {
        for (const f of r.dataQualityFlags || []) acc[f] = (acc[f] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

module.exports = {
  ResearchDatasetService,
  DEFAULT_XLSX_WINDOWS,
  migrationBatchFromPath,
  readRowsFromFile,
  isCompleteRecord,
  scoreTierFor,
};
