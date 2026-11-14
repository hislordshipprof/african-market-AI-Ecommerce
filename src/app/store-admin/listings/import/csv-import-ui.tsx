"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import Link from "next/link";
import { toast } from "sonner";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  csvPreviewAction,
  csvCommitAction,
  type PreviewActionResult,
} from "@/lib/listing/csv-import-actions";
import { needsWeightSentence } from "../needs-weight";
import { CSV_FILE_CAP_BYTES, CSV_FILE_TOO_LARGE_MESSAGE } from "@/lib/listing/csv-file-cap";
import type {
  CsvPreviewResult,
  CsvPreviewMatch,
  CsvPreviewNew,
  CsvPreviewAlreadyListed,
  CsvPreviewError,
  CsvPreviewDuplicate,
  CsvPreviewAmbiguous,
  CommitSelection,
} from "@/lib/listing/csv-import";
import {
  ArrowLeft,
  Upload,
  CheckCircle2,
  PlusCircle,
  AlertCircle,
  Ban,
  Copy,
  HelpCircle,
  FileSpreadsheet,
} from "lucide-react";

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

interface Props {
  storeName: string;
  storeSlug: string;
}

type Step = "upload" | "preview" | "success";

export function CsvImportUi({ storeName, storeSlug }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [isPending, startTransition] = useTransition();
  const [preview, setPreview] = useState<CsvPreviewResult | null>(null);
  const [createdCount, setCreatedCount] = useState(0);
  const [needsWeightCount, setNeedsWeightCount] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [selectedMatches, setSelectedMatches] = useState<Set<number>>(new Set());
  const [selectedNew, setSelectedNew] = useState<Set<number>>(new Set());
  const [ambiguousResolutions, setAmbiguousResolutions] = useState<Map<number, string>>(new Map());

  function clearSelections() {
    setSelectedMatches(new Set());
    setSelectedNew(new Set());
    setAmbiguousResolutions(new Map());
  }

  function applyPreviewDefaults(next: CsvPreviewResult) {
    setPreview(next);
    setSelectedMatches(new Set(next.matches.map((match) => match.row)));
    setSelectedNew(new Set(next.newItems.map((item) => item.row)));
    setAmbiguousResolutions(new Map());
  }

  function resetImport() {
    setStep("upload");
    setPreview(null);
    setSelectedFile(null);
    setCreatedCount(0);
    setNeedsWeightCount(0);
    clearSelections();
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleFileChange(file: File | null) {
    if (!file) return;
    setSelectedFile(file);
  }

  function handleUpload() {
    if (!selectedFile) return;

    if (selectedFile.size > CSV_FILE_CAP_BYTES) {
      toast.error(CSV_FILE_TOO_LARGE_MESSAGE);
      return;
    }

    startTransition(async () => {
      const fd = new FormData();
      fd.append("file", selectedFile);

      let res: PreviewActionResult;
      try {
        res = await csvPreviewAction(fd);
      } catch {
        toast.error("Upload failed. The file may be too large or the server is unavailable.");
        return;
      }

      if (res.error) {
        toast.error(res.error);
        return;
      }

      if (res.preview) {
        applyPreviewDefaults(res.preview);
        setStep("preview");
      }
    });
  }

  function handleCommit() {
    if (!preview) return;

    const selection: CommitSelection = {
      matchedRows: [...selectedMatches],
      newItemRows: [...selectedNew],
      ambiguousResolutions: [...ambiguousResolutions.entries()].map(([row, masterProductId]) => ({
        row,
        masterProductId,
      })),
      matchedIdentities: preview.matches
        .filter((match) => selectedMatches.has(match.row))
        .map((match) => ({ row: match.row, masterProductId: match.masterProductId })),
    };

    if (
      selection.matchedRows.length === 0 &&
      selection.newItemRows.length === 0 &&
      selection.ambiguousResolutions.length === 0
    ) {
      toast.error("Select at least one row to import.");
      return;
    }

    startTransition(async () => {
      let res: Awaited<ReturnType<typeof csvCommitAction>>;
      try {
        res = await csvCommitAction(preview.importToken, selection);
      } catch (error) {
        if (isRedirectError(error)) throw error;
        toast.error("We couldn't confirm the import. Press Import again. Nothing will be imported twice.");
        return;
      }

      if (res.error) {
        toast.error(res.error);
        return;
      }

      if (res.result) {
        setCreatedCount(res.result.createdCount);
        setNeedsWeightCount(res.result.needsWeightCount);
        setStep("success");
        toast.success(
          `Imported ${countPhrase(res.result.createdCount, "listing", "listings")}.`,
        );
      }
    });
  }

  function toggleMatch(row: number) {
    setSelectedMatches((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
  }

  function toggleNew(row: number) {
    setSelectedNew((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
  }

  function selectAllMatches() {
    if (!preview) return;
    setSelectedMatches(new Set(preview.matches.map((m) => m.row)));
  }

  function deselectAllMatches() {
    setSelectedMatches(new Set());
  }

  function selectAllNew() {
    if (!preview) return;
    setSelectedNew(new Set(preview.newItems.map((n) => n.row)));
  }

  function deselectAllNew() {
    setSelectedNew(new Set());
  }

  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-ink)]">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <Link
            href={`/store-admin/listings?store=${storeSlug}`}
            className="inline-flex items-center gap-1 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Products
          </Link>
        </div>

        <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] mb-1">
          Import listings
        </h1>
        <p className="text-sm text-[var(--color-muted)] mb-6">
          Upload a CSV file to add listings to {storeName}.
        </p>

        <AnimatePresence mode="wait">
          {step === "upload" && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <UploadStep
                selectedFile={selectedFile}
                dragOver={dragOver}
                setDragOver={setDragOver}
                onFileChange={handleFileChange}
                onUpload={handleUpload}
                isPending={isPending}
                fileRef={fileRef}
              />
            </motion.div>
          )}

          {step === "preview" && preview && (
            <motion.div
              key="preview"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <PreviewStep
                preview={preview}
                selectedMatches={selectedMatches}
                selectedNew={selectedNew}
                ambiguousResolutions={ambiguousResolutions}
                toggleMatch={toggleMatch}
                toggleNew={toggleNew}
                selectAllMatches={selectAllMatches}
                deselectAllMatches={deselectAllMatches}
                selectAllNew={selectAllNew}
                deselectAllNew={deselectAllNew}
                onResolveAmbiguous={(row, masterProductId) => {
                  setAmbiguousResolutions((prev) => {
                    const next = new Map(prev);
                    if (masterProductId) next.set(row, masterProductId);
                    else next.delete(row);
                    return next;
                  });
                }}
                onCommit={handleCommit}
                onBack={resetImport}
                isPending={isPending}
              />
            </motion.div>
          )}

          {step === "success" && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
            >
              <SuccessStep
                createdCount={createdCount}
                needsWeightCount={needsWeightCount}
                onGoToProducts={() =>
                  router.push(`/store-admin/listings?store=${storeSlug}`)
                }
                onImportMore={resetImport}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
    </MotionConfig>
  );
}

/* ── Upload Step ────────────────────────────────────────────────── */

function UploadStep({
  selectedFile,
  dragOver,
  setDragOver,
  onFileChange,
  onUpload,
  isPending,
  fileRef,
}: {
  selectedFile: File | null;
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  onFileChange: (f: File | null) => void;
  onUpload: () => void;
  isPending: boolean;
  fileRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5" />
          Upload CSV
        </CardTitle>
        <CardDescription>
          Your CSV must have <code className="rounded bg-[var(--color-raised)] px-1 py-0.5 text-xs">name</code> and{" "}
          <code className="rounded bg-[var(--color-raised)] px-1 py-0.5 text-xs">price</code> columns. Optional:{" "}
          <code className="rounded bg-[var(--color-raised)] px-1 py-0.5 text-xs">stock_mode</code>,{" "}
          <code className="rounded bg-[var(--color-raised)] px-1 py-0.5 text-xs">qty</code>,{" "}
          <code className="rounded bg-[var(--color-raised)] px-1 py-0.5 text-xs">status</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
            dragOver
              ? "border-[var(--color-primary)] bg-[var(--color-soft)]"
              : "border-[var(--color-line)] bg-[var(--color-bg)]"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) onFileChange(file);
          }}
        >
          <Upload className="mb-3 h-8 w-8 text-[var(--color-muted)]" />
          <p className="mb-1 text-sm font-medium">
            {selectedFile ? selectedFile.name : "Drop your CSV here, or click to browse"}
          </p>
          {selectedFile && (
            <p className="text-xs text-[var(--color-muted)]">
              {(selectedFile.size / 1024).toFixed(1)} KB
            </p>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="absolute inset-0 cursor-pointer opacity-0"
            onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            onClick={onUpload}
            disabled={!selectedFile || isPending}
          >
            {isPending ? "Uploading..." : "Upload & Preview"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Preview Step ───────────────────────────────────────────────── */

function PreviewStep({
  preview,
  selectedMatches,
  selectedNew,
  ambiguousResolutions,
  toggleMatch,
  toggleNew,
  selectAllMatches,
  deselectAllMatches,
  selectAllNew,
  deselectAllNew,
  onResolveAmbiguous,
  onCommit,
  onBack,
  isPending,
}: {
  preview: CsvPreviewResult;
  selectedMatches: Set<number>;
  selectedNew: Set<number>;
  ambiguousResolutions: Map<number, string>;
  toggleMatch: (row: number) => void;
  toggleNew: (row: number) => void;
  selectAllMatches: () => void;
  deselectAllMatches: () => void;
  selectAllNew: () => void;
  deselectAllNew: () => void;
  onResolveAmbiguous: (row: number, masterProductId: string | null) => void;
  onCommit: () => void;
  onBack: () => void;
  isPending: boolean;
}) {
  const totalSelected = selectedMatches.size + selectedNew.size + ambiguousResolutions.size;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <SummaryCard
          icon={<CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />}
          label="Matched"
          count={preview.matches.length}
        />
        <SummaryCard
          icon={<PlusCircle className="h-4 w-4 text-[var(--color-primary)]" />}
          label="New"
          count={preview.newItems.length}
        />
        <SummaryCard
          icon={<HelpCircle className="h-4 w-4 text-[var(--color-deal)]" />}
          label="Ambiguous"
          count={preview.ambiguous.length}
        />
        <SummaryCard
          icon={<AlertCircle className="h-4 w-4 text-destructive" />}
          label="Errors"
          count={preview.errors.length}
        />
        <SummaryCard
          icon={<Ban className="h-4 w-4 text-[var(--color-muted)]" />}
          label="Already listed"
          count={preview.alreadyListed.length}
        />
      </div>

      {preview.unknownColumns.length > 0 && (
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] px-4 py-3 text-sm">
          <span className="font-medium">Unknown columns ignored:</span>{" "}
          {preview.unknownColumns.join(", ")}
        </div>
      )}

      {/* Matched products */}
      {preview.matches.length > 0 && (
        <PreviewSection
          title="Matched listings"
          subtitle="These CSV rows matched a master product."
          icon={<CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />}
          selectAll={selectAllMatches}
          deselectAll={deselectAllMatches}
          allSelected={selectedMatches.size === preview.matches.length}
        >
          <div className="divide-y divide-[var(--color-line)]">
            {preview.matches.map((m) => (
              <MatchRow
                key={m.row}
                match={m}
                selected={selectedMatches.has(m.row)}
                onToggle={() => toggleMatch(m.row)}
              />
            ))}
          </div>
        </PreviewSection>
      )}

      {/* New items */}
      {preview.newItems.length > 0 && (
        <PreviewSection
          title="New listings"
          subtitle="No master product match — will be created as custom listings."
          icon={<PlusCircle className="h-4 w-4 text-[var(--color-primary)]" />}
          selectAll={selectAllNew}
          deselectAll={deselectAllNew}
          allSelected={selectedNew.size === preview.newItems.length}
        >
          <div className="divide-y divide-[var(--color-line)]">
            {preview.newItems.map((n) => (
              <NewRow
                key={n.row}
                item={n}
                selected={selectedNew.has(n.row)}
                onToggle={() => toggleNew(n.row)}
              />
            ))}
          </div>
        </PreviewSection>
      )}

      {/* Ambiguous */}
      {preview.ambiguous.length > 0 && (
        <PreviewSection
          title="Ambiguous Matches"
          subtitle="Multiple master products match — select one per row to import."
          icon={<HelpCircle className="h-4 w-4 text-[var(--color-muted)]" />}
        >
          <div className="divide-y divide-[var(--color-line)]">
            {preview.ambiguous.map((a) => (
              <AmbiguousRow
                key={a.row}
                item={a}
                selectedProductId={ambiguousResolutions.get(a.row) ?? null}
                onResolve={(mpId) => onResolveAmbiguous(a.row, mpId)}
              />
            ))}
          </div>
        </PreviewSection>
      )}

      {/* Already listed */}
      {preview.alreadyListed.length > 0 && (
        <PreviewSection
          title="Already Listed"
          subtitle="Already listed in your store. These rows will be skipped."
          icon={<Ban className="h-4 w-4 text-[var(--color-muted)]" />}
        >
          <div className="divide-y divide-[var(--color-line)]">
            {preview.alreadyListed.map((a) => (
              <AlreadyListedRow key={a.row} item={a} />
            ))}
          </div>
        </PreviewSection>
      )}

      {/* Duplicates */}
      {preview.duplicates.length > 0 && (
        <PreviewSection
          title="Duplicate Rows"
          subtitle="These rows duplicate an earlier row in the file — they are skipped."
          icon={<Copy className="h-4 w-4 text-[var(--color-muted)]" />}
        >
          <div className="divide-y divide-[var(--color-line)]">
            {preview.duplicates.map((d) => (
              <DuplicateRow key={d.row} item={d} />
            ))}
          </div>
        </PreviewSection>
      )}

      {/* Errors */}
      {preview.errors.length > 0 && (
        <PreviewSection
          title="Errors"
          subtitle="These rows have validation errors and cannot be imported."
          icon={<AlertCircle className="h-4 w-4 text-destructive" />}
        >
          <div className="divide-y divide-[var(--color-line)]">
            {preview.errors.map((e, i) => (
              <ErrorRow key={`${e.row}-${i}`} item={e} />
            ))}
          </div>
        </PreviewSection>
      )}

      {/* Action bar */}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/95 px-4 py-3 shadow-md backdrop-blur-sm">
        <Button variant="outline" onClick={onBack} disabled={isPending} className="shrink-0">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
        <div className="flex min-w-0 max-w-full flex-1 flex-wrap items-center justify-end gap-3">
          <span className="text-sm text-[var(--color-muted)] tabular-nums">
            {totalSelected} selected
          </span>
          <Button
            onClick={onCommit}
            disabled={totalSelected === 0 || isPending}
            className="h-auto max-w-full whitespace-normal px-3 py-2 text-center"
          >
            {isPending
              ? "Importing..."
              : `Import ${countPhrase(totalSelected, "listing", "listings")}`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Success Step ───────────────────────────────────────────────── */

function SuccessStep({
  createdCount,
  needsWeightCount,
  onGoToProducts,
  onImportMore,
}: {
  createdCount: number;
  needsWeightCount: number;
  onGoToProducts: () => void;
  onImportMore: () => void;
}) {
  const needsWeight = needsWeightSentence(needsWeightCount);
  return (
    <Card>
      <CardContent className="flex flex-col items-center py-12 text-center">
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.1 }}
        >
          <CheckCircle2 className="mb-4 h-12 w-12 text-[var(--color-success)]" />
        </motion.div>
        <h2 className="text-xl font-bold font-[family-name:var(--font-display)] mb-2">
          Import Complete
        </h2>
        <p className={needsWeight ? "mb-2 text-[var(--color-muted)]" : "mb-6 text-[var(--color-muted)]"}>
          Imported {createdCount} listing{createdCount !== 1 ? "s" : ""} successfully.
        </p>
        {needsWeight ? (
          <p className="mb-6 text-base font-medium text-foreground" data-needs-weight-count="">
            {needsWeight}
          </p>
        ) : null}
        <div className="flex gap-3">
          <Button variant="outline" onClick={onImportMore}>
            Import More
          </Button>
          <Button onClick={onGoToProducts}>Go to Products</Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Small components ───────────────────────────────────────────── */

function SummaryCard({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2">
      {icon}
      <div>
        <p className="text-lg font-bold leading-tight">{count}</p>
        <p className="text-xs text-[var(--color-muted)]">{label}</p>
      </div>
    </div>
  );
}

function PreviewSection({
  title,
  subtitle,
  icon,
  selectAll,
  deselectAll,
  allSelected,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  selectAll?: () => void;
  deselectAll?: () => void;
  allSelected?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
          {selectAll && deselectAll && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={allSelected ? deselectAll : selectAll}
            >
              {allSelected ? "Deselect all" : "Select all"}
            </Button>
          )}
        </div>
        <CardDescription className="text-xs">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

function MatchRow({
  match,
  selected,
  onToggle,
}: {
  match: CsvPreviewMatch;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-raised)] transition-colors">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="h-4 w-4 rounded border-[var(--color-line)] accent-[var(--color-primary)]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{match.csvName}</p>
        <p className="truncate text-xs text-[var(--color-muted)]">
          <CheckCircle2 className="mr-1 inline h-3 w-3 text-[var(--color-success)]" />
          {match.matchType === "exact" ? "Exact" : "Synonym"} match:{" "}
          {match.masterProductName}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {match.frozen && <Badge variant="secondary">Frozen</Badge>}
        {match.perishable && <Badge variant="secondary">Perishable</Badge>}
      </div>
    </label>
  );
}

function NewRow({
  item,
  selected,
  onToggle,
}: {
  item: CsvPreviewNew;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-raised)] transition-colors">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="h-4 w-4 rounded border-[var(--color-line)] accent-[var(--color-primary)]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.csvName}</p>
        <p className="truncate text-xs text-[var(--color-muted)]">
          <PlusCircle className="mr-1 inline h-3 w-3 text-[var(--color-primary)]" />
          Will be created as a custom listing
        </p>
      </div>
    </label>
  );
}

