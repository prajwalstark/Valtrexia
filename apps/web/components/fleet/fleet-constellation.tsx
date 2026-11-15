"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import type { BackupStatus, Health } from "@valtrexia/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Constellation, ConstellationNode } from "@/lib/fleet-view";

/** Theme colours resolved to values three.js understands. */
export interface SceneColors {
  health: Record<Health, string>;
  status: Record<BackupStatus, string>;
  line: string;
  lineStrong: string;
}

export interface FleetConstellationProps {
  constellation: Constellation;
  colors: SceneColors;
  /** False while the stage is scrolled out of view: rendering stops. */
  active: boolean;
  /** A mouse or trackpad is in use, so dragging to rotate makes sense. */
  finePointer: boolean;
  onOpen: (clientId: string) => void;
  /** The WebGL context was lost. The caller falls back to the 2D view. */
  onContextLost: () => void;
}

/** At most this many names are shown at rest, and only for clients needing action. */
const PINNED_LABELS = 3;
const FOV = 34;

/**
 * The fleet as a constellation. Each sphere is a client, coloured by health
 * and placed worst first from the centre; the dots circling it are its
 * assets, coloured by status. Selecting a client opens it.
 *
 * Everything of one kind is drawn in a single batched call (all client
 * spheres, all orbits, all assets), so the scene costs a handful of draw
 * calls whether the fleet has ten clients or a hundred.
 *
 * This file is the only place three.js is imported, and it is loaded on
 * demand, so none of it is in the page's initial JavaScript.
 */
