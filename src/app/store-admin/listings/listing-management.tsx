"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createListingAction,
  updateListingAction,
  deactivateListingAction,
  reactivateListingAction,
} from "@/lib/listing/actions";
import {
  ArrowLeft,
  Plus,
  Pencil,
  Package,
  Snowflake,
  Leaf,
  X,
} from "lucide-react";

interface Variant {
  id: string;
  label: string;
  price: number;
  weightG: number;
  sku: string | null;
  barcode: string | null;
}

interface Listing {
  id: string;
  customName: string | null;
  masterProductName: string | null;
  price: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
  frozen: boolean;
  perishable: boolean;
  active: boolean;
  maxPerOrder: number | null;
  variants: Variant[];
}

interface Props {
  storeName: string;
  storeSlug: string;
  listings: Listing[];
}

function formatPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function stockLabel(listing: Listing) {
  if (listing.stockMode === "counted") return `${listing.qty ?? 0} in stock`;
  const statusMap: Record<string, string> = {
    in_stock: "In stock",
    low: "Low stock",
    out_of_stock: "Out of stock",
  };
  return statusMap[listing.status ?? "in_stock"] ?? listing.status;
}

function stockBadgeVariant(listing: Listing): "default" | "secondary" | "destructive" | "outline" {
  if (listing.stockMode === "counted") {
    if ((listing.qty ?? 0) === 0) return "destructive";
    if ((listing.qty ?? 0) <= 5) return "outline";
    return "secondary";
  }
  if (listing.status === "out_of_stock") return "destructive";
  if (listing.status === "low") return "outline";
  return "secondary";
}

interface VariantFormRow {
  key: string;
  label: string;
  price: string;
  weightG: string;
}

function emptyVariantRow(): VariantFormRow {
  return { key: crypto.randomUUID(), label: "", price: "", weightG: "" };
}

