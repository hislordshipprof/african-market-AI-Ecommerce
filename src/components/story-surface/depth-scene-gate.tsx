"use client";

import { Component, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { motion } from "motion/react";
import type { StoryScene } from "./scenes";

const DepthScene = dynamic(() => import("./depth-scene"), { ssr: false });

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
// The height check keeps a phone held sideways on the poster.
const WIDE_ENOUGH = "(min-width: 768px) and (min-height: 500px)";

type NetworkInformation = EventTarget & { saveData?: boolean; effectiveType?: string };

function connection(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection;
}

function isSavingData(): boolean {
  // The root layout copies the Save-Data request header here, for browsers without
  // navigator.connection.
  if (document.documentElement.dataset.saveData === "on") return true;
  const network = connection();
  return network?.saveData === true || network?.effectiveType === "2g" || network?.effectiveType === "slow-2g";
}

function isSceneAllowed(): boolean {
  return (
    window.matchMedia(WIDE_ENOUGH).matches &&
    !window.matchMedia(REDUCED_MOTION).matches &&
    !isSavingData()
  );
}

function subscribeToSceneAllowed(onChange: () => void): () => void {
  const queries = [window.matchMedia(WIDE_ENOUGH), window.matchMedia(REDUCED_MOTION)];
  const network = connection();
  queries.forEach((query) => query.addEventListener("change", onChange));
  network?.addEventListener("change", onChange);
  return () => {
    queries.forEach((query) => query.removeEventListener("change", onChange));
    network?.removeEventListener("change", onChange);
  };
}

// failIfMajorPerformanceCaveat alone lets these through, and on one the scene ran at
// 3 to 12 fps and made typing in the form take seconds.
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/** Only called once the scene is allowed, so a poster-only visitor never creates a WebGL context. */
function canRenderDepthScene(): boolean {
  try {
    const gl = document
      .createElement("canvas")
      .getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    // A browser that hides the renderer could be a software one: keep the poster.
    return renderer !== null && !SOFTWARE_RENDERER.test(renderer);
  } catch {
    return false;
  }
}

function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 300);
  return () => window.clearTimeout(id);
}

class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SceneLoader({ scene }: { scene: StoryScene }) {
  const [phase, setPhase] = useState<"waiting" | "loading" | "live" | "off">("waiting");
  const turnOff = useCallback(() => setPhase("off"), []);
  const goLive = useCallback(() => setPhase("live"), []);

  useEffect(() => {
    let live = true;
    const cancel = whenIdle(() => {
      if (!canRenderDepthScene()) return setPhase("off");
      // A missing or corrupt photo or depth map would otherwise throw inside the canvas as
      // an uncaught error. Decoding first keeps the poster quietly; the scene then reads cache.
      void Promise.all(
        [scene.posterWide.src, scene.depth.src].map((src) => {
          const image = new Image();
          image.src = src;
          return image.decode();
        }),
      ).then(
        () => live && setPhase("loading"),
        () => live && setPhase("off"),
      );
    });
    return () => {
      live = false;
      cancel();
    };
  }, [scene.posterWide.src, scene.depth.src]);

  if (phase === "waiting" || phase === "off") return null;
  return (
    <motion.div
      className="absolute inset-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: phase === "live" ? 1 : 0 }}
      transition={{ duration: 0.6, ease: [0.45, 0, 0.05, 1] }}
    >
      <SceneBoundary onError={turnOff}>
        <DepthScene scene={scene} onReady={goLive} onContextLost={turnOff} />
      </SceneBoundary>
    </motion.div>
  );
}

/**
 * The depth scene over the poster. Nothing renders until the form is painted and the
 * browser is idle. Any failure leaves the poster showing, and the poster never moves.
 */
export function DepthSceneGate({ scene }: { scene: StoryScene }) {
  const allowed = useSyncExternalStore(subscribeToSceneAllowed, isSceneAllowed, () => false);
  return allowed ? <SceneLoader scene={scene} /> : null;
}
