"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ALLERGENS, DIETARY_CLAIMS, type Allergen, type DietaryClaim } from "@/lib/catalog/attributes";
import type { OwnerAttributeGroup, OwnerListingAttributes } from "@/lib/catalog/listing-attributes";
import { correctListingAttributesAction, getListingAttributesAction } from "@/lib/listing/attribute-actions";

type GroupKey = "ingredients" | "allergens" | "dietary";

interface Draft {
  known: boolean;
  values: string[];
  ingredientsText: string;
  touched: boolean;
}

function draftOf(group: OwnerAttributeGroup<string>): Draft {
  const known = group.status !== "unknown";
  return { known, values: known ? group.values : [], ingredientsText: known ? group.values.join("\n") : "", touched: false };
}

function label(value: string) {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function StatusBadge({ group }: { group: OwnerAttributeGroup<string> }) {
  if (group.status === "reviewed") return <Badge>Reviewed</Badge>;
  if (group.status === "known") return <Badge variant="secondary">Set by you</Badge>;
  if (group.proposed) return <Badge variant="outline">AI-proposed, waiting for review</Badge>;
  return <Badge variant="outline">Unknown</Badge>;
}

function ValueChips({
  options,
  selected,
  onToggle,
  groupLabel,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
  groupLabel: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={groupLabel}>
      {options.map((option) => {
        const on = selected.includes(option);
        return (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={on ? "default" : "outline"}
            className="rounded-full"
            aria-pressed={on}
            onClick={() => onToggle(option)}
          >
            {label(option)}
          </Button>
        );
      })}
    </div>
  );
}

const GROUPS: Array<{ key: GroupKey; title: string; unknownHint: string; knownHint: string }> = [
  {
    key: "allergens",
    title: "Allergens",
    unknownHint: "Unknown. Shoppers who avoid an allergen are told we cannot confirm this product.",
    knownHint: "Turn on every allergen the product contains. Leave all off only if it contains none of them.",
  },
  {
    key: "dietary",
    title: "Dietary claims",
    unknownHint: "Unknown. Shoppers who need a claim are told we cannot confirm this product.",
    knownHint: "Turn on every claim the label or a certification mark states.",
  },
  {
    key: "ingredients",
    title: "Ingredients",
    unknownHint: "Unknown. Shoppers who avoid an ingredient are told we cannot confirm this product.",
    knownHint: "One ingredient per line, as on the label. Local names work too.",
  },
];

export function AttributesDialog({
  listingId,
  listingName,
  onClose,
}: {
  listingId: string | null;
  listingName: string;
  onClose: () => void;
}) {
  const [attributes, setAttributes] = useState<OwnerListingAttributes | null>(null);
  const [drafts, setDrafts] = useState<Record<GroupKey, Draft> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!listingId) return;
    let cancelled = false;
    getListingAttributesAction(listingId).then((result) => {
      if (cancelled) return;
      if (!result.attributes) {
        setLoadError(result.error ?? "Could not load attributes");
        return;
      }
      setAttributes(result.attributes);
      setDrafts({
        ingredients: draftOf(result.attributes.ingredients),
        allergens: draftOf(result.attributes.allergens),
        dietary: draftOf(result.attributes.dietary),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [listingId]);

  function update(key: GroupKey, change: Partial<Draft>) {
    setDrafts((current) => current && { ...current, [key]: { ...current[key], ...change, touched: true } });
  }

  function toggleValue(key: GroupKey, value: string) {
    const draft = drafts![key];
    update(key, { values: draft.values.includes(value) ? draft.values.filter((v) => v !== value) : [...draft.values, value] });
  }

  function save() {
    if (!listingId || !drafts) return;
    const status = (draft: Draft) => (draft.known ? "known" : "unknown") as "known" | "unknown";
    const { ingredients, allergens, dietary } = drafts;
    const input: Parameters<typeof correctListingAttributesAction>[0] = { listingId };
    if (ingredients.touched) {
      const names = ingredients.ingredientsText.split(/[\n,]/).map((name) => name.trim()).filter(Boolean);
      input.ingredients = { status: status(ingredients), names: ingredients.known ? names : [] };
    }
    if (allergens.touched) {
      input.allergens = { status: status(allergens), values: allergens.known ? (allergens.values as Allergen[]) : [] };
    }
    if (dietary.touched) {
      input.dietary = { status: status(dietary), values: dietary.known ? (dietary.values as DietaryClaim[]) : [] };
    }
    startTransition(async () => {
      const result = await correctListingAttributesAction(input);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Attributes saved");
        onClose();
      }
    });
  }

  const changed = drafts ? Object.values(drafts).some((draft) => draft.touched) : false;

  return (
    <Dialog open={!!listingId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ingredients and allergens</DialogTitle>
          <DialogDescription>{listingName}</DialogDescription>
        </DialogHeader>
        {loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : !attributes || !drafts ? (
          <p className="text-sm text-muted-foreground" aria-live="polite">Loading…</p>
        ) : (
          <div className="flex flex-col gap-5">
            {GROUPS.map(({ key, title, unknownHint, knownHint }) => {
              const draft = drafts[key];
              const switchId = `attr-known-${key}`;
              return (
                <section key={key} className="flex flex-col gap-2.5" aria-labelledby={`attr-title-${key}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id={`attr-title-${key}`} className="text-sm font-semibold text-foreground">{title}</h3>
                    <StatusBadge group={attributes[key] as OwnerAttributeGroup<string>} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id={switchId}
                      checked={draft.known}
                      onCheckedChange={(known) => update(key, { known })}
                    />
                    <Label htmlFor={switchId} className="text-sm font-normal">I know the {title.toLowerCase()}</Label>
                  </div>
                  <p className="text-xs text-muted-foreground">{draft.known ? knownHint : unknownHint}</p>
                  {draft.known && key === "allergens" && (
                    <ValueChips options={ALLERGENS} selected={draft.values} onToggle={(v) => toggleValue(key, v)} groupLabel="Contains" />
                  )}
                  {draft.known && key === "dietary" && (
                    <ValueChips options={DIETARY_CLAIMS} selected={draft.values} onToggle={(v) => toggleValue(key, v)} groupLabel="Claims" />
                  )}
                  {draft.known && key === "ingredients" && (
                    <Textarea
                      aria-label="Ingredients, one per line"
                      value={draft.ingredientsText}
                      onChange={(event) => update(key, { ingredientsText: event.target.value })}
                      rows={4}
                    />
                  )}
                </section>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button onClick={save} disabled={isPending || !changed}>
            {isPending ? "Saving..." : "Save attributes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
