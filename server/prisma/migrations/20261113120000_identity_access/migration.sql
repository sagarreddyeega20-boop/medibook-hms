-- Identity & access: atomic counters for staff codes and MRNs.
CREATE TABLE "id_sequences" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_sequences_pkey" PRIMARY KEY ("key")
);
