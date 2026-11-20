-- CreateTable
CREATE TABLE "EnedisDailyConsumption" (
    "date" DATE NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnedisDailyConsumption_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "EnedisDailyMaxPower" (
    "date" DATE NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnedisDailyMaxPower_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "EnedisLoadCurve" (
    "date" TIMESTAMP(3) NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnedisLoadCurve_pkey" PRIMARY KEY ("date")
);
