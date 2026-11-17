import * as React from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import type { Group } from 'three';

/** Abstract campus: a grid of blocks of different heights, turning very slowly. Calm, low-poly, no textures. */
const BLOCKS: { x: number; z: number; h: number }[] = [];
for (let i = -3; i <= 3; i++) {
  for (let j = -3; j <= 3; j++) {
    if ((i * 7 + j * 13) % 3 === 0) continue;
    const h = 0.4 + (((i * 31 + j * 17) % 5) + 5) % 5 * 0.35;
    BLOCKS.push({ x: i * 1.15, z: j * 1.15, h });
  }
}

function Campus({ accent }: { accent: string }) {
  const g = React.useRef<Group>(null);
  useFrame((_, dt) => { if (g.current) g.current.rotation.y += dt * 0.05; });
  return (
    <group ref={g} rotation={[0, 0.6, 0]} position={[0, -0.9, 0]}>
      {BLOCKS.map((b, i) => (
        <mesh key={i} position={[b.x, b.h / 2, b.z]}>
          <boxGeometry args={[0.85, b.h, 0.85]} />
          <meshStandardMaterial color={i % 9 === 0 ? accent : '#9aa6d8'} roughness={0.7} metalness={0.05} transparent opacity={i % 9 === 0 ? 0.95 : 0.55} />
        </mesh>
      ))}
    </group>
  );
}

export default function CampusScene({ active, accent = '#3b4cca' }: { active: boolean; accent?: string }) {
  return (
    <Canvas
      frameloop={active ? 'always' : 'never'}
      dpr={[1, 1.5]}
      camera={{ position: [5.5, 5, 7.5], fov: 38 }}
      gl={{ antialias: false, powerPreference: 'low-power', alpha: true }}
      style={{ pointerEvents: 'none' }}
      aria-hidden
    >
      <ambientLight intensity={0.9} />
      <directionalLight position={[5, 8, 4]} intensity={1.1} />
      <Campus accent={accent} />
    </Canvas>
  );
}
