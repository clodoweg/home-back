-- CreateTable
CREATE TABLE "DailyUsage" (
    "date" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyUsage_pkey" PRIMARY KEY ("date","metric")
);

-- CreateIndex
CREATE INDEX "DailyUsage_metric_date_idx" ON "DailyUsage"("metric", "date");
