-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notificationPreferences" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "PetkitImage" (
    "id" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PetkitImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PetkitFountainDay" (
    "deviceId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workRecords" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "PetkitFountainDay_pkey" PRIMARY KEY ("deviceId","day")
);

-- CreateIndex
CREATE INDEX "PetkitImage_createdAt_idx" ON "PetkitImage"("createdAt");

-- CreateIndex
CREATE INDEX "PetkitFountainDay_updatedAt_idx" ON "PetkitFountainDay"("updatedAt");

-- CreateIndex
CREATE INDEX "PetkitDeviceDay_updatedAt_idx" ON "PetkitDeviceDay"("updatedAt");
