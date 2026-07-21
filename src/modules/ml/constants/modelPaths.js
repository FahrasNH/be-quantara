"use strict";

const path = require("path");

/** Repo root (be-bot-trading/) — shared by training scripts and runtime loaders. */
const REPO_ROOT = path.join(__dirname, "../../../..");

const MODEL_DIR = path.join(REPO_ROOT, "data/models");

module.exports = {
  REPO_ROOT,
  MODEL_DIR,
  WIN_PREDICTOR_PATH: path.join(MODEL_DIR, "win-predictor.json"),
  TRAINING_REPORT_PATH: path.join(MODEL_DIR, "training-report.json"),
  ML_ENGINE_DATASET_PATH: path.join(REPO_ROOT, "data/ml-engine-dataset.json"),
  FEATURE_IMPORTANCE_PATH: path.join(MODEL_DIR, "feature-importance.json"),
};