export function ListingManagement({ storeName, storeSlug, listings }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeParam = searchParams.get("store") ?? storeSlug;
  const [isPending, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [editListing, setEditListing] = useState<Listing | null>(null);

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [stockMode, setStockMode] = useState("counted");
  const [qty, setQty] = useState("0");
  const [status, setStatus] = useState("in_stock");
  const [frozen, setFrozen] = useState(false);
  const [perishable, setPerishable] = useState(false);
  const [maxPerOrder, setMaxPerOrder] = useState("");
  const [variants, setVariants] = useState<VariantFormRow[]>([emptyVariantRow()]);

  function resetForm() {
    setName("");
    setPrice("");
    setStockMode("counted");
    setQty("0");
    setStatus("in_stock");
    setFrozen(false);
    setPerishable(false);
    setMaxPerOrder("");
    setVariants([emptyVariantRow()]);
  }

  function openCreate() {
    resetForm();
    setCreateOpen(true);
  }

  function openEdit(listing: Listing) {
    setName(listing.customName ?? listing.masterProductName ?? "");
    setPrice((listing.price / 100).toFixed(2));
    setStockMode(listing.stockMode);
    setQty(String(listing.qty ?? 0));
    setStatus(listing.status ?? "in_stock");
    setFrozen(listing.frozen);
    setPerishable(listing.perishable);
    setMaxPerOrder(listing.maxPerOrder ? String(listing.maxPerOrder) : "");
    setVariants(
      listing.variants.map((v) => ({
        key: v.id,
        label: v.label,
        price: (v.price / 100).toFixed(2),
        weightG: String(v.weightG),
      })),
    );
    setEditListing(listing);
  }

  function addVariantRow() {
    setVariants((prev) => [...prev, emptyVariantRow()]);
  }

  function removeVariantRow(key: string) {
    setVariants((prev) => prev.filter((v) => v.key !== key));
  }

  function updateVariantField(key: string, field: keyof VariantFormRow, value: string) {
    setVariants((prev) =>
      prev.map((v) => (v.key === key ? { ...v, [field]: value } : v)),
    );
  }

  function buildVariantsJson() {
    return JSON.stringify(
      variants
        .filter((v) => v.label.trim())
        .map((v) => ({
          label: v.label.trim(),
          price: Math.round(parseFloat(v.price || "0") * 100),
          weightG: parseInt(v.weightG || "0", 10),
        })),
    );
  }

  function handleCreate() {
    const fd = new FormData();
    fd.set("customName", name);
    fd.set("price", String(Math.round(parseFloat(price || "0") * 100)));
    fd.set("stockMode", stockMode);
    if (stockMode === "counted") fd.set("qty", qty);
    if (stockMode === "status") fd.set("status", status);
    fd.set("frozen", String(frozen));
    fd.set("perishable", String(perishable));
    if (maxPerOrder) fd.set("maxPerOrder", maxPerOrder);
    fd.set("variants", buildVariantsJson());

    startTransition(async () => {
      const result = await createListingAction(fd);
      if ("error" in result && result.error) {
        toast.error(result.error);
      } else {
        toast.success("Listing created");
        setCreateOpen(false);
        resetForm();
        router.refresh();
      }
    });
  }

  function handleUpdate() {
    if (!editListing) return;
    const fd = new FormData();
    fd.set("listingId", editListing.id);
    fd.set("customName", name);
    fd.set("price", String(Math.round(parseFloat(price || "0") * 100)));
    fd.set("stockMode", stockMode);
    if (stockMode === "counted") fd.set("qty", qty);
    if (stockMode === "status") fd.set("status", status);
    fd.set("frozen", String(frozen));
    fd.set("perishable", String(perishable));
    fd.set("maxPerOrder", maxPerOrder);
    fd.set("variants", buildVariantsJson());

    startTransition(async () => {
      const result = await updateListingAction(fd);
      if ("error" in result && result.error) {
        toast.error(result.error);
      } else {
        toast.success("Listing updated");
        setEditListing(null);
        resetForm();
        router.refresh();
      }
    });
  }

  function handleToggleActive(listing: Listing) {
    startTransition(async () => {
      const action = listing.active
        ? deactivateListingAction(listing.id)
        : reactivateListingAction(listing.id);
      const result = await action;
      if ("error" in result && result.error) {
        toast.error(result.error);
      } else {
        toast.success(listing.active ? "Listing deactivated" : "Listing reactivated");
        router.refresh();
      }
    });
  }

  const activeListings = listings.filter((l) => l.active);
  const inactiveListings = listings.filter((l) => !l.active);

  const formContent = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="listing-name">Product name</Label>
        <Input
          id="listing-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Garri White"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="listing-price">Price ($)</Label>
          <Input
            id="listing-price"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="listing-max">Max per order</Label>
          <Input
            id="listing-max"
            type="number"
            min="0"
            value={maxPerOrder}
            onChange={(e) => setMaxPerOrder(e.target.value)}
            placeholder="No limit"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Stock tracking</Label>
        <Select value={stockMode} onValueChange={(v) => { if (v) setStockMode(v); }}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="counted">Counted (exact quantity)</SelectItem>
            <SelectItem value="status">Status (in stock / low / out)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {stockMode === "counted" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="listing-qty">Quantity in stock</Label>
          <Input
            id="listing-qty"
            type="number"
            min="0"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </div>
      )}

      {stockMode === "status" && (
        <div className="flex flex-col gap-2">
          <Label>Stock status</Label>
          <Select value={status} onValueChange={(v) => { if (v) setStatus(v); }}>
            <SelectTrigger>
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

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <Switch id="listing-frozen" checked={frozen} onCheckedChange={setFrozen} />
          <Label htmlFor="listing-frozen" className="flex items-center gap-1">
            <Snowflake className="size-3.5" /> Frozen
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="listing-perishable" checked={perishable} onCheckedChange={setPerishable} />
          <Label htmlFor="listing-perishable" className="flex items-center gap-1">
            <Leaf className="size-3.5" /> Perishable
          </Label>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Variants (sizes/weights)</Label>
          <Button type="button" variant="ghost" size="sm" onClick={addVariantRow}>
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          {variants.map((v) => (
            <div key={v.key} className="flex items-center gap-2">
              <Input
                placeholder="Label (e.g. 1kg)"
                value={v.label}
                onChange={(e) => updateVariantField(v.key, "label", e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder="Price"
                type="number"
                min="0"
                step="0.01"
                value={v.price}
                onChange={(e) => updateVariantField(v.key, "price", e.target.value)}
                className="w-24"
              />
              <Input
                placeholder="Weight (g)"
                type="number"
                min="0"
                value={v.weightG}
                onChange={(e) => updateVariantField(v.key, "weightG", e.target.value)}
                className="w-24"
              />
              {variants.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeVariantRow(v.key)}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Link href={`/store-admin?store=${storeParam}`}>
            <Button variant="ghost" size="icon" className="size-9">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-base font-semibold text-foreground">Products</h1>
            <p className="text-xs text-muted-foreground">{storeName}</p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" /> Add listing
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>New listing</DialogTitle>
                <DialogDescription>Add a product to your store</DialogDescription>
              </DialogHeader>
              {formContent}
              <DialogFooter>
                <Button onClick={handleCreate} disabled={isPending}>
                  {isPending ? "Creating..." : "Create listing"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        {listings.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12">
              <Package className="size-10 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No listings yet. Add your first product to get started.
              </p>
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" /> Add listing
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Active listings</CardTitle>
                <CardDescription>
                  {activeListings.length} listing{activeListings.length !== 1 ? "s" : ""}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {activeListings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active listings</p>
                ) : (
                  <div className="flex flex-col divide-y divide-border">
                    {activeListings.map((listing) => (
                      <ListingRow
                        key={listing.id}
                        listing={listing}
                        onEdit={() => openEdit(listing)}
                        onToggle={() => handleToggleActive(listing)}
                        isPending={isPending}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {inactiveListings.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Inactive listings</CardTitle>
                  <CardDescription>
                    {inactiveListings.length} deactivated listing{inactiveListings.length !== 1 ? "s" : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col divide-y divide-border">
                    {inactiveListings.map((listing) => (
                      <ListingRow
                        key={listing.id}
                        listing={listing}
                        onEdit={() => openEdit(listing)}
                        onToggle={() => handleToggleActive(listing)}
                        isPending={isPending}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </main>

      <Dialog open={!!editListing} onOpenChange={(open) => { if (!open) setEditListing(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit listing</DialogTitle>
            <DialogDescription>Update product details</DialogDescription>
          </DialogHeader>
          {formContent}
          <DialogFooter>
            <Button onClick={handleUpdate} disabled={isPending}>
              {isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ListingRow({
  listing,
  onEdit,
  onToggle,
  isPending,
}: {
  listing: Listing;
  onEdit: () => void;
  onToggle: () => void;
  isPending: boolean;
}) {
  const displayName = listing.customName ?? listing.masterProductName ?? "Unnamed";

  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {displayName}
          </span>
          {listing.frozen && (
            <Snowflake className="size-3.5 shrink-0 text-blue-500" aria-label="Frozen" />
          )}
          {listing.perishable && (
            <Leaf className="size-3.5 shrink-0 text-green-600" aria-label="Perishable" />
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">
            {formatPrice(listing.price)}
          </span>
          {listing.variants.length > 0 && (
            <span className="text-xs text-muted-foreground">
              · {listing.variants.length} variant{listing.variants.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
      <Badge variant={stockBadgeVariant(listing)} className="shrink-0">
        {stockLabel(listing)}
      </Badge>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onEdit}
          aria-label={`Edit ${displayName}`}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Switch
          checked={listing.active}
          onCheckedChange={onToggle}
          disabled={isPending}
          aria-label={listing.active ? `Deactivate ${displayName}` : `Reactivate ${displayName}`}
        />
      </div>
    </div>
  );
}
