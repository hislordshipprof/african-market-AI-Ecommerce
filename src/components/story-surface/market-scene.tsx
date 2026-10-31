"use client";

import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float } from "@react-three/drei";
import type { Group } from "three";

function Blob({
  position,
  scale,
  color,
  speed = 1.2,
  floatIntensity = 0.4,
  rotationIntensity = 0.3,
  geometry = "sphere",
}: {
  position: [number, number, number];
  scale: number;
  color: string;
  speed?: number;
  floatIntensity?: number;
  rotationIntensity?: number;
  geometry?: "sphere" | "dodecahedron" | "icosahedron" | "torus";
}) {
  const geo =
    geometry === "dodecahedron" ? (
      <dodecahedronGeometry args={[1, 0]} />
    ) : geometry === "icosahedron" ? (
      <icosahedronGeometry args={[1, 0]} />
    ) : geometry === "torus" ? (
      <torusGeometry args={[1, 0.4, 16, 32]} />
    ) : (
      <sphereGeometry args={[1, 32, 32]} />
    );

  return (
    <Float speed={speed} floatIntensity={floatIntensity} rotationIntensity={rotationIntensity}>
      <mesh position={position} scale={scale}>
        {geo}
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
    </Float>
  );
}

function Scene() {
  const groupRef = useRef<Group>(null);

  useFrame((state) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = state.clock.elapsedTime * 0.02;
  });

  return (
    <group ref={groupRef}>
      <Blob position={[-2.8, 1.2, -3]} scale={1.4} color="#1F5A43" speed={0.8} floatIntensity={0.3} />
      <Blob position={[2.5, -0.8, -2]} scale={1} color="#A8DDB5" speed={1.2} floatIntensity={0.5} />
      <Blob position={[-0.5, -1.8, -1.5]} scale={0.7} color="#123726" speed={1.5} floatIntensity={0.6} />
      <Blob position={[1.2, 1.8, -2.5]} scale={0.5} color="#E1EEE3" speed={1.8} floatIntensity={0.7} geometry="dodecahedron" />
      <Blob position={[-1.5, -0.5, -1]} scale={0.45} color="#2E7D4F" speed={2} floatIntensity={0.5} geometry="icosahedron" />
      <Blob position={[3, 1.5, -4]} scale={0.8} color="#1F5A43" speed={1} floatIntensity={0.4} />
      <Blob position={[-3.2, -1.5, -3.5]} scale={0.6} color="#A8DDB5" speed={1.6} floatIntensity={0.6} geometry="dodecahedron" />
      <Blob position={[0.5, 2.5, -2]} scale={0.35} color="#55625A" speed={2.2} floatIntensity={0.8} geometry="torus" />
    </group>
  );
}

export function MarketScene() {
  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 40 }}
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 1.5]}
      style={{ pointerEvents: "none" }}
    >
      <fog attach="fog" args={["#123726", 5, 12]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 4, 3]} intensity={0.9} color="#FFF5E6" />
      <directionalLight position={[-4, 2, -2]} intensity={0.25} color="#A8DDB5" />
      <Scene />
    </Canvas>
  );
}
