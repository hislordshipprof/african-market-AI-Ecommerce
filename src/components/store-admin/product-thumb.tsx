import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: { box: "size-10 rounded-lg", label: "text-[9px]" },
  md: { box: "size-12 rounded-xl", label: "text-[10px]" },
  lg: { box: "size-24 rounded-xl", label: "text-xs" },
} as const;

/** A product photo on the photo well, or a "No photo" placeholder (#787). */
export function ProductThumb({ src, alt = "", size = "md" }: { src: string | null | undefined; alt?: string; size?: keyof typeof SIZES }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden bg-[var(--color-photo-well,var(--color-raised))]",
        SIZES[size].box,
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="size-full object-contain" loading="lazy" />
      ) : (
        <span
          className={cn(
            "flex flex-col items-center gap-0.5 whitespace-nowrap leading-none text-[var(--color-on-photo-well,currentColor)] opacity-75",
            SIZES[size].label,
          )}
        >
          <ImageOff className="size-4" aria-hidden />
          No photo
        </span>
      )}
    </div>
  );
}
