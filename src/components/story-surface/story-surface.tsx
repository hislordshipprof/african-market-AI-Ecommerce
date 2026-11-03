"use client";

import { type ReactNode } from "react";
import Image from "next/image";
import { MotionConfig, motion } from "motion/react";
import posterSrc from "../../../public/images/market-spices-poster.jpg";

/**
 * Re-enable when the 3D market scene is rebuilt at higher fidelity (#35).
 * When false the three/R3F chunk is never imported.
 */
export const ENABLE_3D_SCENE = false;

export function StorySurface({
  children,
  asMain = true,
}: {
  children: ReactNode;
  asMain?: boolean;
}) {
  const Tag = asMain ? "main" : "div";
  return (
    <MotionConfig reducedMotion="user">
    <Tag className="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
      {/* Poster photograph — first paint, always visible */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
      >
        <motion.div
          data-testid="story-poster"
          className="absolute inset-0 motion-reduce:!transform-none"
          initial={{ scale: 1.05 }}
          animate={{ scale: 1 }}
          transition={{ duration: 20, ease: "linear", repeat: Infinity, repeatType: "reverse" }}
          style={{ willChange: "transform" }}
        >
          <Image
            src={posterSrc}
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover motion-reduce:!transform-none"
            placeholder="blur"
          />
        </motion.div>
        <div className="absolute inset-0 bg-gradient-to-br from-black/50 via-black/30 to-transparent dark:from-black/70 dark:via-black/50" />
      </div>

      {/* Form panel — visible by default; entrance animation plays on hydration */}
      <noscript>
        <style>{`.story-form{opacity:1!important;transform:none!important}`}</style>
      </noscript>
      <motion.div
        className="story-form relative z-10 w-full max-w-sm motion-reduce:!transform-none motion-reduce:!opacity-100"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.4, 0.4, 0, 1] }}
      >
        {children}
      </motion.div>
    </Tag>
    </MotionConfig>
  );
}
