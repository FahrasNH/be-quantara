// ─────────────────────────────────────────────────────────────────────────────
// ecosystem.config.new.js — PM2 config untuk struktur baru (Option B)
// Salin ke:
//   /opt/quantara-prod/be/ecosystem.config.js
//   /opt/quantara-staging/be/ecosystem.config.js (dengan nama app berbeda)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  apps: [
    // ──── PRODUCTION ─────────────────────────────────────────────────────────
    {
      name: 'be-quantara-prod',
      script: 'src/server/app.js',
      cwd: '/opt/quantara-prod/be',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production'
      },
      // ── Performance & reliability ───────────────────────────────────────────
      max_memory_restart: '512M',
      autorestart: true,
      max_restarts: 5,        // stop restarting jika crash >5x dalam min_uptime
      min_uptime: '10s',      // definisi "crash" = restart dalam <10s
      restart_delay: 4000,    // tunggu 4s sebelum restart (avoid crash loop)
      kill_timeout: 5000,     // tunggu 5s sebelum SIGKILL (graceful shutdown)

      // ── Logging ─────────────────────────────────────────────────────────────
      error_file: '/var/log/pm2/be-quantara-prod-error.log',
      out_file: '/var/log/pm2/be-quantara-prod-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    },

    // ──── STAGING ────────────────────────────────────────────────────────────
    // (Uncomment & deploy di staging folder jika perlu)
    // {
    //   name: 'be-quantara-staging',
    //   script: 'src/server/app.js',
    //   cwd: '/opt/quantara-staging/be',
    //   instances: 1,
    //   exec_mode: 'cluster',
    //   env: {
    //     NODE_ENV: 'production'  // atau 'staging' jika ada beda config
    //   },
    //   max_memory_restart: '512M',
    //   autorestart: true,
    //   max_restarts: 5,
    //   min_uptime: '10s',
    //   restart_delay: 4000,
    //   kill_timeout: 5000,
    //   error_file: '/var/log/pm2/be-quantara-staging-error.log',
    //   out_file: '/var/log/pm2/be-quantara-staging-out.log',
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    //   merge_logs: true
    // }
  ]
};
