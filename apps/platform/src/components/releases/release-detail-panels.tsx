"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PlatformMachineReleaseStorageRetentionState } from "@air-jam/sdk/platform-machine";
import {
  Activity,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Package,
} from "lucide-react";

const formatDateTime = (value?: Date | string | null): string => {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

const formatBytes = (value?: number | null): string => {
  if (!value || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
};

const formatCheckKind = (value: string): string =>
  value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

type ReleaseGenerationDetail = {
  id: string;
  sequence: number;
  status: "awaiting_upload" | "processing" | "ready" | "failed" | "abandoned";
  originalFilename: string;
  declaredSizeBytes: number;
  observedSizeBytes: number | null;
  extractedSizeBytes: number | null;
  fileCount: number | null;
  contentHash: string | null;
  storageRetention: {
    state: PlatformMachineReleaseStorageRetentionState;
  };
};

type ReleaseDetailPanelsProps = {
  generations: ReleaseGenerationDetail[];
  candidateGeneration: ReleaseGenerationDetail | null;
  promotedGeneration: ReleaseGenerationDetail | null;
  checks: Array<{
    id: string;
    generationId: string;
    kind: string;
    status: "pending" | "passed" | "failed" | "warning";
    summary: string | null;
    createdAt: Date | string;
  }>;
  jobs: Array<{
    id: string;
    generationId: string;
    kind: string;
    status: string;
    attemptCount: number;
    maxAttempts: number;
    progressStage: string | null;
    progressMessage: string | null;
    lastErrorCode: string | null;
    createdAt: Date | string;
  }>;
  reports: Array<{
    id: string;
    reason: string;
    status: string;
    details: string | null;
    createdAt: Date | string;
    reporterEmail: string | null;
  }>;
  exportingGenerationId?: string | null;
  onExportGeneration?: (generationId: string) => void;
};

export function ReleaseDetailPanels({
  generations,
  candidateGeneration,
  promotedGeneration,
  checks,
  jobs,
  reports,
  exportingGenerationId,
  onExportGeneration,
}: ReleaseDetailPanelsProps) {
  const generationSequenceById = new Map(
    generations.map((generation) => [generation.id, generation.sequence]),
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wider uppercase">
          <Package className="h-3 w-3" />
          Generations
        </div>
        {generations.length > 0 ? (
          <div className="space-y-2">
            {generations.map((generation) => {
              const isPromoted = generation.id === promotedGeneration?.id;
              const isCandidate = generation.id === candidateGeneration?.id;

              return (
                <div
                  key={generation.id}
                  className="space-y-1.5 rounded-md border p-2.5 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">
                      Generation #{generation.sequence}
                    </span>
                    <Badge
                      variant={
                        generation.status === "ready"
                          ? "default"
                          : generation.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                      className="text-[10px]"
                    >
                      {generation.status.replace("_", " ")}
                    </Badge>
                    {isPromoted && (
                      <Badge variant="outline" className="text-[10px]">
                        Promoted
                      </Badge>
                    )}
                    {isCandidate && (
                      <Badge variant="secondary" className="text-[10px]">
                        Candidate
                      </Badge>
                    )}
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">File</span>
                    <span className="max-w-[65%] truncate text-right">
                      {generation.originalFilename}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">
                      {generation.observedSizeBytes === null
                        ? "Declared"
                        : "Uploaded"}
                    </span>
                    <span>
                      {formatBytes(
                        generation.observedSizeBytes ??
                          generation.declaredSizeBytes,
                      )}
                    </span>
                  </div>
                  {generation.extractedSizeBytes !== null && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Extracted</span>
                      <span>{formatBytes(generation.extractedSizeBytes)}</span>
                    </div>
                  )}
                  {generation.fileCount !== null && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Files</span>
                      <span>{generation.fileCount.toLocaleString()}</span>
                    </div>
                  )}
                  {generation.contentHash && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Hash</span>
                      <code className="max-w-[65%] truncate text-right text-[11px]">
                        {generation.contentHash}
                      </code>
                    </div>
                  )}
                  {onExportGeneration &&
                    generation.storageRetention.state !== "deleting" &&
                    generation.storageRetention.state !== "tombstoned" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        disabled={Boolean(exportingGenerationId)}
                        onClick={() => onExportGeneration(generation.id)}
                      >
                        {exportingGenerationId === generation.id ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Export archive
                      </Button>
                    )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No release generations yet.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wider uppercase">
          <Activity className="h-3 w-3" />
          Jobs
        </div>
        {jobs.length > 0 ? (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-md border p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {formatCheckKind(job.kind.replace(/^release_/, ""))}
                    </p>
                    {generationSequenceById.has(job.generationId) && (
                      <p className="text-muted-foreground text-[10px]">
                        Gen #{generationSequenceById.get(job.generationId)} ·
                        attempt {job.attemptCount}/{job.maxAttempts}
                      </p>
                    )}
                  </div>
                  <Badge
                    variant={
                      job.status === "succeeded"
                        ? "default"
                        : job.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                    className="text-[10px]"
                  >
                    {job.status.replace("_", " ")}
                  </Badge>
                </div>
                {(job.progressMessage || job.progressStage) && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {job.progressMessage ??
                      job.progressStage?.replaceAll("_", " ")}
                  </p>
                )}
                {job.lastErrorCode && (
                  <p className="text-destructive mt-1 text-xs">
                    {job.lastErrorCode.replaceAll("_", " ")}
                  </p>
                )}
                <p className="text-muted-foreground mt-1 truncate font-mono text-[10px]">
                  {job.id}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No jobs recorded yet.</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wider uppercase">
          <CheckCircle2 className="h-3 w-3" />
          Checks
        </div>
        {checks.length > 0 ? (
          <div className="space-y-2">
            {checks.map((check) => (
              <div key={check.id} className="rounded-md border p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">
                      {formatCheckKind(check.kind)}
                    </span>
                    {generationSequenceById.has(check.generationId) && (
                      <span className="text-muted-foreground shrink-0 text-[10px]">
                        Gen #{generationSequenceById.get(check.generationId)}
                      </span>
                    )}
                  </div>
                  <Badge
                    variant={
                      check.status === "passed"
                        ? "default"
                        : check.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                    className="text-[10px]"
                  >
                    {check.status}
                  </Badge>
                </div>
                {check.summary && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {check.summary}
                  </p>
                )}
                <p className="text-muted-foreground mt-1 text-[10px]">
                  {formatDateTime(check.createdAt)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No checks recorded yet.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wider uppercase">
          <FileText className="h-3 w-3" />
          Reports
        </div>
        {reports.length > 0 ? (
          <div className="space-y-2">
            {reports.map((report) => (
              <div key={report.id} className="rounded-md border p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{report.reason}</span>
                  <Badge
                    variant={
                      report.status === "open" ? "destructive" : "secondary"
                    }
                    className="text-[10px]"
                  >
                    {report.status}
                  </Badge>
                </div>
                {report.details && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {report.details}
                  </p>
                )}
                <p className="text-muted-foreground mt-1 text-[10px]">
                  {formatDateTime(report.createdAt)}
                  {report.reporterEmail ? ` · ${report.reporterEmail}` : ""}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No reports filed.</p>
        )}
      </div>
    </div>
  );
}
