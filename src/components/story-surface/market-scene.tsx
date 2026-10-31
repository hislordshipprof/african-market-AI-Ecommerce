"use client";

import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float } from "@react-three/drei";
import type { Group, BufferGeometry } from "three";
import * as THREE from "three";

const PALETTE = {
  yam: "#8B6914",
  yamDark: "#6B4F10",
  plantain: "#C7A829",
  plantainGreen: "#5A7D2B",
  pepper: "#D4391C",
  pepperOrange: "#E07B20",
  pepperYellow: "#E8C820",
  palm: "#B8620A",
  palmLabel: "#F5E6C8",
  basket: "#C4903D",
  basketDark: "#9A7030",
  sack: "#D2B48C",
  sackDark: "#A08050",
  wood: "#7A5230",
  woodDark: "#5A3A20",
  leaf: "#2E6E2E",
  leafDark: "#1A4A1A",
};

function Yam({ position, rotation }: { position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <mesh position={position} rotation={rotation ?? [0, 0, 0.15]}>
      <capsuleGeometry args={[0.12, 0.5, 4, 12]} />
      <meshStandardMaterial color={PALETTE.yam} roughness={0.85} />
    </mesh>
  );
}

function Plantain({ position, rotation, ripe }: { position: [number, number, number]; rotation?: [number, number, number]; ripe?: boolean }) {
  return (
    <mesh position={position} rotation={rotation ?? [0, 0, 0.3]}>
      <capsuleGeometry args={[0.06, 0.45, 4, 8]} />
      <meshStandardMaterial color={ripe ? PALETTE.plantain : PALETTE.plantainGreen} roughness={0.7} />
    </mesh>
  );
}

function Pepper({ position, color }: { position: [number, number, number]; color?: string }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.06, 8, 8]} />
      <meshStandardMaterial color={color ?? PALETTE.pepper} roughness={0.6} />
    </mesh>
  );
}

function PalmOilBottle({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[0.06, 0.07, 0.3, 8]} />
        <meshStandardMaterial color={PALETTE.palm} roughness={0.3} metalness={0.1} transparent opacity={0.85} />
      </mesh>
      <mesh position={[0, 0.18, 0]}>
        <cylinderGeometry args={[0.03, 0.04, 0.06, 8]} />
        <meshStandardMaterial color={PALETTE.palmLabel} roughness={0.9} />
      </mesh>
    </group>
  );
}

function useBasketGeometry(): BufferGeometry {
  return useMemo(() => {
    const points = [
      new THREE.Vector2(0.2, 0),
      new THREE.Vector2(0.22, 0.02),
      new THREE.Vector2(0.25, 0.08),
      new THREE.Vector2(0.26, 0.15),
      new THREE.Vector2(0.24, 0.18),
    ];
    return new THREE.LatheGeometry(points, 12);
  }, []);
}

function Basket({ position, children }: { position: [number, number, number]; children?: React.ReactNode }) {
  const geo = useBasketGeometry();
  return (
    <group position={position}>
      <mesh geometry={geo}>
        <meshStandardMaterial color={PALETTE.basket} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geo} scale={[0.92, 0.95, 0.92]}>
        <meshStandardMaterial color={PALETTE.basketDark} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      {children}
    </group>
  );
}

function SpiceSack({ position, color }: { position: [number, number, number]; color?: string }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.14, 6, 6]} />
      <meshStandardMaterial color={color ?? PALETTE.sack} roughness={0.95} />
    </mesh>
  );
}

function WoodShelf({ position, width = 1.4 }: { position: [number, number, number]; width?: number }) {
  return (
    <mesh position={position}>
      <boxGeometry args={[width, 0.03, 0.5]} />
      <meshStandardMaterial color={PALETTE.wood} roughness={0.85} />
    </mesh>
  );
}

