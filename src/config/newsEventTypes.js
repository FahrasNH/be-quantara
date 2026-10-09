"use strict";

// Only Tier A and Tier B events may reach the dry-run Grok decision prompt.
// Tier C commentary, routine crypto headlines, and technical-analysis articles
// are intentionally absent from this registry and therefore cannot authorize
// a paper entry.
const NEWS_EVENT_TIERS = Object.freeze({
  FOMC_RATE_DECISION: "A",
  FED_MINUTES: "A",
  FED_PRESS_CONFERENCE: "A",
  FED_PROJECTIONS: "A",
  CPI_INFLATION: "A",
  PCE_INFLATION: "A",
  NFP_UNEMPLOYMENT: "A",
  ETF_FLOW_SHOCK: "A",
  REGULATORY_SHOCK: "A",
  SECURITY_INCIDENT: "A",
  STABLECOIN_DEPEG: "A",
  LIQUIDATION_EVENT: "A",
  FED_SPEECH: "B",
  GDP_GROWTH: "B",
  PMI_ACTIVITY: "B",
  RETAIL_SALES: "B",
  JOBLESS_CLAIMS: "B",
});

const NEWS_EVENT_LABELS = Object.freeze({
  FOMC_RATE_DECISION: "FOMC / Keputusan Suku Bunga Fed",
  FED_MINUTES: "Risalah Rapat Fed (Fed Minutes)",
  FED_PRESS_CONFERENCE: "Konferensi Pers Fed",
  FED_PROJECTIONS: "Proyeksi Fed / Dot Plot",
  CPI_INFLATION: "CPI / Data Inflasi",
  PCE_INFLATION: "PCE / Core PCE Inflation",
  NFP_UNEMPLOYMENT: "NFP / Pengangguran",
  ETF_FLOW_SHOCK: "Arus Dana ETF Crypto",
  REGULATORY_SHOCK: "Regulasi Crypto / SEC / CFTC",
  SECURITY_INCIDENT: "Insiden Keamanan / Exchange / Protocol",
  STABLECOIN_DEPEG: "Stablecoin Depeg",
  LIQUIDATION_EVENT: "Likuidasi Besar / Squeeze",
  FED_SPEECH: "Pidato / Pernyataan Pejabat Fed",
  GDP_GROWTH: "GDP / Pertumbuhan Ekonomi",
  PMI_ACTIVITY: "PMI / Aktivitas Bisnis",
  RETAIL_SALES: "Retail Sales",
  JOBLESS_CLAIMS: "Initial Jobless Claims",
});

const NEWS_EVENT_TYPE_LIST = Object.freeze(Object.keys(NEWS_EVENT_TIERS));
const REQUIRED_NEWS_TYPES = new Set(NEWS_EVENT_TYPE_LIST);

module.exports = {
  NEWS_EVENT_TIERS,
  NEWS_EVENT_LABELS,
  NEWS_EVENT_TYPE_LIST,
  REQUIRED_NEWS_TYPES,
};
