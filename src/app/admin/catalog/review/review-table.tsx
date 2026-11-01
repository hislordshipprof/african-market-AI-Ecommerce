"use client";

import { useState, useTransition } from "react";
import type { ReviewProduct } from "@/lib/admin/catalog-actions";
import {
  approveProduct,
  rejectProduct,
  updateReviewProduct,
} from "@/lib/admin/catalog-actions";
import { useRouter } from "next/navigation";

function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  const color =
    confidence === "medium"
      ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
      : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300";
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {confidence ?? "unknown"}
    </span>
  );
}

function EditModal({
  product,
  onClose,
  onSaved,
}: {
  product: ReviewProduct;
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

  function handleSave() {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    startTransition(async () => {
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
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl dark:bg-[#1a1a1a]">
        <h3 className="mb-4 text-lg font-bold text-[#15201A] dark:text-white">
          Edit product
        </h3>
        {error && (
          <p className="mb-3 text-sm text-red-600">{error}</p>
        )}
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#a0a8a3]">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#333] dark:bg-[#111] dark:text-white"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#a0a8a3]">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#333] dark:bg-[#111] dark:text-white"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#a0a8a3]">Unit</span>
              <input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#333] dark:bg-[#111] dark:text-white"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#a0a8a3]">Storage</span>
              <input
                value={storage}
                onChange={(e) => setStorage(e.target.value)}
                className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#333] dark:bg-[#111] dark:text-white"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#55625A] dark:text-[#a0a8a3]">Origin countries</span>
            <input
              value={originCountries}
              onChange={(e) => setOriginCountries(e.target.value)}
              className="w-full rounded-lg border border-[#DCDFD6] bg-white px-3 py-2 text-sm text-[#15201A] focus:border-[#1F5A43] focus:outline-none focus:ring-1 focus:ring-[#1F5A43] dark:border-[#333] dark:bg-[#111] dark:text-white"
            />
          </label>
        </div>
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="rounded-full px-4 py-2 text-sm font-medium text-[#55625A] hover:bg-[#f0f0f0] dark:text-[#a0a8a3] dark:hover:bg-[#222]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending}
            className="rounded-full bg-[#1F5A43] px-5 py-2 text-sm font-medium text-white hover:bg-[#123726] disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
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
  const [editingProduct, setEditingProduct] = useState<ReviewProduct | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  function goToPage(p: number) {
    const params = new URLSearchParams(window.location.search);
    params.set("page", String(p));
    router.push(`/admin/catalog/review?${params.toString()}`);
  }

  if (products.length === 0) {
    return (
      <div className="rounded-xl border border-[#e2e4e9] bg-white p-12 text-center dark:border-[#333] dark:bg-[#1a1a1a]">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-50 dark:bg-green-950">
          <svg className="h-6 w-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
          </svg>
        </div>
        <p className="text-sm font-medium text-[#55625A] dark:text-[#a0a8a3]">
          No products to review. All caught up!
        </p>
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

      {editingProduct && (
        <EditModal
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onSaved={() => {
            setEditingProduct(null);
            router.refresh();
          }}
        />
      )}

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {products.map((p) => (
          <div
            key={p.id}
            className="rounded-xl border border-[#e2e4e9] bg-white p-4 dark:border-[#333] dark:bg-[#1a1a1a]"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-[#15201A] dark:text-white">{p.name}</h3>
                <p className="mt-0.5 text-xs text-[#55625A] dark:text-[#a0a8a3]">
                  {p.categoryName ?? "Uncategorized"}{p.subcategory ? ` / ${p.subcategory}` : ""}
                </p>
              </div>
              <ConfidenceBadge confidence={p.confidence} />
            </div>
            {p.description && (
              <p className="mb-2 text-xs text-[#55625A] line-clamp-2 dark:text-[#a0a8a3]">{p.description}</p>
            )}
            <div className="mb-3 flex flex-wrap gap-2 text-xs text-[#55625A] dark:text-[#a0a8a3]">
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
                onClick={() => setEditingProduct(p)}
                disabled={isPending}
                className="rounded-full border border-[#DCDFD6] px-3 py-2 text-xs font-medium text-[#15201A] hover:bg-[#f0f0f0] dark:border-[#333] dark:text-white dark:hover:bg-[#222]"
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
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl border border-[#e2e4e9] bg-white md:block dark:border-[#333] dark:bg-[#1a1a1a]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[#e2e4e9] bg-[#f8f9fa] dark:border-[#333] dark:bg-[#111]">
            <tr>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#a0a8a3]">Product</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#a0a8a3]">Category</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#a0a8a3]">Confidence</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#a0a8a3]">Origin</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#a0a8a3]">Synonyms</th>
              <th className="px-4 py-3 font-medium text-[#55625A] dark:text-[#a0a8a3]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-b border-[#e2e4e9] last:border-0 dark:border-[#333]">
                <td className="px-4 py-3">
                  <p className="font-medium text-[#15201A] dark:text-white">{p.name}</p>
                  {p.description && (
                    <p className="mt-0.5 text-xs text-[#55625A] line-clamp-1 dark:text-[#a0a8a3]">{p.description}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-[#55625A] dark:text-[#a0a8a3]">
                  {p.categoryName ?? "—"}
                  {p.subcategory && (
                    <span className="block text-xs opacity-70">{p.subcategory}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <ConfidenceBadge confidence={p.confidence} />
                </td>
                <td className="max-w-[140px] truncate px-4 py-3 text-xs text-[#55625A] dark:text-[#a0a8a3]">
                  {p.originCountries ?? "—"}
                </td>
                <td className="px-4 py-3 text-[#55625A] dark:text-[#a0a8a3]">
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
                      onClick={() => setEditingProduct(p)}
                      disabled={isPending}
                      className="rounded-full border border-[#DCDFD6] px-3 py-1.5 text-xs font-medium text-[#15201A] hover:bg-[#f0f0f0] dark:border-[#444] dark:text-white dark:hover:bg-[#222]"
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
          <p className="text-xs text-[#55625A] dark:text-[#a0a8a3]">
            Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-[#55625A] hover:bg-[#f0f0f0] disabled:opacity-40 dark:text-[#a0a8a3] dark:hover:bg-[#222]"
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
                      : "text-[#55625A] hover:bg-[#f0f0f0] dark:text-[#a0a8a3] dark:hover:bg-[#222]"
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
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-[#55625A] hover:bg-[#f0f0f0] disabled:opacity-40 dark:text-[#a0a8a3] dark:hover:bg-[#222]"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}
