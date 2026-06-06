/**
 * PM2 — production (port 3000) + staging (port 3001)
 *
 * Production (dari folder prod):
 *   pm2 start ecosystem.config.js --only quantara
 *
 * Staging (dari /opt/quantara-staging/be-bot-trading):
 *   pm2 start ecosystem.config.js --only quantara-staging
 */
module.exports = {
  apps: [
    {
      name:          "quantara",
      script:        "index.js",
      cwd:           __dirname,
      instances:     1,
      autorestart:   true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT:     3000,
      },
    },
    {
      name:          "quantara-staging",
      script:        "index.js",
      cwd:           __dirname,
      instances:     1,
      autorestart:   true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT:     3001,
      },
    },
  ],
};
