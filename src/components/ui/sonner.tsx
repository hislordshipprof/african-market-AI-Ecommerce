"use client"

import dynamic from "next/dynamic"
import type { ToasterProps } from "sonner"

// Loaded after hydration, off the first-paint path (#563). Sonner replays toasts raised before it subscribes.
const Sonner = dynamic(() => import("sonner").then((mod) => mod.Toaster), { ssr: false })

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
