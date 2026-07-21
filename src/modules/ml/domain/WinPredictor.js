"use strict";

/**
 * WinPredictor.js — Sprint 5 / RL-3
 *
 * Gradient Boosting classifier implemented in pure JS (no native bindings).
 * Predicts probability of a trade being a winner (p(win)) from a 60-dim feature vector.
 *
 * Algorithm: Gradient Boosting with decision stumps (single-split decision trees).
 *   - N=100 stumps
 *   - Learning rate: 0.1
 *   - Loss: binary cross-entropy → gradient = y_pred - y_true
 *   - Output: sigmoid(sum of weighted predictions)
 *   - Serializable to JSON (no binary weights)
 *
 * AC: AUC >= 0.60 on real data; inference < 10ms.
 */

const fs   = require("fs");
const path = require("path");

const FeatureEngineer = require("./FeatureEngineer");
const { VECTOR_DIM, FEATURE_NAMES } = require("./FeatureEngineer");
const { WIN_PREDICTOR_PATH } = require("../constants/modelPaths");

const DEFAULT_MODEL_PATH = WIN_PREDICTOR_PATH;
const DEFAULT_HYPERPARAMS = {
  nEstimators:   100,
  learningRate:  0.1,
  maxFeatures:   30, // randomly sample features per stump for diversity
  subsample:     0.8,
  minSamplesLeaf: 2,
};

// ── Utility functions ─────────────────────────────────────────────────────────

function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function logit(p) {
  const clipped = Math.max(1e-7, Math.min(1 - 1e-7, p));
  return Math.log(clipped / (1 - clipped));
}

function computeAUC(labels, scores) {
  if (labels.length === 0) return 0.5;
  // Rank-based AUC (Mann-Whitney U)
  const pairs = labels.map((y, i) => ({ y, s: scores[i] })).sort((a, b) => b.s - a.s);
  let tp = 0, fp = 0, tpPrev = 0, fpPrev = 0, auc = 0;
  const pos = labels.filter(Boolean).length;
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return 0.5;

  for (const { y } of pairs) {
    if (y) tp++; else fp++;
  }
  // Trapezoidal
  let cumTp = 0, cumFp = 0;
  auc = 0;
  tpPrev = 0; fpPrev = 0;
  const sorted = labels.map((y, i) => ({ y, s: scores[i] })).sort((a, b) => b.s - a.s);
  const thresholds = [...new Set(sorted.map((p) => p.s))];

  for (const thresh of thresholds) {
    cumTp = 0; cumFp = 0;
    for (const { y, s } of sorted) {
      if (s >= thresh) { if (y) cumTp++; else cumFp++; }
    }
    const tpr = cumTp / pos;
    const fpr = cumFp / neg;
    auc += (fpr - fpPrev / neg) * (tpr + tpPrev / pos) / 2;
    tpPrev = cumTp; fpPrev = cumFp;
  }
  // Simpler trapezoidal implementation
  const sortedByScore = sorted.slice().sort((a, b) => a.s - b.s);
  let aucVal = 0, cumPos = 0, cumNeg = 0;
  let prevFpr = 0, prevTpr = 0;
  for (let i = sortedByScore.length - 1; i >= 0; i--) {
    const { y } = sortedByScore[i];
    if (y) cumPos++; else cumNeg++;
    const tpr = cumPos / pos;
    const fpr = cumNeg / neg;
    aucVal += Math.abs(fpr - prevFpr) * (tpr + prevTpr) / 2;
    prevFpr = fpr; prevTpr = tpr;
  }
  return Math.min(1, Math.max(0, aucVal));
}

function computeAccuracy(labels, scores, threshold = 0.5) {
  let correct = 0;
  for (let i = 0; i < labels.length; i++) {
    const pred = scores[i] >= threshold ? 1 : 0;
    if (pred === labels[i]) correct++;
  }
  return labels.length > 0 ? correct / labels.length : 0;
}

