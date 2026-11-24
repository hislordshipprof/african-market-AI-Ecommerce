import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

/** A product photo on the photo well, or a "No photo" placeholder (#787). */
export function ProductThumb({ src, alt = "", className }: { src: string | null | undefined; alt?: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--color-photo-well,var(--color-raised))]",
        className,
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="size-full object-contain" loading="lazy" />
      ) : (
        <span className="flex flex-col items-center gap-0.5 text-center text-[10px] leading-tight text-[var(--color-on-photo-well,currentColor)] opacity-70">
          <ImageOff className="size-4" aria-hidden />
          No photo
        </span>
      )}
    </div>
  );
}
