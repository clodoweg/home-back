-- CreateTable
CREATE TABLE "PetkitDeviceDay" (
    "deviceId" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PetkitDeviceDay_pkey" PRIMARY KEY ("deviceId","day")
);
