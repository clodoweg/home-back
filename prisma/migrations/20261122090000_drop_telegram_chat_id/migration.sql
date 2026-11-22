-- Telegram notifications removed: alerts go to the bell and Web Push only.
ALTER TABLE "User" DROP COLUMN "telegramChatId";
