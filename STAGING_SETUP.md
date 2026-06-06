# Staging Setup — Quantara (VPS sama, IP-only)

Production dan staging berjalan berdampingan di VPS `187.77.135.156`:

| Lingkungan | URL | BE port | PM2 | FE path |
|------------|-----|---------|-----|---------|
| Production | `http://187.77.135.156` | 3000 | `be-quantara` | `/var/www/quantara` |
| Staging | `http://187.77.135.156:8080` | 3001 | `quantara-staging` | `/var/www/quantara-staging` |

## First-time setup (sekali saja)

Backend staging belum pernah di-setup? Jalankan dari repo **be-quantara**:

```bash
cd be-bot-trading
scp scripts/setup-staging-vps.sh root@187.77.135.156:/tmp/
ssh root@187.77.135.156 'bash /tmp/setup-staging-vps.sh'
```

## Deploy staging (FE + BE sekaligus)

```bash
cd fe-bot-trading
git pull origin main
chmod +x deploy-staging.sh
./deploy-staging.sh
```

### Opsi partial

```bash
./deploy-staging.sh --fe-only   # hanya frontend
./deploy-staging.sh --be-only   # hanya backend
```

### Deploy BE saja (dari repo backend)

```bash
cd be-bot-trading
git pull origin main
chmod +x scripts/deploy-staging.sh
./scripts/deploy-staging.sh
```

## Environment variables (override)

```bash
export VPS_HOST=root@187.77.135.156
export REMOTE_BE=/opt/quantara-staging/be-bot-trading
export PM2_APP=quantara-staging
export SKIP_CONFIRM=1   # non-interaktif
```

## Verifikasi

```bash
curl http://187.77.135.156:8080/api/v1/health
```

Browser: `http://187.77.135.156:8080` → register user baru (DB terpisah) → start bot **Dry Run**.

## File referensi

| File | Fungsi |
|------|--------|
| [`fe-bot-trading/deploy-staging.sh`](../fe-bot-trading/deploy-staging.sh) | Deploy FE + BE dari repo frontend |
| [`scripts/deploy-staging.sh`](scripts/deploy-staging.sh) | Deploy BE saja via SSH |
| [`scripts/deploy-staging-vps.sh`](scripts/deploy-staging-vps.sh) | Pull + migrate + restart (jalan di VPS) |
| [`scripts/setup-staging-vps.sh`](scripts/setup-staging-vps.sh) | Setup awal staging |
| [`.env.staging.example`](.env.staging.example) | Template env BE staging |
| [`nginx/quantara-staging.conf.example`](nginx/quantara-staging.conf.example) | nginx port 8080 |

## Production

Lihat [PRODUCTION_SETUP.md](PRODUCTION_SETUP.md) untuk deploy production.

## Vercel (fase berikutnya)

Butuh HTTPS di backend sebelum FE staging bisa di-host di Vercel. Lihat `vercel.json.example` di repo fe-quantara.
