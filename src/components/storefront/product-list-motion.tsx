"use client";

import { Children, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

/** Receives server-rendered cards; catalog data and card rendering stay on the server. */
export function ProductListMotion({
  children,
  className,
  itemClassName,
  as = "div",
  contents = false,
}: {
  children: ReactNode;
  className?: string;
  itemClassName?: string;
  as?: "div" | "ul";
  contents?: boolean;
}) {
  const reduced = useReducedMotion();
  const Container = as;
  const Item = as === "ul" ? motion.li : motion.div;
  return (
    <Container
      className={className}
      style={contents ? { display: "contents" } : undefined}
    >
      {Children.toArray(children).map((child, index) => (
        <Item
          key={
            typeof child === "object" && child !== null && "key" in child
              ? child.key
              : index
          }
          className={itemClassName}
          initial={false}
          animate={reduced ? { opacity: 1, y: 0 } : undefined}
          whileInView={reduced ? undefined : { opacity: [0, 1], y: [8, 0] }}
          viewport={{ once: true, amount: 0.1 }}
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
      ))}
    </Container>
  );
}