function computePrecisionRecall(labels, scores, threshold = 0.5) {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < labels.length; i++) {
    const pred = scores[i] >= threshold ? 1 : 0;
    if (pred === 1 && labels[i] === 1) tp++;
    else if (pred === 1 && labels[i] === 0) fp++;
    else if (pred === 0 && labels[i] === 1) fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall    = tp + fn > 0 ? tp / (tp + fn) : 0;
  return { precision, recall };
}

// ── Decision stump ────────────────────────────────────────────────────────────

function findBestStump(X, residuals, featureIndices, minSamplesLeaf) {
  const n = X.length;
  let bestLoss = Infinity;
  let bestFeature = 0, bestThreshold = 0, bestLeftVal = 0, bestRightVal = 0;

  for (const fi of featureIndices) {
    // Collect (feature_value, residual) pairs sorted by feature value
    const pairs = X.map((x, i) => ({ fv: x[fi], r: residuals[i] }))
                   .sort((a, b) => a.fv - b.fv);

    // Try thresholds between consecutive unique feature values
    const tried = new Set();
    for (let j = 0; j < n - 1; j++) {
      const thresh = (pairs[j].fv + pairs[j + 1].fv) / 2;
      const tKey = thresh.toFixed(6);
      if (tried.has(tKey)) continue;
      tried.add(tKey);

      const left  = pairs.slice(0, j + 1).map((p) => p.r);
      const right = pairs.slice(j + 1).map((p) => p.r);

      if (left.length < minSamplesLeaf || right.length < minSamplesLeaf) continue;

      const leftMean  = left.reduce((s, v) => s + v, 0) / left.length;
      const rightMean = right.reduce((s, v) => s + v, 0) / right.length;

      const leftLoss  = left.reduce((s, v) => s + (v - leftMean) ** 2, 0);
      const rightLoss = right.reduce((s, v) => s + (v - rightMean) ** 2, 0);
      const totalLoss = leftLoss + rightLoss;

      if (totalLoss < bestLoss) {
        bestLoss       = totalLoss;
        bestFeature    = fi;
        bestThreshold  = thresh;
        // Map back to original order
        bestLeftVal  = leftMean;
        bestRightVal = rightMean;
      }
    }
  }

  return { feature: bestFeature, threshold: bestThreshold, leftVal: bestLeftVal, rightVal: bestRightVal };
}

// ── WinPredictor class ────────────────────────────────────────────────────────

class WinPredictor {
  constructor() {
    this.model         = null; // { stumps, initialPred, hyperparams, featureImportance }
    this.featureEngineer = new FeatureEngineer();
    this.modelPath     = DEFAULT_MODEL_PATH;
  }

  // ── Training ───────────────────────────────────────────────────────────────