function Leaf({ position, rotation }: { position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <mesh position={position} rotation={rotation ?? [0.3, 0, 0.1]}>
      <planeGeometry args={[0.15, 0.06]} />
      <meshStandardMaterial color={PALETTE.leaf} roughness={0.8} side={THREE.DoubleSide} />
    </mesh>
  );
}

function MarketStall() {
  const groupRef = useRef<Group>(null);

  useFrame((state) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.15) * 0.03;
  });

  return (
    <group ref={groupRef} position={[0, -0.3, 0]}>
      {/* Shelves */}
      <WoodShelf position={[0, -0.5, 0]} />
      <WoodShelf position={[0, 0.05, 0]} />
      <WoodShelf position={[0, 0.6, 0]} />

      {/* Shelf legs */}
      {[-0.65, 0.65].map((x) => (
        <mesh key={x} position={[x, 0, 0]}>
          <boxGeometry args={[0.04, 1.4, 0.04]} />
          <meshStandardMaterial color={PALETTE.woodDark} roughness={0.9} />
        </mesh>
      ))}

      {/* Bottom shelf: yams and plantains */}
      <Yam position={[-0.4, -0.35, 0.05]} />
      <Yam position={[-0.15, -0.37, -0.08]} rotation={[0, 0.5, 0.2]} />
      <Yam position={[0.1, -0.34, 0.1]} rotation={[0.1, -0.3, 0.1]} />
      <Plantain position={[0.35, -0.38, 0]} ripe />
      <Plantain position={[0.42, -0.36, 0.08]} ripe />
      <Plantain position={[0.5, -0.38, -0.05]} />
      <Leaf position={[0.3, -0.33, 0.12]} />

      {/* Middle shelf: baskets with peppers, spice sacks */}
      <Basket position={[-0.4, 0.08, 0]}>
        {Array.from({ length: 8 }).map((_, i) => (
          <Pepper
            key={i}
            position={[
              Math.cos(i * 0.8) * 0.1,
              0.14 + (i % 3) * 0.015,
              Math.sin(i * 0.8) * 0.1,
            ]}
            color={[PALETTE.pepper, PALETTE.pepperOrange, PALETTE.pepperYellow][i % 3]}
          />
        ))}
      </Basket>
      <SpiceSack position={[-0.05, 0.18, 0.02]} color="#C4A35A" />
      <SpiceSack position={[0.12, 0.17, -0.04]} color="#D4763A" />
      <SpiceSack position={[0.28, 0.18, 0.05]} color="#8B7355" />
      <Leaf position={[0.45, 0.1, 0.1]} rotation={[-0.2, 0.5, 0]} />

      {/* Top shelf: palm oil bottles and basket */}
      <PalmOilBottle position={[-0.45, 0.66, 0]} />
      <PalmOilBottle position={[-0.3, 0.66, 0.05]} />
      <PalmOilBottle position={[-0.15, 0.66, -0.03]} />
      <Basket position={[0.15, 0.63, 0]}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Pepper
            key={i}
            position={[
              Math.cos(i * 1.2) * 0.08,
              0.13,
              Math.sin(i * 1.2) * 0.08,
            ]}
            color={PALETTE.pepperOrange}
          />
        ))}
      </Basket>
      <Plantain position={[0.45, 0.68, 0.02]} rotation={[0, 0.8, 0.4]} ripe />
    </group>
  );
}

export function MarketScene() {
  return (
    <Canvas
      camera={{ position: [0, 0.2, 2.8], fov: 35 }}
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 1.5]}
      style={{ pointerEvents: "none" }}
    >
      <fog attach="fog" args={["#2A1A0A", 3, 7]} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 4, 2]} intensity={1.1} color="#FFF0D4" />
      <directionalLight position={[-2, 2, -1]} intensity={0.3} color="#FFD9A0" />
      <pointLight position={[0, 1.5, 1]} intensity={0.5} color="#FFA040" distance={4} />
      <Float speed={0.3} floatIntensity={0.05} rotationIntensity={0.02}>
        <MarketStall />
      </Float>
    </Canvas>
  );
}