export default function FleetConstellation({
  constellation,
  colors,
  active,
  finePointer,
  onOpen,
  onContextLost,
}: FleetConstellationProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const labelElements = useRef(new Map<number, HTMLDivElement>());
  const { nodes } = constellation;

  // Leaving the 3D view releases its WebGL context, which fires the same
  // event as a real failure. Only a loss while still mounted is reported.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    document.body.style.cursor = hovered === null ? "" : "pointer";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hovered]);

  // Names shown at rest: the first few clients that need action. They sit
  // close together at the centre, so they alternate above and below their
  // client to keep out of each other's way. The hovered client is always
  // labelled, above, with its state.
  const labelled = useMemo(() => {
    const pinned = nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.health === "red")
      .slice(0, PINNED_LABELS)
      .map((entry, order) => ({ ...entry, below: order % 2 === 1 }));
    const hoveredNode = hovered === null ? undefined : nodes[hovered];
    if (hovered === null || !hoveredNode) return pinned;
    return [
      ...pinned.filter(({ index }) => index !== hovered),
      { node: hoveredNode, index: hovered, below: false },
    ];
  }, [nodes, hovered]);

  // Called every frame with where a label belongs. It writes straight to the
  // element, so following the scene costs no React render.
  const placeLabel = useCallback((index: number, x: number, y: number, below: boolean) => {
    const element = labelElements.current.get(index);
    // Centred horizontally on the client, just above or just below it.
    if (element) {
      element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, ${below ? "0" : "-100%"})`;
    }
  }, []);
  const labelTargets = useMemo(
    () => labelled.map(({ index, below }) => ({ index, below })),
    [labelled],
  );

  return (
    <div className="relative size-full">
      <Canvas
        // Capped: beyond this, extra pixels cost a lot and show little.
        dpr={[1, 1.75]}
        frameloop={active ? "always" : "never"}
        camera={{ fov: FOV, near: 0.1, far: 400 }}
        gl={{ antialias: true, alpha: true }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener(
            "webglcontextlost",
            () => {
              if (mounted.current) onContextLost();
            },
            { once: true },
          );
        }}
        onPointerMissed={() => setHovered(null)}
      >
        <Framing extent={constellation.extent} />
        <ambientLight intensity={1.15} />
        <directionalLight position={[5, 10, 6]} intensity={2.2} />

        <Drift paused={hovered !== null}>
          <GroundRings extent={constellation.extent} color={colors.line} />
          <Fleet
            nodes={nodes}
            colors={colors}
            hovered={hovered}
            onHover={setHovered}
            onOpen={(index) => {
              const node = nodes[index];
              if (node) onOpen(node.id);
            }}
          />
          <LabelTracker nodes={nodes} targets={labelTargets} place={placeLabel} />
        </Drift>

        {finePointer ? (
          <OrbitControls
            // Rotate only. Zoom would hijack page scrolling; pan would lose the scene.
            enableZoom={false}
            enablePan={false}
            minPolarAngle={0.5}
            maxPolarAngle={1.3}
            // The same point the camera is framed on, or the first drag would jump.
            target={[0, -0.2, constellation.extent * 0.1]}
          />
        ) : null}
      </Canvas>

      {/*
        Labels are ordinary HTML laid over the canvas, so they use the page's
        own type and stay sharp. LabelTracker moves each one to follow its
        client. They never take pointer events: the scene underneath does.
      */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {labelled.map(({ node, index }) => {
          const isHovered = index === hovered;
          return (
            <div
              key={node.id}
              ref={(element) => {
                if (element) labelElements.current.set(index, element);
                else labelElements.current.delete(index);
              }}
              data-fleet-label={isHovered ? "hovered" : "pinned"}
              // Off-stage until the first frame places it.
              style={{ transform: "translate(-999px, -999px)", zIndex: isHovered ? 2 : 1 }}
              className={
                isHovered
                  ? "absolute top-0 left-0 rounded-md border border-line-strong bg-surface-raised px-2.5 py-1.5 text-center whitespace-nowrap"
                  : "absolute top-0 left-0 rounded-sm bg-background/75 px-1.5 py-0.5 text-center whitespace-nowrap"
              }
            >
              <p className="text-xs font-semibold text-foreground">{node.name}</p>
              {isHovered ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {node.description}
                  {node.moreAssets > 0 ? ` (${node.moreAssets} more not drawn)` : ""}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Places the camera so the whole constellation fits, whatever the shape of
 * the stage: a narrow stage (a phone) needs the camera further back.
 */
function Framing({ extent }: { extent: number }) {
  const camera = useThree((state) => state.camera);
  const aspect = useThree((state) => state.size.width / Math.max(1, state.size.height));

  useLayoutEffect(() => {
    const distance = extent * 2.5 * Math.max(1, 1.3 / aspect) + 1.6;
    camera.position.set(0, distance * 0.62, distance * 0.79);
    // Aim a little in front of the centre: perspective makes the near half
    // of the disc larger, and this keeps its edge inside the frame.
    camera.lookAt(0, -0.2, extent * 0.1);
    camera.updateProjectionMatrix();
  }, [camera, extent, aspect]);
  return null;
}

/** Turns the whole scene very slowly, and holds still while something is hovered. */
function Drift({ paused, children }: { paused: boolean; children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (group.current && !paused) group.current.rotation.y += Math.min(delta, 0.1) * 0.035;
  });
  return <group ref={group}>{children}</group>;
}

/** Faint concentric rings on the floor: the same motif as the sign-in screen. */
function GroundRings({ extent, color }: { extent: number; color: string }) {
  const radii = useMemo(() => {
    const count = Math.max(2, Math.min(6, Math.round(extent / 1.6)));
    return Array.from({ length: count }, (_, i) => ((i + 1) / count) * extent);
  }, [extent]);
  return (
    <group rotation-x={-Math.PI / 2} position-y={-0.5}>
      {radii.map((radius) => (
        <mesh key={radius}>
          <ringGeometry args={[radius - 0.012, radius + 0.012, 128]} />
          <meshBasicMaterial color={color} transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

/** Scratch vector for LabelTracker. Used and discarded within one frame callback. */
const LABEL_POINT = new THREE.Vector3();

/**
 * Works out where each label belongs on screen. It sits inside the turning
 * group, so its own world matrix is the group's.
 */
function LabelTracker({
  nodes,
  targets,
  place,
}: {
  nodes: ConstellationNode[];
  targets: { index: number; below: boolean }[];
  place: (index: number, x: number, y: number, below: boolean) => void;
}) {
  const anchor = useRef<THREE.Object3D>(null);

  useFrame(({ camera, size }) => {
    const origin = anchor.current;
    if (!origin) return;
    for (const { index, below } of targets) {
      const node = nodes[index];
      if (!node) continue;
      const lift = (node.radius + 0.3) * (below ? -1 : 1);
      LABEL_POINT.set(node.x, lift, node.z).applyMatrix4(origin.matrixWorld).project(camera);
      place(
        index,
        (LABEL_POINT.x * 0.5 + 0.5) * size.width,
        (-LABEL_POINT.y * 0.5 + 0.5) * size.height,
        below,
      );
    }
  });
  return <object3D ref={anchor} />;
}

const FLAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const UPRIGHT = new THREE.Quaternion();

function Fleet({
  nodes,
  colors,
  hovered,
  onHover,
  onOpen,
}: {
  nodes: ConstellationNode[];
  colors: SceneColors;
  hovered: number | null;
  onHover: (index: number | null) => void;
  onOpen: (index: number) => void;
}) {
  const cores = useRef<THREE.InstancedMesh>(null);
  const orbits = useRef<THREE.InstancedMesh>(null);
  const satellites = useRef<THREE.InstancedMesh>(null);
  const targets = useRef<THREE.InstancedMesh>(null);

  const satelliteCount = useMemo(
    () => nodes.reduce((sum, node) => sum + node.satellites.length, 0),
    [nodes],
  );

  // Everything that does not move is written once.
  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const tint = new THREE.Color();

    let satellite = 0;
    nodes.forEach((node, i) => {
      position.set(node.x, 0, node.z);

      cores.current?.setColorAt(i, tint.set(colors.health[node.health]));
      orbits.current?.setMatrixAt(i, matrix.compose(position, FLAT, scale.setScalar(node.orbit)));
      targets.current?.setMatrixAt(
        i,
        matrix.compose(position, UPRIGHT, scale.setScalar(node.orbit + 0.14)),
      );
      for (const status of node.satellites) {
        satellites.current?.setColorAt(satellite, tint.set(colors.status[status]));
        satellite += 1;
      }
    });

    for (const mesh of [cores, orbits, satellites, targets]) {
      const instance = mesh.current;
      if (!instance) continue;
      instance.instanceMatrix.needsUpdate = true;
      if (instance.instanceColor) instance.instanceColor.needsUpdate = true;
      // Instances sit far from the mesh's own origin; recompute what the
      // pointer ray is tested against, or hovering would miss them.
      instance.computeBoundingSphere();
    }
  }, [nodes, colors]);

  // What moves: assets circle their client, and clients needing action pulse.
  const scratch = useMemo(
    () => ({
      matrix: new THREE.Matrix4(),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(),
    }),
    [],
  );
  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    const { matrix, position, scale } = scratch;

    let satellite = 0;
    nodes.forEach((node, i) => {
      // Only clients that need action move on their own, and only slightly:
      // motion is used to draw the eye, so it is spent where it matters.
      const pulse = node.health === "red" ? 1 + Math.sin(time * 2.4 + i) * 0.07 : 1;
      const size = node.radius * pulse * (hovered === i ? 1.2 : 1);
      cores.current?.setMatrixAt(
        i,
        matrix.compose(position.set(node.x, 0, node.z), UPRIGHT, scale.setScalar(size)),
      );

      const turn = time * 0.25 * (i % 2 === 0 ? 1 : -1);
      const count = node.satellites.length;
      for (let j = 0; j < count; j += 1) {
        const angle = (j / count) * Math.PI * 2 + turn;
        position.set(
          node.x + Math.cos(angle) * node.orbit,
          0,
          node.z + Math.sin(angle) * node.orbit,
        );
        satellites.current?.setMatrixAt(
          satellite,
          matrix.compose(position, UPRIGHT, scale.setScalar(1)),
        );
        satellite += 1;
      }
    });
    if (cores.current) cores.current.instanceMatrix.needsUpdate = true;
    if (satellites.current) satellites.current.instanceMatrix.needsUpdate = true;
  });

  // Less geometry per sphere when there are many of them: at that size on
  // screen the difference is invisible, and it keeps weaker graphics cards smooth.
  const coreDetail: [number, number] = nodes.length > 40 ? [16, 12] : [28, 20];
  const satelliteDetail: [number, number] = satelliteCount > 600 ? [6, 5] : [10, 8];

  if (nodes.length === 0) return null;
  return (
    <>
      <instancedMesh ref={cores} args={[undefined, undefined, nodes.length]} frustumCulled={false}>
        <sphereGeometry args={[1, ...coreDetail]} />
        <meshStandardMaterial roughness={0.5} metalness={0.05} />
      </instancedMesh>

      <instancedMesh ref={orbits} args={[undefined, undefined, nodes.length]} frustumCulled={false}>
        <ringGeometry args={[0.985, 1, 64]} />
        <meshBasicMaterial
          color={colors.lineStrong}
          transparent
          opacity={0.7}
          side={THREE.DoubleSide}
        />
      </instancedMesh>

      {satelliteCount > 0 ? (
        <instancedMesh
          key={satelliteCount}
          ref={satellites}
          args={[undefined, undefined, satelliteCount]}
          frustumCulled={false}
        >
          <sphereGeometry args={[0.052, ...satelliteDetail]} />
          <meshBasicMaterial />
        </instancedMesh>
      ) : null}

      {/* Generous invisible targets, so a client is easy to hit. */}
      <instancedMesh
        ref={targets}
        args={[undefined, undefined, nodes.length]}
        frustumCulled={false}
        onPointerMove={(event) => {
          event.stopPropagation();
          if (event.instanceId !== undefined) onHover(event.instanceId);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(event) => {
          event.stopPropagation();
          if (event.instanceId !== undefined) onOpen(event.instanceId);
        }}
      >
        <sphereGeometry args={[1, 10, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </instancedMesh>
    </>
  );
}
