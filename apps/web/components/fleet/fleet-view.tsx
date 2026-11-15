"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { HEALTH_META } from "@/components/status/status";
import type { FleetClient } from "@/lib/dashboard-core";
import { count } from "@/lib/format";
import {
  buildConstellation,
  CAPABLE_COOKIE,
  chooseFleetView,
  parsePreference,
  PREFERENCE_COOKIE,
  type DeviceCapabilities,
  type FleetViewMode,
  type FleetViewPreference,
} from "@/lib/fleet-view";
import { cn } from "@/lib/utils";
import type { SceneColors } from "./fleet-constellation";

// three.js and the scene are fetched only when the 3D view is actually shown.
const FleetConstellation = dynamic(() => import("./fleet-constellation"), {
  ssr: false,
  loading: () => <StageMessage>Loading the 3D view…</StageMessage>,
});

const YEAR_SECONDS = 60 * 60 * 24 * 365;

function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Not sensitive: it holds "3d" or "2d", and lets the server render the right view first. */
function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax`;
}

function detectDevice(): DeviceCapabilities {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  let webgl2 = false;
  let softwareRendering = false;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    webgl2 = gl !== null;
    if (gl) {
      // Names such as "SwiftShader" or "llvmpipe" mean the CPU is drawing.
      // Browsers that hide the renderer's name are assumed to be accelerated.
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      softwareRendering = /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    webgl2 = false;
  }
  return {
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    webgl2,
    cores: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null,
    memoryGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    saveData: nav.connection?.saveData === true,
    softwareRendering,
  };
}

/**
 * Resolves a CSS colour (ours are in OKLCH, which three.js cannot parse) to
 * a hex value by letting the browser paint it and reading the pixel back.
 */
function resolveColor(context: CanvasRenderingContext2D, value: string): string {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function readSceneColors(): SceneColors | null {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => resolveColor(context, style.getPropertyValue(name).trim());
  return {
    health: {
      red: token("--status-critical"),
      amber: token("--status-warning"),
      green: token("--status-success"),
      none: token("--status-unknown"),
    },
    status: {
      failed: token("--status-critical"),
      missed: token("--status-critical"),
      warning: token("--status-warning"),
      unknown: token("--status-unknown"),
      running: token("--status-running"),
      success: token("--status-success"),
    },
    line: token("--line"),
    lineStrong: token("--line-strong"),
  };
}

/** Everything the view needs to know about this browser. Null on the server. */
interface BrowserEnvironment {
  preference: FleetViewPreference;
  device: DeviceCapabilities;
  colors: SceneColors | null;
  finePointer: boolean;
}

// The browser's settings are an external store: read once, cached, and re-read
// when the reduced-motion setting changes or the person picks a view.
let cachedEnvironment: BrowserEnvironment | null = null;
const environmentListeners = new Set<() => void>();

function getEnvironment(): BrowserEnvironment {
  cachedEnvironment ??= {
    preference: parsePreference(readCookie(PREFERENCE_COOKIE)),
    device: detectDevice(),
    colors: readSceneColors(),
    finePointer: window.matchMedia("(pointer: fine)").matches,
  };
  return cachedEnvironment;
}

function refreshEnvironment(): void {
  cachedEnvironment = null;
  for (const listener of environmentListeners) listener();
}

function subscribeToEnvironment(listener: () => void): () => void {
  environmentListeners.add(listener);
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", refreshEnvironment);
  return () => {
    environmentListeners.delete(listener);
    query.removeEventListener("change", refreshEnvironment);
  };
}

const noEnvironment = () => null;

/**
 * The fleet, in 3D where the device and the person's settings allow it and
 * in 2D otherwise.
 *
 * The 2D view is rendered on the server and passed in as `grid`, so it is
 * there before any JavaScript runs. The 3D view replaces it only after the
 * browser has confirmed it can and should show it.
 */
export function FleetView({
  clients,
  initialMode,
  grid,
  summary: summarySlot,
}: {
  clients: FleetClient[];
  /** What the server rendered, from last visit's cookies. */
  initialMode: FleetViewMode;
  grid: ReactNode;
  /** The fleet's figures. Beside the 3D stage on wide screens, below the 2D grid. */
  summary: ReactNode;
}) {
  const router = useRouter();
  const stage = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  // Null while rendering on the server and during hydration, so the first
  // client render matches the server's. Then the browser's real answer.
  const environment = useSyncExternalStore(subscribeToEnvironment, getEnvironment, noEnvironment);
  const decision = environment ? chooseFleetView(environment.preference, environment.device) : null;
  const colors = environment?.colors ?? null;
  const finePointer = environment?.finePointer ?? false;

  const constellation = useMemo(() => buildConstellation(clients), [clients]);
  const mode: FleetViewMode = failure ? "2d" : (decision?.mode ?? initialMode);
  const showing3d = decision?.mode === "3d" && !failure;

  // Remember whether 3D was shown, so the server renders the right view next time.
  useEffect(() => {
    if (decision) writeCookie(CAPABLE_COOKIE, showing3d ? "1" : "0");
  }, [decision, showing3d]);

  // Stop rendering frames while the stage is scrolled out of view.
  useEffect(() => {
    const element = stage.current;
    if (!element || mode !== "3d") return;
    const observer = new IntersectionObserver(([entry]) =>
      setOnScreen(entry?.isIntersecting ?? true),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  function choose(next: FleetViewMode) {
    writeCookie(PREFERENCE_COOKIE, next);
    setFailure(null);
    refreshEnvironment();
  }

  function fail(message: string) {
    setFailure(message);
  }

  const canUse3d = decision?.canUse3d ?? true;
  const note = failure ?? decision?.reason ?? null;
  const summary = summarize(clients);

  return (
    <section aria-labelledby="fleet-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h2 id="fleet-heading" className="text-lg font-semibold">
          Fleet
        </h2>
        <div className="flex items-center gap-3">
          {note ? <p className="text-sm text-subtle-foreground">{note}</p> : null}
          <div
            role="group"
            aria-label="Fleet view"
            className="flex rounded-md border border-line-strong p-0.5"
          >
            {(["3d", "2d"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                disabled={option === "3d" && !canUse3d}
                onClick={() => choose(option)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45",
                  mode === option
                    ? "bg-surface-raised text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option === "3d" ? "3D" : "2D"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === "3d" ? (
        <div className="grid items-center gap-x-10 gap-y-8 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div>
            <div
              ref={stage}
              role="img"
              aria-label={`3D view of ${summary}. The same clients are listed below.`}
              data-fleet-stage=""
              className="relative h-[20rem] overflow-hidden rounded-lg border border-line bg-surface/50 sm:h-[24rem]"
            >
              {showing3d && colors ? (
                <SceneBoundary
                  onError={() => fail("The 3D view could not start, so the 2D view is shown.")}
                >
                  <FleetConstellation
                    constellation={constellation}
                    colors={colors}
                    active={onScreen}
                    finePointer={finePointer}
                    onOpen={(id) => router.push(`/clients/${id}`)}
                    onContextLost={() => fail("The 3D view stopped, so the 2D view is shown.")}
                  />
                </SceneBoundary>
              ) : (
                <StageMessage>Loading the 3D view…</StageMessage>
              )}
            </div>
            <p className="mt-3 text-sm text-subtle-foreground">
              Each sphere is a client, placed worst first from the centre. The dots around it are
              its assets. Select a client to open it
              {finePointer ? ", or drag to turn the view" : ""}.
              {constellation.moreClients > 0
                ? ` Showing the ${constellation.nodes.length} clients that most need attention; all ${clients.length} are in the list below.`
                : ""}
            </p>
          </div>
          {summarySlot}
        </div>
      ) : (
        <>
          {grid}
          <div className="mt-10">{summarySlot}</div>
        </>
      )}
    </section>
  );
}

function summarize(clients: FleetClient[]): string {
  const tally = { red: 0, amber: 0, green: 0, none: 0 };
  for (const client of clients) tally[client.summary.health] += 1;
  const parts = (["red", "amber", "green", "none"] as const)
    .filter((level) => tally[level] > 0)
    .map((level) => `${tally[level]} ${HEALTH_META[level].label.toLowerCase()}`);
  return `${count(clients.length, "client")}: ${parts.join(", ")}`;
}

function StageMessage({ children }: { children: ReactNode }) {
  return (
    <p className="absolute inset-0 flex items-center justify-center text-sm text-subtle-foreground">
      {children}
    </p>
  );
}

/** If the scene throws while rendering, show the 2D view instead of a broken page. */
class SceneBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
