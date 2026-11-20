-- DropForeignKey
ALTER TABLE "PushToken" DROP CONSTRAINT IF EXISTS "PushToken_userId_fkey";

-- DropTable
DROP TABLE IF EXISTS "PushToken";

-- AlterTable
ALTER TABLE "User" DROP COLUMN IF EXISTS "notificationPreferences";
