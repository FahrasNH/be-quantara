# Production Deploy — Quantara

Production berjalan di VPS `187.77.135.156` port **80** (nginx) + backend PM2 **`be-quantara`** port **3000**.

| Lingkungan | URL | PM2 | FE path |
|------------|-----|-----|---------|
| Production | `http://187.77.135.156` | `be-quantara` | `/var/www/quantara` |
| Staging | `http://187.77.135.156:8080` | `quantara-staging` | `/var/www/quantara-staging` |

## Deploy cepat (dari mesin lokal)

### Full deploy (FE + BE)

```bash
cd fe-bot-trading
chmod +x deploy-production.sh
./deploy-production.sh
```

### Hanya frontend

```bash
./deploy-production.sh --fe-only
```

### Hanya backend

```bash
cd be-bot-trading
chmod +x scripts/deploy-production.sh
./scripts/deploy-production.sh
```

Atau langsung di VPS:

```bash
cd /opt/quantara/be-bot-trading   # sesuaikan path Anda
./scripts/deploy-production-vps.sh
```

## First-time setup production (VPS baru)

```bash
scp scripts/setup-production-vps.sh root@187.77.135.156:/tmp/
ssh root@187.77.135.156 'bash /tmp/setup-production-vps.sh'
```

Edit `.env` di server sebelum migrate jika belum pernah di-setup.

## Environment variables (override)

```bash
export VPS_HOST=root@187.77.135.156
export REMOTE_BE=/opt/quantara/be-bot-trading   # path repo BE di VPS
export PM2_APP=be-quantara                       # nama proses PM2
export SKIP_CONFIRM=1                            # non-interaktif (CI)
```

## File referensi

| File | Fungsi |
|------|--------|
| [`fe-bot-trading/deploy-production.sh`](../fe-bot-trading/deploy-production.sh) | Deploy FE + BE dari repo frontend |
| [`scripts/deploy-production.sh`](scripts/deploy-production.sh) | Deploy BE saja via SSH |
| [`scripts/deploy-production-vps.sh`](scripts/deploy-production-vps.sh) | Pull + migrate + restart (jalan di VPS) |
| [`scripts/setup-production-vps.sh`](scripts/setup-production-vps.sh) | Setup awal production |
| [`nginx/quantara-production.conf.example`](nginx/quantara-production.conf.example) | nginx port 80 |

## Verifikasi

```bash
curl http://187.77.135.156/api/v1/health
pm2 logs be-quantara --lines 50
```

## Alur disarankan

1. Uji di **staging** (`./deploy-staging.sh`)
2. Jika OK → **production** (`./deploy-production.sh`)
