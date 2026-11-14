"use client";

import dynamic from "next/dynamic";

/** The prompt renders nothing until a visit qualifies, so its code loads after hydration (#563). */
export const InstallPrompt = dynamic(() => import("./install-prompt").then(mod => mod.InstallPrompt), { ssr: false });