  /**
   * Train on arrays of { features: Float32Array|number[], label: 0|1 }
   * @param {Array<{features, label}>} trainingData
   * @param {Array<{features, label}>} [validationData]
   * @param {object} [hyperparams]
   * @returns {{ auc, accuracy, precision, recall, featureImportance }}
   */
  async train(trainingData, validationData = [], hyperparams = {}) {
    if (!trainingData || trainingData.length === 0) {
      // Graceful fallback: return a neutral model
      this.model = {
        stumps: [],
        initialPred: 0,
        hyperparams: DEFAULT_HYPERPARAMS,
        featureImportance: FEATURE_NAMES.map((n, i) => ({ name: n, importance: 0, index: i })),
      };
      return { auc: 0.5, accuracy: 0.5, precision: 0, recall: 0, featureImportance: this.model.featureImportance };
    }

    const hp = { ...DEFAULT_HYPERPARAMS, ...hyperparams };
    const X   = trainingData.map((d) => Array.from(d.features));
    const y   = trainingData.map((d) => d.label);
    const n   = X.length;

    // Initial prediction: log-odds of base rate
    const baseRate = y.reduce((s, v) => s + v, 0) / n;
    const initialPred = logit(Math.max(0.01, Math.min(0.99, baseRate)));

    const predictions = new Float64Array(n).fill(initialPred);
    const stumps      = [];
    const importances = new Float64Array(VECTOR_DIM);

    for (let t = 0; t < hp.nEstimators; t++) {
      // Compute pseudo-residuals (gradient of binary cross-entropy)
      const probs     = predictions.map(sigmoid);
      const residuals = y.map((yi, i) => yi - probs[i]);

      // Subsample rows
      const sampleSize   = Math.max(hp.minSamplesLeaf * 2, Math.floor(n * hp.subsample));
      const sampleIndices = [];
      const available    = Array.from({ length: n }, (_, i) => i);
      for (let k = 0; k < sampleSize && k < n; k++) {
        const idx = Math.floor(Math.random() * available.length);
        sampleIndices.push(available[idx]);
        available.splice(idx, 1);
      }

      const Xs = sampleIndices.map((i) => X[i]);
      const rs = sampleIndices.map((i) => residuals[i]);

      // Random feature subset
      const allFeatures = Array.from({ length: VECTOR_DIM }, (_, i) => i);
      const featureIndices = [];
      const afCopy = [...allFeatures];
      for (let k = 0; k < hp.maxFeatures && afCopy.length > 0; k++) {
        const idx = Math.floor(Math.random() * afCopy.length);
        featureIndices.push(afCopy[idx]);
        afCopy.splice(idx, 1);
      }

      const stump = findBestStump(Xs, rs, featureIndices, hp.minSamplesLeaf);
      stumps.push(stump);

      // Update predictions
      for (let i = 0; i < n; i++) {
        const goes_left = X[i][stump.feature] <= stump.threshold;
        predictions[i] += hp.learningRate * (goes_left ? stump.leftVal : stump.rightVal);
      }

      // Feature importance (use count of how many times feature was used)
      importances[stump.feature] += Math.abs(stump.leftVal - stump.rightVal) || 0;
    }

    // Build feature importance
    const totalImp = importances.reduce((s, v) => s + v, 0) || 1;
    const featureImportance = FEATURE_NAMES.map((name, idx) => ({
      name,
      importance: importances[idx] / totalImp,
      index: idx,
    })).sort((a, b) => b.importance - a.importance);

    this.model = { stumps, initialPred, hyperparams: hp, featureImportance };

    // Evaluate on validation set
    const evalData = validationData.length > 0 ? validationData : trainingData;
    const evalScores = this.predictBatch(evalData.map((d) => d.features)).map((r) => r.pWin);
    const evalLabels = evalData.map((d) => d.label);

    const auc      = computeAUC(evalLabels, evalScores);
    const accuracy = computeAccuracy(evalLabels, evalScores);
    const { precision, recall } = computePrecisionRecall(evalLabels, evalScores);

    return { auc, accuracy, precision, recall, featureImportance };
  }

  // ── Inference ──────────────────────────────────────────────────────────────

  _predictRaw(featureVector) {
    if (!this.model || !this.model.stumps) {
      return 0; // fallback: no model loaded
    }
    const x  = Array.from(featureVector);
    let score = this.model.initialPred;
    const lr  = this.model.hyperparams?.learningRate ?? 0.1;

    for (const stump of this.model.stumps) {
      const goesLeft = x[stump.feature] <= stump.threshold;
      score += lr * (goesLeft ? stump.leftVal : stump.rightVal);
    }
    return sigmoid(score);
  }

  /**
   * Predict probability of win for one trade.
   * @param {Float32Array|number[]} featureVector — 60-dim
   * @returns {{ pWin: number, confidence: number }}
   */
  predict(featureVector) {
    if (!this.model) return { pWin: 0.5, confidence: 0 };
    const pWin       = this._predictRaw(featureVector);
    const confidence = Math.round(Math.abs(pWin - 0.5) * 200); // 0-100
    return { pWin, confidence };
  }

  /**
   * Batch predict for array of feature vectors.
   * @param {Array<Float32Array|number[]>} featureVectors
   * @returns {Array<{pWin, confidence}>}
   */
  predictBatch(featureVectors) {
    return featureVectors.map((fv) => this.predict(fv));
  }

  // ── Model persistence ──────────────────────────────────────────────────────

