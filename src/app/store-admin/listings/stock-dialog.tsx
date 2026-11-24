"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateStockAction } from "@/lib/listing/actions";

export interface StockListing {
  id: string;
  name: string;
  stockMode: string;
  qty: number | null;
  status: string | null;
}

/** Staff's stock edit (#784): a count, or in stock / low / out. Nothing else on the listing. */
export function StockDialog({ listing, onClose }: { listing: StockListing | null; onClose: () => void }) {
  return (
    <Dialog open={!!listing} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        {listing && <StockForm key={listing.id} listing={listing} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function StockForm({ listing, onClose }: { listing: StockListing; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const counted = listing.stockMode === "counted";
  const [qty, setQty] = useState(String(listing.qty ?? 0));
  const [status, setStatus] = useState(listing.status ?? "in_stock");

  function save() {
    const fd = new FormData();
    fd.set("listingId", listing.id);
    if (counted) {
      fd.set("qty", qty);
      // Orders move qty while this is open. The loaded number tells the server the count was left alone.
      if (listing.qty != null) fd.set("qtyLoaded", String(listing.qty));
    } else {
      fd.set("status", status);
    }
    startTransition(async () => {
      const result = await updateStockAction(fd);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      const moved = result.stockMoved;
      if (moved && Number(qty) === moved.from) {
        toast.warning(`Stock changed from ${moved.from} to ${moved.to} since you opened this, so it stays ${moved.to}.`);
      } else if (moved) {
        toast.warning(`Stock changed from ${moved.from} to ${moved.to} while you edited. Your count of ${qty} was saved.`);
      } else {
        toast.success("Stock updated");
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Update stock</DialogTitle>
        <DialogDescription>{listing.name}</DialogDescription>
      </DialogHeader>
      {counted ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="stock-qty">Quantity in stock</Label>
          <Input id="stock-qty" type="number" min="0" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          <p className="text-sm text-muted-foreground">0 shows it as out of stock.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="stock-status">Stock status</Label>
          <Select value={status} onValueChange={(v) => { if (v) setStatus(v); }}>
            <SelectTrigger id="stock-status" className="min-h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="in_stock">In stock</SelectItem>
              <SelectItem value="low">Low stock</SelectItem>
              <SelectItem value="out_of_stock">Out of stock</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <DialogFooter>
        <Button className="min-h-11 rounded-full px-6" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save stock"}
        </Button>
      </DialogFooter>
    </>
  );
}