function AmbiguousRow({
  item,
  selectedProductId,
  onResolve,
}: {
  item: CsvPreviewAmbiguous;
  selectedProductId: string | null;
  onResolve: (masterProductId: string | null) => void;
}) {
  return (
    <div className="px-4 py-2.5">
      <p className="truncate text-sm font-medium">{item.csvName}</p>
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        <HelpCircle className="mr-1 inline h-3 w-3" />
        Matches {countPhrase(item.candidates.length, "master product", "master products")} — select one:
      </p>
      <div className="ml-1 space-y-1">
        {item.candidates.map((c) => (
          <label
            key={c.masterProductId}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-[var(--color-raised)] transition-colors"
          >
            <input
              type="radio"
              name={`ambiguous-${item.row}`}
              checked={selectedProductId === c.masterProductId}
              onChange={() => onResolve(c.masterProductId)}
              className="h-3.5 w-3.5 accent-[var(--color-primary)]"
            />
            <span className="text-sm">{c.masterProductName}</span>
            <Badge variant="secondary" className="text-[10px]">
              {c.matchType === "exact" ? "Exact" : "Synonym"}
            </Badge>
          </label>
        ))}
        {selectedProductId && (
          <button
            type="button"
            className="ml-2 text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
            onClick={() => onResolve(null)}
          >
            Clear selection
          </button>
        )}
      </div>
    </div>
  );
}

function AlreadyListedRow({ item }: { item: CsvPreviewAlreadyListed }) {
  return (
    <div className="px-4 py-2.5">
      <p className="truncate text-sm font-medium">{item.csvName}</p>
      <p className="text-xs text-[var(--color-muted)]">
        <Ban className="mr-1 inline h-3 w-3" />
        Already listed as {item.masterProductName}
      </p>
    </div>
  );
}

function DuplicateRow({ item }: { item: CsvPreviewDuplicate }) {
  return (
    <div className="px-4 py-2.5">
      <p className="truncate text-sm font-medium">{item.csvName}</p>
      <p className="text-xs text-[var(--color-muted)]">
        <Copy className="mr-1 inline h-3 w-3" />
        Duplicate of row {item.firstRow}
      </p>
    </div>
  );
}

function ErrorRow({ item }: { item: CsvPreviewError }) {
  return (
    <div className="px-4 py-2.5">
      <p className="truncate text-sm font-medium text-destructive">
        {item.csvName ?? `Row ${item.row}`}
      </p>
      <p className="text-xs text-destructive">
        <AlertCircle className="mr-1 inline h-3 w-3 text-destructive" />
        {item.reason}
      </p>
    </div>
  );
}
