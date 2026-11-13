"use client";

import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { MathUtils, TextureLoader, Vector2, type ShaderMaterial } from "three";
import type { StoryScene } from "./scenes";

// Offsets are in photo widths at the near plane. The poster's 3% overscan hides the
// edge of the photo, so the sum of these has to stay under 0.06 (half is applied at
// each extreme, either side of the focal plane).
const POINTER_RANGE = new Vector2(0.022, 0.012);
const DRIFT = 0.006;
const WAKE = 0.02;
const WAKE_SECONDS = 2.6;

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Marches the view ray through the depth map, so a near edge hides what is behind
// it instead of smearing over it. With a zero offset every sample lands on the same
// texel, which makes the output the poster, pixel for pixel.
const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uPhoto;
  uniform sampler2D uDepth;
  uniform vec2 uOffset;
  uniform vec2 uCover;
  uniform vec2 uFocus;
  varying vec2 vUv;

  const int STEPS = 14;
  const float FOCAL_PLANE = 0.5;

  void main() {
    vec2 uv = vUv * uCover + (vec2(1.0) - uCover) * uFocus;
    float stepHeight = 1.0 / float(STEPS);
    float height = 1.0;
    vec2 sampleAt = uv + uOffset * (height - FOCAL_PLANE);
    float gap = height - textureLod(uDepth, sampleAt, 0.0).r;
    float previousHeight = height;
    float previousGap = gap;
    for (int i = 0; i < STEPS && gap > 0.0; i++) {
      previousHeight = height;
      previousGap = gap;
      height -= stepHeight;
      sampleAt = uv + uOffset * (height - FOCAL_PLANE);
      gap = height - textureLod(uDepth, sampleAt, 0.0).r;
    }
    float hit = clamp(previousGap / max(previousGap - gap, 0.0001), 0.0, 1.0);
    sampleAt = uv + uOffset * (mix(previousHeight, height, hit) - FOCAL_PLANE);
    gl_FragColor = texture2D(uPhoto, sampleAt);
  }
`;

function DepthPlane({
  scene,
  onReady,
  onContextLost,
}: {
  scene: StoryScene;
  onReady: () => void;
  onContextLost: () => void;
}) {
  const [photo, depth] = useLoader(TextureLoader, [scene.posterWide.src, scene.depth.src]);
  const material = useRef<ShaderMaterial>(null);
  const canvas = useThree((state) => state.gl.domElement);
  const target = useRef({ x: 0, y: 0 });
  const eased = useRef({ x: 0, y: 0 });
  const wokeAt = useRef<number | null>(null);

  const uniforms = useMemo(
    () => ({
      uPhoto: { value: photo },
      uDepth: { value: depth },
      uOffset: { value: new Vector2() },
      uCover: { value: new Vector2(1, 1) },
      // Textures read bottom-up, object-position reads top-down.
      uFocus: { value: new Vector2(scene.focus.x, 1 - scene.focus.y) },
    }),
    [photo, depth, scene.focus.x, scene.focus.y],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      target.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      target.current.y = 1 - (event.clientY / window.innerHeight) * 2;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);

  useEffect(() => {
    canvas.addEventListener("webglcontextlost", onContextLost);
    return () => canvas.removeEventListener("webglcontextlost", onContextLost);
  }, [canvas, onContextLost]);

  // The canvas fades in only after the first frame has drawn.
  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(onReady));
    return () => cancelAnimationFrame(frame);
  }, [onReady]);

  useFrame((state, delta) => {
    const shader = material.current;
    if (!shader) return;
    wokeAt.current ??= state.clock.elapsedTime;
    const seconds = state.clock.elapsedTime - wokeAt.current;
    const step = Math.min(delta, 0.05);
    eased.current.x = MathUtils.damp(eased.current.x, target.current.x, 3, step);
    eased.current.y = MathUtils.damp(eased.current.y, target.current.y, 3, step);

    // One slow breath as the photo wakes up, then a drift so depth reads without a pointer.
    const wake = Math.sin(Math.PI * Math.min(seconds / WAKE_SECONDS, 1)) * WAKE;
    const settle = MathUtils.smoothstep(seconds, 0, WAKE_SECONDS);
    const driftX = Math.sin(seconds * 0.21) * DRIFT;
    const driftY = Math.sin(seconds * 0.16 + 1) * DRIFT * 0.6;
    shader.uniforms.uOffset.value.set(
      (eased.current.x * POINTER_RANGE.x + driftX) * settle + wake,
      (eased.current.y * POINTER_RANGE.y + driftY) * settle - wake * 0.3,
    );

    const viewAspect = state.size.width / state.size.height;
    const photoAspect = scene.posterWide.width / scene.posterWide.height;
    shader.uniforms.uCover.value.set(
      Math.min(viewAspect / photoAspect, 1),
      Math.min(photoAspect / viewAspect, 1),
    );
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={material}
        vertexShader={VERTEX}
        fragmentShader={FRAGMENT}
        uniforms={uniforms}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

// Inside the canvas, so a missing or corrupt photo or depth map is caught in the scene's own
// renderer, not reported as uncaught; the gate then keeps the poster.
class PlaneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
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

export default function DepthScene(props: {
  scene: StoryScene;
  onReady: () => void;
  onContextLost: () => void;
}) {
  return (
    <Canvas
      flat
      linear
      dpr={[1, 2]}
      // The parent carries a percentage overscan and an entrance scale. Measure the
      // layout box, not the transformed one, or the photo stops lining up with the poster.
      resize={{ offsetSize: true }}
      gl={{
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "low-power",
        failIfMajorPerformanceCaveat: true,
      }}
    >
      <PlaneBoundary onError={props.onContextLost}>
        <Suspense fallback={null}>
          <DepthPlane {...props} />
        </Suspense>
      </PlaneBoundary>
    </Canvas>
  );
}
