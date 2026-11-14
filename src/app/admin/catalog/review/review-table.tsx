"use client";

import { useRef, useState, useTransition } from "react";
import type { ReviewProduct } from "@/lib/admin/catalog-actions";
import {
  approveProduct,
  proposeProductAttributes,
  rejectProduct,
  updateReviewProduct,
} from "@/lib/admin/catalog-actions";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  const color =
    confidence === "medium"
      ? "bg-[#E1EEE3] text-[#1F5A43] dark:bg-[#21412E] dark:text-[#6CC08F]"
      : "bg-[#B42335]/10 text-[#B42335] dark:bg-[#F28793]/15 dark:text-[#F28793]";
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {confidence ?? "unknown"}
    </span>
  );
}

const FOCUSABLE = "input, textarea, select, button, a[href], [tabindex]:not([tabindex='-1'])";

/**
 * Keep Tab inside the dialog. Base UI's focus guards sometimes park focus on <body> at the
 * end of the loop, after which the next Tab reaches the (non-inert) page behind it.
 */
function wrapTabFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-hidden") !== "true" &&
      el.getAttribute("type") !== "hidden",
  );
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === e.currentTarget)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function EditModal({
  product,
  open,
  onClose,
  onSaved,
}: {
  product: ReviewProduct;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? "");
  const [unit, setUnit] = useState(product.unit ?? "");
  const [storage, setStorage] = useState(product.storage ?? "");
  const [originCountries, setOriginCountries] = useState(product.originCountries ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const saveStarted = useRef(false);

  function handleSave() {
    // A click or Enter during the exit still reaches this control. Ignore it.
    // isPending is still false for a second click in the same turn, so the ref
    // closes that gap and is cleared when the update settles, including an error.
    if (!open || isPending || saveStarted.current) return;
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    saveStarted.current = true;
    startTransition(async () => {
      try {
        const result = await updateReviewProduct(product.id, {
          name: name.trim(),
          description: description.trim(),
          unit: unit.trim(),
          storage: storage.trim(),
          originCountries: originCountries.trim(),
        });
        if (result.error) {
          setError(result.error);
        } else {
          onSaved();
        }
      } finally {
        saveStarted.current = false;
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isPending && !saveStarted.current) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={false}
        aria-modal="true"
        onKeyDown={wrapTabFocus}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-bold">Edit product</DialogTitle>
          <DialogDescription className="dark:text-[#A3B1A7]">
            Changes are saved to the master catalog and recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-red-600">{error}</p>
        )}
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#A3B1A7]">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#35463B] dark:bg-[#0D1410] dark:text-[#EEF2EC]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#A3B1A7]">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#35463B] dark:bg-[#0D1410] dark:text-[#EEF2EC]"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#A3B1A7]">Unit</span>
              <input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#35463B] dark:bg-[#0D1410] dark:text-[#EEF2EC]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#A3B1A7]">Storage</span>
              <input
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#35463B] dark:bg-[#0D1410] dark:text-[#EEF2EC]"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#A3B1A7]">Origin countries</span>
            <input
              value={originCountries}
              onChange={(e) => setOriginCountries(e.target.value)}
              className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#35463B] dark:bg-[#0D1410] dark:text-[#EEF2EC]"
            />
          </label>
        </div>
        <DialogFooter className="border-[#DCDFD6] bg-transparent dark:border-[#35463B]">
          <Button
            type="button"
            variant="ghost"
            className="dark:text-[#EEF2EC] dark:hover:bg-[#2B3F33]"
            onClick={() => {
              if (open && !isPending && !saveStarted.current) onClose();
            }}
            aria-disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} aria-disabled={isPending || !open}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewTable({
  products,
  total,
  page,
  pageSize,
}: {
  products: ReviewProduct[];
  total: number;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const editSession = useRef(0);
  // The product stays after close so the exit animation still has its fields.
  // The next open replaces it and remounts the form.
  const [editing, setEditing] = useState<{ product: ReviewProduct; session: number } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function openProduct(product: ReviewProduct) {
    editSession.current += 1;
    setEditing({ product, session: editSession.current });
    setEditOpen(true);
  }

  function closeEdit(session: number) {
    if (session !== editSession.current) return;
    setEditOpen(false);
  }

  const totalPages = Math.ceil(total / pageSize);

  function handleApprove(productId: string) {
    setActionError(null);
    startTransition(async () => {
      const result = await approveProduct(productId);
      if (result.error) {
        setActionError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  function handleReject(productId: string) {
    setActionError(null);
    startTransition(async () => {
      const result = await rejectProduct(productId);
      if (result.error) {
        setActionError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  function handleProposeAttributes(productId: string) {
    setActionError(null);
    startTransition(async () => {
      const result = await proposeProductAttributes(productId);
      if (result.error) {
        setActionError(result.error);
      } else {
        router.push("/admin/catalog/review?status=attributes");
      }
    });
  }

  function goToPage(p: number) {
    const params = new URLSearchParams(window.location.search);
    params.set("page", String(p));
    router.push(`/admin/catalog/review?${params.toString()}`);
  }

  if (products.length === 0 && total === 0) {
    return (
      <div className="rounded-xl border border-[#DCDFD6] bg-white p-12 text-center dark:border-[#35463B] dark:bg-[#1E2C23]">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-50 dark:bg-green-950">
          <svg aria-hidden="true" className="h-6 w-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
          </svg>
        </div>
        <p className="text-sm font-medium text-[#55625A] dark:text-[#A3B1A7]">
          No products to review. All caught up!
        </p>
      </div>
    );
  }

  if (products.length === 0) {
    const lastPage = Math.max(1, totalPages);
    return (
      <div className="rounded-xl border border-[#DCDFD6] bg-white p-12 text-center dark:border-[#35463B] dark:bg-[#1E2C23]">
        <p className="text-sm font-medium text-[#15201A] dark:text-[#EEF2EC]">No items on this page.</p>
        <p className="mt-1 text-sm text-[#55625A] dark:text-[#A3B1A7]">
          {total} {total === 1 ? "product remains" : "products remain"} on other pages.
        </p>
        <Button type="button" variant="outline" className="mt-4 dark:border-[#71907D] dark:bg-transparent dark:text-[#EEF2EC] dark:hover:bg-[#2B3F33]" onClick={() => goToPage(lastPage)}>
          Back to page {lastPage}
        </Button>
      </div>
    );
  }

  return (
    <>
      {actionError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {actionError}
        </div>
      )}

      {editing && (
        <EditModal
          key={editing.session}
          product={editing.product}
          open={editOpen}
          onClose={() => closeEdit(editing.session)}
          onSaved={() => {
            closeEdit(editing.session);
            router.refresh();
          }}
        />
      )}

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {products.map((p) => (
          <div
            key={p.id}
            className="rounded-xl border border-[#DCDFD6] bg-white p-4 dark:border-[#35463B] dark:bg-[#1E2C23]"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-[#15201A] dark:text-[#EEF2EC]">{p.name}</h3>
                <p className="mt-0.5 text-xs text-[#55625A] dark:text-[#A3B1A7]">
                  {p.categoryName ?? "Uncategorized"}{p.subcategory ? ` / ${p.subcategory}` : ""}
                </p>
              </div>
              <ConfidenceBadge confidence={p.confidence} />
            </div>
            {p.description && (
              <p className="mb-2 text-xs text-[#55625A] line-clamp-2 dark:text-[#A3B1A7]">{p.description}</p>
            )}
            <div className="mb-3 flex flex-wrap gap-2 text-xs text-[#55625A] dark:text-[#A3B1A7]">
              {p.originCountries && <span>{p.originCountries}</span>}
              {p.unit && <span>{p.unit}</span>}
              {p.synonymCount > 0 && <span>{p.synonymCount} synonyms</span>}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleApprove(p.id)}
                disabled={isPending}
                className="flex-1 rounded-full bg-[#2E7D4F] px-3 py-2 text-xs font-medium text-white hover:bg-[#246b40] disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => openProduct(p)}
                disabled={isPending}
                className="rounded-full border border-[#DCDFD6] px-3 py-2 text-xs font-medium text-[#15201A] hover:bg-[#E7E9E2] dark:border-[#35463B] dark:text-[#EEF2EC] dark:hover:bg-[#2B3F33]"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => handleReject(p.id)}
                disabled={isPending}
                className="rounded-full border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => handleProposeAttributes(p.id)}
                disabled={isPending}
                className="rounded-full border border-[#DCDFD6] px-3 py-2 text-xs font-medium text-[#15201A] hover:bg-[#E7E9E2] disabled:opacity-50 dark:border-[#35463B] dark:text-[#EEF2EC] dark:hover:bg-[#2B3F33]"
              >
                Read attributes
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl border border-[#DCDFD6] bg-white md:block dark:border-[#35463B] dark:bg-[#1E2C23]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[#DCDFD6] bg-[#F3F4EF] dark:border-[#35463B] dark:bg-[#0D1410]">
            <tr>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#A3B1A7]">Product</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#A3B1A7]">Category</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#A3B1A7]">Confidence</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#A3B1A7]">Origin</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#A3B1A7]">Synonyms</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#A3B1A7]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-b border-[#DCDFD6] last:border-0 dark:border-[#35463B]">
                <td className="px-4 py-3">
                  <p className="font-medium text-[#15201A] dark:text-[#EEF2EC]">{p.name}</p>
                  {p.description && (
                    <p className="mt-0.5 text-xs text-[#55625A] line-clamp-1 dark:text-[#A3B1A7]">{p.description}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-[#55625A] dark:text-[#A3B1A7]">
                  {p.categoryName ?? "—"}
                  {p.subcategory && (
                    <span className="block text-xs opacity-70">{p.subcategory}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <ConfidenceBadge confidence={p.confidence} />
                </td>
                <td className="max-w-[140px] truncate px-4 py-3 text-xs text-[#55625A] dark:text-[#A3B1A7]">
                  {p.originCountries ?? "—"}
                </td>
                <td className="px-4 py-3 text-[#55625A] dark:text-[#A3B1A7]">
                  {p.synonymCount}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleApprove(p.id)}
                      disabled={isPending}
                      className="rounded-full bg-[#2E7D4F] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#246b40] disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => openProduct(p)}
                      disabled={isPending}
                      className="rounded-full border border-[#DCDFD6] px-3 py-1.5 text-xs font-medium text-[#15201A] hover:bg-[#E7E9E2] dark:border-[#71907D] dark:text-[#EEF2EC] dark:hover:bg-[#2B3F33]"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleReject(p.id)}
                      disabled={isPending}
                      className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => handleProposeAttributes(p.id)}
                      disabled={isPending}
                      className="rounded-full border border-[#DCDFD6] px-3 py-1.5 text-xs font-medium text-[#15201A] hover:bg-[#E7E9E2] disabled:opacity-50 dark:border-[#71907D] dark:text-[#EEF2EC] dark:hover:bg-[#2B3F33]"
                    >
                      Read attributes
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-[#55625A] dark:text-[#A3B1A7]">
            Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-[#55625A] hover:bg-[#E7E9E2] disabled:opacity-40 dark:text-[#A3B1A7] dark:hover:bg-[#2B3F33]"
            >
              Prev
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum: number;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (page <= 3) {
                pageNum = i + 1;
              } else if (page >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = page - 2 + i;
              }
              return (
                <button
                  key={pageNum}
                  type="button"
                  onClick={() => goToPage(pageNum)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                    pageNum === page
                      ? "bg-[#1F5A43] text-white"
                      : "text-[#55625A] hover:bg-[#E7E9E2] dark:text-[#A3B1A7] dark:hover:bg-[#2B3F33]"
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-[#55625A] hover:bg-[#E7E9E2] disabled:opacity-40 dark:text-[#A3B1A7] dark:hover:bg-[#2B3F33]"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}
