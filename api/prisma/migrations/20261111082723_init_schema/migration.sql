-- CreateEnum
CREATE TYPE "Role" AS ENUM ('Admin', 'Devops', 'Viewer');

-- CreateEnum
CREATE TYPE "EnvName" AS ENUM ('Development', 'Staging', 'Production');

-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('Running', 'Stopped', 'Maintenance');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('Deployed', 'Failed', 'Building');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('Critical', 'Warning', 'Info');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('Active', 'Resolved');

-- CreateTable
CREATE TABLE "User" (
    "idUser" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "hashedPassword" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'Viewer',

    CONSTRAINT "User_pkey" PRIMARY KEY ("idUser")
);

-- CreateTable
CREATE TABLE "Project" (
    "idProject" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("idProject")
);

-- CreateTable
CREATE TABLE "TeamAssignment" (
    "idTeamAssign" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "TeamAssignment_pkey" PRIMARY KEY ("idTeamAssign")
);

-- CreateTable
CREATE TABLE "Environment" (
    "idEnv" TEXT NOT NULL,
    "name" "EnvName" NOT NULL DEFAULT 'Development',
    "projectId" TEXT NOT NULL,

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("idEnv")
);

-- CreateTable
CREATE TABLE "Server" (
    "idServer" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "cpuCores" INTEGER NOT NULL,
    "ramGb" INTEGER NOT NULL,
    "storageGb" INTEGER NOT NULL,
    "publicIp" TEXT NOT NULL,
    "privateIp" TEXT NOT NULL,
    "status" "ServerStatus" NOT NULL DEFAULT 'Running',
    "envId" TEXT NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("idServer")
);

-- CreateTable
CREATE TABLE "Application" (
    "idApp" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" "AppStatus" NOT NULL DEFAULT 'Deployed',
    "serverId" TEXT NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("idApp")
);

-- CreateTable
CREATE TABLE "Metric" (
    "idMetric" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuUsage" DOUBLE PRECISION NOT NULL,
    "memoryUsage" DOUBLE PRECISION NOT NULL,
    "diskUsage" DOUBLE PRECISION NOT NULL,
    "serverId" TEXT NOT NULL,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("idMetric")
);

-- CreateTable
CREATE TABLE "Alert" (
    "idAlert" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'Warning',
    "message" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'Active',
    "isConfigurable" BOOLEAN NOT NULL DEFAULT true,
    "serverId" TEXT NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("idAlert")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "TeamAssignment" ADD CONSTRAINT "TeamAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("idUser") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamAssignment" ADD CONSTRAINT "TeamAssignment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("idProject") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Environment" ADD CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("idProject") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_envId_fkey" FOREIGN KEY ("envId") REFERENCES "Environment"("idEnv") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("idServer") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("idServer") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("idServer") ON DELETE CASCADE ON UPDATE CASCADE;
