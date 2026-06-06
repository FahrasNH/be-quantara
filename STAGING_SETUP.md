# Staging Setup — Quantara (VPS sama, IP-only)

Production dan staging berjalan berdampingan di VPS `187.77.135.156`:

| Lingkungan | URL | BE port | nginx |
|------------|-----|---------|-------|
| Production | `http://187.77.135.156` | 3000 | 80 |
| Staging | `http://187.77.135.156:8080` | 3001 | 8080 |

## Quick start

### 1. Backend staging (di VPS)

```bash
scp scripts/setup-staging-vps.sh root@187.77.135.156:/tmp/
ssh root@187.77.135.156 'bash /tmp/setup-staging-vps.sh'
```

Script ini akan:
- Buat DB `bot_trading_staging` + user `quantara_staging`
- Clone repo ke `/opt/quantara-staging/be-bot-trading`
- Generate `.env` dari [`.env.staging.example`](.env.staging.example)
- `prisma migrate deploy` + PM2 `quantara-staging` (port 3001)
- Aktifkan nginx port 8080

### 2. Frontend staging (dari repo fe-quantara)

```bash
cd fe-bot-trading   # repo terpisah
chmod +x deploy-staging.sh
./deploy-staging.sh
```

Env build: `.env.staging` (`VITE_API_URL=http://187.77.135.156:8080`).

### 3. Verifikasi

```bash
curl http://187.77.135.156:8080/api/v1/health
```

## File referensi (BE repo)

| File | Fungsi |
|------|--------|
| [`.env.staging.example`](.env.staging.example) | Template env BE staging |
| [`ecosystem.config.js`](ecosystem.config.js) | PM2 prod + staging |
| [`nginx/quantara-staging.conf.example`](nginx/quantara-staging.conf.example) | nginx port 8080 |
| [`scripts/setup-staging-vps.sh`](scripts/setup-staging-vps.sh) | Setup otomatis di VPS |

## Vercel (fase berikutnya)

Butuh HTTPS di backend sebelum FE staging bisa di-host di Vercel. Lihat `vercel.json.example` di repo fe-quantara.
