-- AlterTable: tambah kolom tpMode ke Bot
-- "full"    → posisi lari ke TP penuh (default, reward optimal)
-- "partial" → partial close +1R/+2R + SL trailing (risiko lebih rendah)
ALTER TABLE "Bot" ADD COLUMN "tpMode" TEXT NOT NULL DEFAULT 'full';
