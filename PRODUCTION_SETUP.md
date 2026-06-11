# Production Deploy — Quantara

> **Panduan deploy utama:** [DEPLOY_QUICK_START.md](../DEPLOY_QUICK_START.md)

Production berjalan di VPS `quantara.software` — nginx port **80/443** + backend PM2 **`quantara`** port **3000**.
Staging berjalan pada subdomain `staging.quantara.software` — nginx port **8080** + backend PM2 **`quantara-staging`** port **3001**.

| Lingkungan | URL | PM2 | BE path | FE path |
|------------|-----|-----|---------|---------|
| Production | `https://quantara.software` | `quantara` | `/opt/quantara/be` | `/var/www/quantara/fe` |
| Staging | `https://staging.quantara.software:8080` | `quantara-staging` | `/opt/quantara-staging/be` | `/var/www/quantara-staging/fe` |

## Deploy production

```bash
cd fe-bot-trading
git pull origin main
chmod +x deploy-production.sh
./deploy-production.sh              # FE + BE
./deploy-production.sh --fe-only    # hanya frontend
./deploy-production.sh --be-only      # hanya backend
```

Atau langsung di VPS:

```bash
cd /opt/quantara/be
./scripts/deploy-production-vps.sh
```

## TLS / HTTPS

```bash
DOMAIN=quantara.software EMAIL=your@email.com bash scripts/setup-tls-https.sh
```

## Skrip terkait

| File | Peran |
|------|-------|
| [`fe-bot-trading/deploy-production.sh`](../fe-bot-trading/deploy-production.sh) | Deploy FE + BE dari lokal |
| [`scripts/deploy-production-vps.sh`](scripts/deploy-production-vps.sh) | Deploy BE di VPS |

## Alur disarankan

1. Uji di **staging** (`./deploy-staging.sh` dari branch `staging`)
2. Jika OK → merge ke `main` → **production** (`./deploy-production.sh`)
