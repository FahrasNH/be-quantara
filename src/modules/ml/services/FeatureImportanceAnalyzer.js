"use strict";

/**
 * FeatureImportanceAnalyzer.js — Sprint 16 Phase 2 / Task 2.3
 *
 * Permutation-based feature importance (SHAP approximation) for WinPredictor.
 * Runs offline (hourly cron) on recent closed trades; results cached to disk
 * and exposed via GET /api/v1/internal/meta-selector/feature-importance.
 */

const fs   = require("fs");
const path = require("path");

const WinPredictor    = require("../domain/WinPredictor");
const FeatureEngineer = require("../domain/FeatureEngineer");
const { FEATURE_NAMES, VECTOR_DIM } = require("../domain/FeatureEngineer");
const {
  fetchClosedEngineTrades,
  buildMlArtifactsFromEngineRows,
} = require("../../analytics/domain/engineTradeMlAdapter");
const { _pool } = require("../../../infrastructure/db/database");

const CACHE_PATH = path.join(__dirname, "../../../data/models/feature-importance.json");

/** Rank-based AUC (Mann-Whitney U trapezoidal). */
function computeAUC(labels, scores) {
  if (!labels?.length) return 0.5;
  const pairs = labels.map((y, i) => ({ y: y ? 1 : 0, s: scores[i] ?? 0.5 }));
  const pos   = pairs.filter((p) => p.y === 1).length;
  const neg   = pairs.length - pos;
  if (pos === 0 || neg === 0) return 0.5;

  pairs.sort((a, b) => b.s - a.s);
  let cumPos = 0, cumNeg = 0, prevFpr = 0, prevTpr = 0, auc = 0;
  for (const { y } of pairs) {
    if (y) cumPos++; else cumNeg++;
    const tpr = cumPos / pos;
    const fpr = cumNeg / neg;
    auc += Math.abs(fpr - prevFpr) * (tpr + prevTpr) / 2;
    prevFpr = fpr;
    prevTpr = tpr;
  }
  return Math.min(1, Math.max(0, auc));
}

/** Fisher-Yates shuffle (in-place copy). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class FeatureImportanceAnalyzer {
  /**
   * @param {import('../domain/WinPredictor')} winPredictor
   * @param {import('../domain/FeatureEngineer')} featureEngineer
   */
  constructor(winPredictor, featureEngineer) {
    this.winPredictor    = winPredictor;
    this.featureEngineer = featureEngineer;
  }

  /**
   * Run permutation importance (SHAP approximation) on recent trades.
   *
   * @param {{ samples?: number, tradeSamples?: Array, model?: WinPredictor }} [opts]
   * @returns {Promise<{ importance, top5, baselineAuc, sampleCount, analyzedAt, source }>}
   */
  async analyze(opts = {}) {
    const sampleLimit = opts.samples ?? 500;
    const predictor   = opts.model ?? this.winPredictor;

    let dataset = opts.tradeSamples ?? null;
    if (!dataset) {
      const { rows } = await fetchClosedEngineTrades(_pool, { limit: sampleLimit });
      const built    = buildMlArtifactsFromEngineRows(rows, this.featureEngineer);
      dataset = built.dataset.slice(-sampleLimit);
    }

    if (!dataset || dataset.length < 10) {
      const builtin = (predictor?.getFeatureImportance?.() ?? []).slice(0, 5);
      const result  = {
        importance:  builtin,
        top5:        builtin,
        baselineAuc: 0.5,
        sampleCount: dataset?.length ?? 0,
        analyzedAt:  new Date().toISOString(),
        source:      "model_builtin",
      };
      this._saveCache(result);
      return result;
    }

    const X      = dataset.map((d) => Array.from(d.features));
    const labels = dataset.map((d) => d.label === 1);
    const baselineScores = X.map((x) => predictor.predict(x).pWin);
    const baselineAuc    = computeAUC(labels, baselineScores);

    const importances = [];
    const dim = Math.min(VECTOR_DIM, FEATURE_NAMES.length);

    for (let fi = 0; fi < dim; fi++) {
      const col = X.map((row) => row[fi]);
      const shuffledCol = shuffle(col);
      const permutedX = X.map((row, i) => {
        const copy = row.slice();
        copy[fi] = shuffledCol[i];
        return copy;
      });

      const permScores = permutedX.map((x) => predictor.predict(x).pWin);
      const permAuc    = computeAUC(labels, permScores);

      importances.push({
        name:       FEATURE_NAMES[fi],
        importance: Math.max(0, baselineAuc - permAuc),
        index:      fi,
      });
    }

    const total = importances.reduce((s, r) => s + r.importance, 0) || 1;
    const normalized = importances
      .map((r) => ({
        name:       r.name,
        importance: +(r.importance / total).toFixed(4),
        index:      r.index,
      }))
      .sort((a, b) => b.importance - a.importance);

    const result = {
      importance:  normalized.slice(0, 10),
      top5:        normalized.slice(0, 5),
      baselineAuc: +baselineAuc.toFixed(4),
      sampleCount: dataset.length,
      analyzedAt:  new Date().toISOString(),
      source:      "permutation_shap",
    };

    this._saveCache(result);
    return result;
  }

  /** Return last cached analysis (or null). */
  getCached() {
    try {
      if (!fs.existsSync(CACHE_PATH)) return null;
      return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    } catch {
      return null;
    }
  }

  _saveCache(result) {
    try {
      const dir = path.dirname(CACHE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CACHE_PATH, JSON.stringify(result, null, 2), "utf8");
    } catch (err) {
      console.warn(`[FeatureImportanceAnalyzer] cache save failed: ${err.message}`);
    }
  }

  /**
   * @returns {FeatureImportanceAnalyzer|null}
   */
  static autoStart() {
    try {
      const wp = new WinPredictor();
      wp.load().catch(() => {});
      return new FeatureImportanceAnalyzer(wp, new FeatureEngineer());
    } catch (err) {
      console.warn(`[FeatureImportanceAnalyzer] autoStart failed: ${err.message}`);
      return null;
    }
  }
}

module.exports = FeatureImportanceAnalyzer;
