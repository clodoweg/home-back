/*
  Warnings:

  - The primary key for the `SystemSettings` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `key` on the `SystemSettings` table. All the data in the column will be lost.
  - You are about to drop the column `value` on the `SystemSettings` table. All the data in the column will be lost.
  - You are about to drop the `AuditLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PetkitDeviceDay` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PetkitFountainDay` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PetkitImage` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "SystemSettings" DROP CONSTRAINT "SystemSettings_pkey",
DROP COLUMN "key",
DROP COLUMN "value",
ADD COLUMN     "apiEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "id" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "AuditLog";

-- DropTable
DROP TABLE "PetkitDeviceDay";

-- DropTable
DROP TABLE "PetkitFountainDay";

-- DropTable
DROP TABLE "PetkitImage";

-- CreateTable
CREATE TABLE "SystemState" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "SystemState_pkey" PRIMARY KEY ("key")
);
