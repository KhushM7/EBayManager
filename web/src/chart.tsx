import { useState } from "preact/hooks";

// Small single-series charts in hand-rolled SVG. One measure per chart (never two y-axes), one validated hue
// (--chart, #008aa3: passes the dataviz lightness, chroma and contrast checks on --bg), thin marks, a recessive
// baseline, a readout that follows the pointer or thumb, and a table view for every chart.

export interface Point {
  day: string;
  value: number;
}

interface Props {
  title: string;
  points: Point[];
  kind: "line" | "bar";
  format: (n: number) => string;
  /** A dashed horizontal reference, e.g. the daily budget. */
  reference?: { value: number; label: string };
}

const W = 560;
const H = 150;
const PAD = { top: 6, right: 6, bottom: 4, left: 6 };

const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function Chart({ title, points, kind, format, reference }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2)
    return (
      <figure class="chart">
        <figcaption class="chart-title">{title}</figcaption>
        <p class="muted">{points.length ? `${format(points[0].value)} today. A line appears after a second day.` : "No data yet."}</p>
      </figure>
    );

  const max = Math.max(...points.map((p) => p.value), reference?.value ?? 0) || 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (kind === "bar" ? (i + 0.5) * (innerW / points.length) : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const base = PAD.top + innerH;
  const barW = Math.max(2, innerW / points.length - 2);

  const pick = (e: PointerEvent) => {
    const svg = e.currentTarget as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = kind === "bar" ? Math.floor(((px - PAD.left) / innerW) * points.length) : Math.round(((px - PAD.left) / innerW) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const shown = hover ?? points.length - 1;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");

  return (
    <figure class="chart" data-ui>
      <figcaption class="chart-title">
        <span>{title}</span>
        <span class="chart-readout" aria-live="polite">
          {format(points[shown].value)} <span class="muted">{dayLabel(points[shown].day)}</span>
        </span>
      </figcaption>
      <div class="chart-max">Top of scale {format(max)}</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: ${format(points[0].value)} on ${dayLabel(points[0].day)} to ${format(points.at(-1)!.value)} on ${dayLabel(points.at(-1)!.day)}`}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
      >
        <line x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} class="chart-base" />
        {reference && <line x1={PAD.left} x2={W - PAD.right} y1={y(reference.value)} y2={y(reference.value)} class="chart-ref" />}
        {kind === "line" ? (
          <>
            {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={base} class="chart-cross" />}
            <path d={line} class="chart-line" />
            <circle cx={x(shown)} cy={y(points[shown].value)} r="4.5" class="chart-dot" />
          </>
        ) : (
          points.map((p, i) => {
            const h = Math.max(p.value > 0 ? 2 : 0, base - y(p.value));
            const r = Math.min(4, barW / 2, h);
            const left = x(i) - barW / 2;
            // Rounded data end, square at the baseline.
            const d = `M${left},${base}V${base - h + r}Q${left},${base - h} ${left + r},${base - h}H${left + barW - r}Q${left + barW},${base - h} ${left + barW},${base - h + r}V${base}Z`;
            return <path key={p.day} d={d} class={i === shown ? "chart-bar chart-bar-on" : "chart-bar"} />;
          })
        )}
      </svg>
      <div class="chart-axis">
        <span>{dayLabel(points[0].day)}</span>
        <span>{dayLabel(points.at(-1)!.day)}</span>
      </div>
      {reference && <p class="chart-note">Dashed line: {reference.label}</p>}
      <details class="chart-table">
        <summary>Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{title}</th>
            </tr>
          </thead>
          <tbody>
            {points
              .slice()
              .reverse()
              .map((p) => (
                <tr key={p.day}>
                  <td>{dayLabel(p.day)}</td>
                  <td>{format(p.value)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