  /**
   * Save model to disk as JSON.
   * @param {string} [filePath]
   */
  async save(filePath) {
    const savePath = filePath || this.modelPath;
    if (!this.model) throw new Error("WinPredictor: no model to save");

    // Ensure directory exists
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(savePath, JSON.stringify(this.model, null, 2), "utf8");
  }

  /**
   * Load model from disk.
   * @param {string} [filePath]
   */
  async load(filePath) {
    const loadPath = filePath || this.modelPath;
    if (!fs.existsSync(loadPath)) {
      console.warn(`[WinPredictor] Model file not found: ${loadPath} — using fallback`);
      return false;
    }
    try {
      const raw = fs.readFileSync(loadPath, "utf8");
      this.model = JSON.parse(raw);
      return true;
    } catch (err) {
      console.warn(`[WinPredictor] Failed to load model: ${err.message}`);
      return false;
    }
  }

  // ── Walk-forward validation ────────────────────────────────────────────────

  /**
   * Walk-forward time-series validation.
   * @param {Array<{features, label, timestamp: Date|string}>} allData — must be sorted by timestamp ASC
   * @param {{ trainDays, testDays, splits }} [options]
   * @returns {{ splits: Array<{auc, accuracy}>, avgAuc, avgAccuracy }}
   */
  async walkForwardValidate(allData, options = {}) {
    const { trainDays = 90, testDays = 30, splits: numSplits = 4 } = options;
    if (!allData || allData.length === 0) {
      return { splits: [], avgAuc: 0.5, avgAccuracy: 0.5 };
    }

    // Sort by timestamp
    const sorted = [...allData].sort((a, b) => {
      const ta = new Date(a.timestamp || 0).getTime();
      const tb = new Date(b.timestamp || 0).getTime();
      return ta - tb;
    });

    const MS_PER_DAY = 86400000;
    const minTs = new Date(sorted[0].timestamp || Date.now()).getTime();
    const maxTs = new Date(sorted[sorted.length - 1].timestamp || Date.now()).getTime();
    const totalDays = (maxTs - minTs) / MS_PER_DAY;

    const splitResults = [];
    const stepDays = Math.max(1, Math.floor((totalDays - trainDays - testDays) / Math.max(1, numSplits - 1)));

    for (let s = 0; s < numSplits; s++) {
      const trainStart = minTs + s * stepDays * MS_PER_DAY;
      const trainEnd   = trainStart + trainDays * MS_PER_DAY;
      const testEnd    = trainEnd   + testDays  * MS_PER_DAY;

      const trainSet = sorted.filter((d) => {
        const t = new Date(d.timestamp || 0).getTime();
        return t >= trainStart && t < trainEnd;
      });
      const testSet  = sorted.filter((d) => {
        const t = new Date(d.timestamp || 0).getTime();
        return t >= trainEnd && t < testEnd;
      });

      if (trainSet.length < 10 || testSet.length < 5) {
        splitResults.push({ auc: 0.5, accuracy: 0.5, trainSize: trainSet.length, testSize: testSet.length });
        continue;
      }

      const tempPredictor = new WinPredictor();
      await tempPredictor.train(trainSet);

      const scores = tempPredictor.predictBatch(testSet.map((d) => d.features)).map((r) => r.pWin);
      const labels = testSet.map((d) => d.label);

      splitResults.push({
        auc:      computeAUC(labels, scores),
        accuracy: computeAccuracy(labels, scores),
        trainSize: trainSet.length,
        testSize: testSet.length,
      });
    }

    const avgAuc      = splitResults.length > 0
      ? splitResults.reduce((s, r) => s + r.auc, 0) / splitResults.length
      : 0.5;
    const avgAccuracy = splitResults.length > 0
      ? splitResults.reduce((s, r) => s + r.accuracy, 0) / splitResults.length
      : 0.5;

    return { splits: splitResults, avgAuc, avgAccuracy };
  }

  // ── Feature importance ─────────────────────────────────────────────────────

  /**
   * @returns {Array<{name, importance}>} sorted descending by importance
   */
  getFeatureImportance() {
    if (!this.model?.featureImportance) return [];
    return this.model.featureImportance.map(({ name, importance }) => ({ name, importance }));
  }
}

module.exports = WinPredictor;
