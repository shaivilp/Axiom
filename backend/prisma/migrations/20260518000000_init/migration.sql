-- CreateEnum
CREATE TYPE "AccountAuthType" AS ENUM ('offline', 'microsoft');

-- CreateEnum
CREATE TYPE "AccountState" AS ENUM ('idle', 'authenticating', 'connecting', 'connected', 'disconnected', 'reconnecting', 'failed');

-- CreateEnum
CREATE TYPE "AccountDesiredState" AS ENUM ('running', 'stopped');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "ordinal" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "authType" "AccountAuthType" NOT NULL,
    "serverHost" TEXT NOT NULL,
    "serverPort" INTEGER NOT NULL DEFAULT 25565,
    "version" TEXT NOT NULL DEFAULT '1.8.9',
    "autoConnect" BOOLEAN NOT NULL DEFAULT true,
    "desiredState" "AccountDesiredState" NOT NULL DEFAULT 'running',
    "behaviors" JSONB NOT NULL DEFAULT '{}',
    "lastState" "AccountState" NOT NULL DEFAULT 'idle',
    "lastError" TEXT,
    "lastConnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_tokens" (
    "accountId" UUID NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_tokens_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" UUID NOT NULL,
    "defaultServerHost" TEXT,
    "defaultServerPort" INTEGER DEFAULT 25565,
    "defaultVersion" TEXT DEFAULT '1.8.9',
    "defaultBehaviors" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_ordinal_key" ON "accounts"("ordinal");

-- CreateIndex
CREATE INDEX "accounts_username_idx" ON "accounts"("username");

-- AddForeignKey
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

