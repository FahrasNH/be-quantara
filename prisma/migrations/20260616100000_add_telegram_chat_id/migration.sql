-- Add telegramChatId to User model for per-user Telegram bot integration
-- Users set this via Settings → Telegram after messaging @quantara_trading_bot

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramChatId" TEXT;
