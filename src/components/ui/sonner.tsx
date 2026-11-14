"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import type { ToasterProps } from "sonner"

// Mounted on the first interaction, the first toast, or 4 s after load: never on the first-paint path (#563).
// Sonner replays toasts raised before it subscribes, so none are lost.
const Sonner = dynamic(() => import("sonner").then((mod) => mod.Toaster), { ssr: false })

/** Dispatch on window before raising a toast from code that may run before any interaction. */
export const TOASTER_WANTED = "toaster:wanted"
const INTERACTIONS = ["pointerdown", "keydown", "touchstart"] as const

function useWhenNeeded() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let timer = 0
    const mount = () => setReady(true)
    const afterLoad = () => { timer = window.setTimeout(mount, 4000) }
    if (document.readyState === "complete") afterLoad()
    else window.addEventListener("load", afterLoad, { once: true })
    for (const type of INTERACTIONS) window.addEventListener(type, mount, { once: true, passive: true })
    window.addEventListener(TOASTER_WANTED, mount, { once: true })
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("load", afterLoad)
      for (const type of INTERACTIONS) window.removeEventListener(type, mount)
      window.removeEventListener(TOASTER_WANTED, mount)
    }
  }, [])
  return ready
}

const Toaster = ({ ...props }: ToasterProps) => {
  const ready = useWhenNeeded()
  if (!ready) return null
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
