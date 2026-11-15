"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { uploadMasterProductImage, type ImageState } from "@/lib/admin/master-catalog";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function PhotoForm({ productId }: { productId: string }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [state, action, uploading] = useActionState<ImageState, FormData>(uploadMasterProductImage, {});

  useEffect(() => {
    if (state.ok) {
      form.current?.reset();
      router.refresh();
    }
  }, [state, router]);

  return (
    <form ref={form} action={action} className="grid min-w-0 flex-1 gap-3">
      <input type="hidden" name="productId" value={productId} />
      <div className="grid gap-1.5">
        <label htmlFor="image" className="text-sm font-medium text-foreground">New photo</label>
        <input
          id="image"
          name="image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          required
          aria-describedby="image-hint"
          className={`block w-full rounded-lg text-sm text-foreground file:mr-3 file:min-h-11 file:rounded-full file:border file:border-input file:bg-background file:px-4 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted ${FOCUS}`}
        />
        <p id="image-hint" className="text-sm text-muted-foreground">JPEG, PNG or WebP up to 2 MB. It is saved as WebP, at most 960 pixels wide.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={uploading}
          className={`inline-flex min-h-11 items-center rounded-full border border-input px-5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 ${FOCUS}`}
        >
          {uploading ? "Uploading…" : "Upload photo"}
        </button>
        <p role="status" className={`text-sm ${state.ok === false ? "text-destructive" : "text-muted-foreground"}`}>
          {uploading ? "" : state.message ?? ""}
        </p>
      </div>
    </form>
  );
}
