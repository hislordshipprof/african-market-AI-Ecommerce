"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  createListingAction,
  updateListingAction,
  deactivateListingAction,
  reactivateListingAction,
  listMasterProductsAction,
} from "@/lib/listing/actions";
import { serializeVariants } from "./variant-form";
import {
  ArrowLeft,
  Plus,
  Pencil,
  Package,
  Snowflake,
  Leaf,
  X,
  Upload,
} from "lucide-react";

interface Variant {
  id: string;
  label: string;
  price: number;
  weightG: number;
  sku: string | null;
  barcode: string | null;
}

interface MasterProductOption {
  id: string;
  name: string;
}

interface Listing {
  id: string;
  masterProductId: string | null;
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
  /** Present only for a row loaded from the listing. Never the React key of a new row. */
  id?: string;
  label: string;
  price: string;
  weightG: string;
  /** Carried through edits so saving never erases existing values; no input UI. */
  sku?: string | null;
  barcode?: string | null;
}

function emptyVariantRow(): VariantFormRow {
  return { key: crypto.randomUUID(), label: "", price: "", weightG: "" };
}

interface ListingFormFields {
  name: string;
  price: string;
  stockMode: string;
  qty: string;
  status: string;
  frozen: boolean;
  perishable: boolean;
  maxPerOrder: string;
  masterProductId: string | null;
}


/** Serialises the listing form for create and update; update passes `listingId`. */
function buildListingFormData(
  fields: ListingFormFields,
  variants: VariantFormRow[],
  listingId?: string,
) {
  const fd = new FormData();
  if (listingId) fd.set("listingId", listingId);
  fd.set("customName", fields.name);
  fd.set("price", String(Math.round(parseFloat(fields.price || "0") * 100)));
  fd.set("stockMode", fields.stockMode);
  if (fields.stockMode === "counted") fd.set("qty", fields.qty);
  if (fields.stockMode === "status") fd.set("status", fields.status);
  fd.set("frozen", String(fields.frozen));
  fd.set("perishable", String(fields.perishable));
  // Update always sends maxPerOrder so clearing it works; create omits it when blank.
  if (listingId || fields.maxPerOrder) fd.set("maxPerOrder", fields.maxPerOrder);
  if (fields.masterProductId) fd.set("masterProductId", fields.masterProductId);
  else if (listingId) fd.set("masterProductId", "");
  fd.set("variants", serializeVariants(variants));
  return fd;
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
  const [masterProductId, setMasterProductId] = useState<string | null>(null);
  const [masterProducts, setMasterProducts] = useState<MasterProductOption[] | null>(null);
  const [selectedMasterOption, setSelectedMasterOption] = useState<MasterProductOption | null>(null);
  const searchSeq = useRef(0);
  const selectedMasterNameRef = useRef<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setMasterProductId(null);
    setSelectedMasterOption(null);
    selectedMasterNameRef.current = null;
    setVariants([emptyVariantRow()]);
  }

  function searchMasterProducts(query: string) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    listMasterProductsAction(query)
      .then((rows) => {
        if (seq === searchSeq.current) setMasterProducts(rows);
      })
      .catch(() => {
        if (seq === searchSeq.current) toast.error("Could not search the catalog");
      });
  }

  function onMasterInputChange(value: string) {
    // Choosing an item sets the input to its label: do not narrow the list to that label.
    if (selectedMasterNameRef.current !== null && value === selectedMasterNameRef.current) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => searchMasterProducts(value), 300);
  }

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  function openCreate() {
    resetForm();
    searchMasterProducts("");
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
    setMasterProductId(listing.masterProductId);
    setVariants(
      listing.variants.map((v) => ({
        key: v.id,
        id: v.id,
        label: v.label,
        price: (v.price / 100).toFixed(2),
        weightG: String(v.weightG),
        sku: v.sku,
        barcode: v.barcode,
      })),
    );
    searchMasterProducts("");
    const currentMaster =
      listing.masterProductId && listing.masterProductName
        ? { id: listing.masterProductId, name: listing.masterProductName }
        : null;
    setSelectedMasterOption(currentMaster);
    selectedMasterNameRef.current = currentMaster?.name ?? null;
    setEditListing(listing);
  }

  function addVariantRow() {
    setVariants((prev) => [...prev, emptyVariantRow()]);
  }

  function removeVariantRow(key: string) {
    setVariants((prev) => prev.filter((v) => v.key !== key));
  }

  function updateVariantField(key: string, field: "label" | "price" | "weightG", value: string) {
    setVariants((prev) =>
      prev.map((v) => (v.key === key ? { ...v, [field]: value } : v)),
    );
  }

  const formFields: ListingFormFields = {
    name,
    price,
    stockMode,
    qty,
    status,
    frozen,
    perishable,
    maxPerOrder,
    masterProductId,
  };

  function handleCreate() {
    const fd = buildListingFormData(formFields, variants);

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
    const fd = buildListingFormData(formFields, variants, editListing.id);

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

  const selectedMaster = masterProductId ? selectedMasterOption : null;
  const masterItems =
    selectedMaster && !masterProducts?.some((m) => m.id === selectedMaster.id)
      ? [selectedMaster, ...(masterProducts ?? [])]
      : (masterProducts ?? []);

  const formContent = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="listing-master">Master product (optional)</Label>
        <Combobox
          items={masterItems}
          filter={null}
          onInputValueChange={onMasterInputChange}
          value={selectedMaster}
          onValueChange={(item: MasterProductOption | null) => {
            setMasterProductId(item?.id ?? null);
            setSelectedMasterOption(item);
            selectedMasterNameRef.current = item?.name ?? null;
            if (item && !name.trim()) setName(item.name);
          }}
          itemToStringLabel={(item: MasterProductOption) => item.name}
          isItemEqualToValue={(a: MasterProductOption, b: MasterProductOption) => a.id === b.id}
        >
          <ComboboxInput
            id="listing-master"
            placeholder={masterProducts ? "Search the catalog" : "Loading catalog..."}
            showClear
          />
          <ComboboxContent>
            <ComboboxEmpty>No catalog product matches</ComboboxEmpty>
            <ComboboxList>
              {(item: MasterProductOption) => (
                <ComboboxItem key={item.id} value={item}>
                  {item.name}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <p className="text-xs text-muted-foreground">Leave empty for a custom product.</p>
      </div>

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
                min="1"
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
          <Link href={`/store-admin/listings/import?store=${storeParam}`}>
            <Button size="sm" variant="outline">
              <Upload className="size-4" /> Import CSV
            </Button>
          </Link>
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
