-- AlterTable
ALTER TABLE "User" ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "notificationPreferences" JSONB NOT NULL DEFAULT '{}';
