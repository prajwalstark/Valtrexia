/**
 * Decorative figure for the auth screens: rings of tick marks around a centre.
 * Read it as a fleet seen from above, one ring per client and one tick per
 * protected asset, with a few ticks lit in status colours. It is the 2D
 * precursor of the 3D fleet view added in step 11.
 */

interface Ring {
  radius: number;
  ticks: number;
  length: number;
  /** Tick index mapped to a status colour. Everything else is neutral. */
  lit: Record<number, string>;
  /** Turns the opposite way to its neighbours. */
  reverse?: boolean;
}

const OK = "var(--status-success)";
const WARN = "var(--status-warning)";
const CRIT = "var(--status-critical)";

const RINGS: Ring[] = [
  { radius: 92, ticks: 24, length: 10, lit: { 3: OK, 4: OK, 11: WARN, 17: OK } },
  {
    radius: 150,
    ticks: 40,
    length: 12,
    lit: { 6: OK, 7: OK, 8: OK, 22: CRIT, 31: OK },
    reverse: true,
  },
  {
    radius: 214,
    ticks: 60,
    length: 14,
    lit: { 2: OK, 14: OK, 15: OK, 16: WARN, 40: OK, 41: OK, 52: OK },
  },
  {
    radius: 284,
    ticks: 84,
    length: 16,
    lit: { 9: OK, 10: OK, 33: OK, 47: CRIT, 48: OK, 70: OK },
    reverse: true,
  },
  { radius: 360, ticks: 112, length: 18, lit: { 5: OK, 27: OK, 28: OK, 61: WARN, 90: OK, 91: OK } },
];

const SIZE = 800;
const CENTER = SIZE / 2;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function Aperture({ className }: { className?: string }) {
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} fill="none" aria-hidden="true" className={className}>
      {RINGS.map((ring) => (
        <g
          key={ring.radius}
          className="motion-safe:animate-aperture"
          style={{
            transformOrigin: "center",
            transformBox: "view-box",
            animationDirection: ring.reverse ? "reverse" : "normal",
          }}
        >
          {Array.from({ length: ring.ticks }, (_, i) => {
            const angle = (i / ring.ticks) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const lit = ring.lit[i];
            return (
              <line
                key={i}
                x1={round(CENTER + cos * ring.radius)}
                y1={round(CENTER + sin * ring.radius)}
                x2={round(CENTER + cos * (ring.radius + ring.length))}
                y2={round(CENTER + sin * (ring.radius + ring.length))}
                stroke={lit ?? "var(--line-strong)"}
                strokeWidth={lit ? 3 : 1.5}
                strokeLinecap="round"
              />
            );
          })}
        </g>
      ))}
      <circle cx={CENTER} cy={CENTER} r="46" stroke="var(--iris)" strokeWidth="2" />
      <circle cx={CENTER} cy={CENTER} r="14" fill="var(--iris)" />
    </svg>
  );
}
