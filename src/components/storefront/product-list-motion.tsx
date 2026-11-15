"use client";

import { Children, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, LazyMotion, MotionConfig, m, useReducedMotion } from "motion/react";

const loadFeatures = () => import("./motion-layout-features").then(module => module.default);

/** Receives server-rendered cards; catalog data and card rendering stay on the server. */
export function ProductListMotion({
  children,
  className,
  itemClassName,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  itemClassName?: string;
  as?: "div" | "ul";
}) {
  const reduced = useReducedMotion();
  const Container = as;
  const Item = as === "ul" ? m.li : m.div;
  const content = (
    <Container className={className}>
      <AnimatePresence initial={false}>{Children.toArray(children).map((child, index) => (
        <Item
          key={
            typeof child === "object" && child !== null && "key" in child
              ? child.key
              : index
          }
          className={itemClassName}
          data-sf-reveal
          style={{ "--sf-reveal-delay": `${Math.min(index, 7) * 30}ms` } as CSSProperties}
          layout={reduced ? false : "position"}
          exit={{ opacity: 0 }}
          initial={false}
          transition={
            reduced
              ? { duration: 0 }
              : {
                  duration: 0.24,
                  delay: Math.min(index, 7) * 0.03,
                  ease: [0, 0, 0, 1],
                }
          }
        >
          {child}
        </Item>
      ))}</AnimatePresence>
    </Container>
  );
  return <LazyMotion features={loadFeatures}><MotionConfig reducedMotion="user">{content}</MotionConfig></LazyMotion>;
}
