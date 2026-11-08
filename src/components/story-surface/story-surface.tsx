"use client";

import { type ComponentProps, type ReactNode } from "react";
import { MotionConfig, motion } from "motion/react";
import { cn } from "cn";
import { Card } from "@/components/ui/card";
import { DepthSceneGate } from "./depth-scene-gate";
import { BODIJA_MARKET, type StoryScene } from "./scenes";

const WIDE_MEDIA = "(min-width: 768px)";
const TALL_MEDIA = "(max-width: 767.98px)";

/** The panel every story surface form sits on. Solid, so AA holds over any part of the photo. */
export function StoryCard({ className, ...props }: ComponentProps<typeof Card>) {
  return <Card className={cn("rounded-2xl border-0 bg-card shadow-2xl", className)} {...props} />;
}

export function StorySurface({
  children,
  asMain = true,
  scene = BODIJA_MARKET,
}: {
  children: ReactNode;
  asMain?: boolean;
  scene?: StoryScene;
}) {
  const Tag = asMain ? "main" : "div";
  return (
    <MotionConfig reducedMotion="user">
      {/* The poster is the largest element, so it has to start with the document. */}
      <link
        rel="preload"
        as="image"
        href={scene.posterWide.src}
        media={WIDE_MEDIA}
        fetchPriority="high"
      />
      <link
        rel="preload"
        as="image"
        href={scene.posterTall.src}
        media={TALL_MEDIA}
        fetchPriority="high"
      />
      <Tag className="story-surface relative flex min-h-dvh items-end justify-center overflow-hidden p-4 pb-6 sm:pb-10 lg:items-center lg:justify-end lg:pr-[max(6vw,3rem)]">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-primary-deep">
          {/* Overscan so the depth scene never samples past the edge of the photo. */}
          <motion.div
            data-testid="story-poster"
            className="absolute -inset-[3%] motion-reduce:!transform-none"
            initial={{ scale: 1.03 }}
            animate={{ scale: 1 }}
            transition={{ duration: 1.2, ease: [0, 0, 0, 1] }}
          >
            <picture>
              <source media={WIDE_MEDIA} srcSet={scene.posterWide.src} />
              <img
                src={scene.posterTall.src}
                alt=""
                fetchPriority="high"
                decoding="sync"
                className="story-surface__poster absolute inset-0 h-full w-full object-cover"
                style={{
                  ["--story-focus-wide" as string]: `${scene.focus.x * 100}% ${scene.focus.y * 100}%`,
                }}
              />
            </picture>
            <DepthSceneGate scene={scene} />
          </motion.div>
          <div className="story-surface__dusk absolute inset-0" />
          <div className="story-surface__scrim absolute inset-0 hidden lg:block" />
        </div>

        {/* Visible from the first paint. The entrance only moves it, so slow JS never hides the form. */}
        <motion.div
          className="relative z-10 w-full max-w-sm motion-reduce:!transform-none"
          initial={{ y: 16 }}
          animate={{ y: 0 }}
          transition={{ duration: 0.5, ease: [0, 0, 0, 1] }}
        >
          {children}
        </motion.div>

        {/* After the form in the DOM, so a screen reader reaches the form first. */}
        <div className="pointer-events-none absolute bottom-12 left-[max(6vw,3rem)] z-10 hidden max-w-[min(34rem,42vw)] text-white lg:block">
          <p className="font-display text-[clamp(2.25rem,3.6vw,3.5rem)] leading-[1.05] font-bold text-balance">
            {scene.line}
          </p>
          <p className="mt-3 text-sm">
            {scene.place} · Photo by {scene.photographer}
          </p>
        </div>
      </Tag>
    </MotionConfig>
  );
}
