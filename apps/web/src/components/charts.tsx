import { useState } from "react";
import type { Bucket } from "../types";

const nf = new Intl.NumberFormat();
export const fmtNum = (n: number) => nf.format(n);
export const fmtPct = (n: number | null | undefined) =>
  n == null ? "–" : `${Math.round(n * 1000) / 10}%`;

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return m < 60
    ? `${m} min ${String(rest).padStart(2, "0")} s`
    : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const dayLongFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
});

function bucketLabel(key: string, long = false): string {
  if (key.includes("T")) return key.slice(5).replace("T", " "); // hourly: "10-27 14:00"
  const d = new Date(`${key}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? key
    : (long ? dayLongFmt : dayFmt).format(d);
}

// ---- Over-time bars -------------------------------------------------------

const W = 640;
const H = 150;
const PAD_TOP = 8;
const PAD_BOTTOM = 24;

/** One bar per day (or hour). The busiest bar is marked; hover or focus any bar to read it. */
export function Timeline({ data }: { data: Bucket[] }) {
  const [active, setActive] = useState<Bucket | null>(null);
  if (data.length === 0) return null;

  const max = Math.max(...data.map((d) => d.count), 1);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const slot = W / data.length;
  const gap = slot > 6 ? 2 : 0;
  const peak = data.reduce((a, b) => (b.count > a.count ? b : a));
  const ticks =
    data.length <= 2
      ? [0, data.length - 1]
      : [0, Math.floor((data.length - 1) / 2), data.length - 1];

  return (
    <div className="timeline">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Responses over time. Busiest: ${bucketLabel(peak.key, true)} with ${peak.count}.`}
      >
        <line
          className="axis"
          x1="0"
          x2={W}
          y1={H - PAD_BOTTOM}
          y2={H - PAD_BOTTOM}
        />
        {data.map((d, i) => {
          const h = d.count === 0 ? 0 : Math.max(2, (d.count / max) * plotH);
          const x = i * slot;
          return (
            <g key={d.key}>
              <rect
                className="hit"
                x={x}
                y={0}
                width={slot}
                height={H - PAD_BOTTOM}
                fill="transparent"
                tabIndex={0}
                aria-label={`${bucketLabel(d.key, true)}: ${d.count} ${d.count === 1 ? "response" : "responses"}`}
                onMouseEnter={() => setActive(d)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(d)}
                onBlur={() => setActive(null)}
              />
              <rect
                className={d === peak && d.count > 0 ? "bar peak" : "bar"}
                x={x + gap / 2}
                y={H - PAD_BOTTOM - h}
                width={Math.max(slot - gap, 1)}
                height={h}
                rx={slot > 8 ? 2 : 0}
                pointerEvents="none"
              />
            </g>
          );
        })}
        {ticks.map((i, n) => (
          <text
            key={i}
            className="tick"
            x={i * slot + slot / 2}
            y={H - 6}
            textAnchor={
              n === 0 && ticks.length > 1
                ? "start"
                : n === ticks.length - 1
                  ? "end"
                  : "middle"
            }
          >
            {bucketLabel(data[i]!.key)}
          </text>
        ))}
      </svg>
      <p className="readout" aria-live="off">
        {active ? (
          <>
            <strong>{bucketLabel(active.key, true)}</strong>:{" "}
            {fmtNum(active.count)}{" "}
            {active.count === 1 ? "response" : "responses"}
          </>
        ) : (
          <>
            Busiest: <strong>{bucketLabel(peak.key, true)}</strong> with{" "}
            {fmtNum(peak.count)}. Hover or tab through the bars for each{" "}
            {peak.key.includes("T") ? "hour" : "day"}.
          </>
        )}
      </p>
    </div>
  );
}

// ---- Horizontal bar list --------------------------------------------------

export interface BarItem {
  key: string;
  label: string;
  count: number;
}

interface BarListProps {
  items: BarItem[];
  /** Percentages are of this total; defaults to the sum of the items. */
  total?: number;
  /** Mark the single leading item, like a highlighted ballot choice. */
  markLeader?: boolean;
  /** Show the count only (no percentage). */
  plain?: boolean;
}

export function BarList({
  items,
  total,
  markLeader = false,
  plain = false,
}: BarListProps) {
  const max = Math.max(...items.map((i) => i.count), 0);
  const base = total ?? items.reduce((s, i) => s + i.count, 0);
  const leaders = items.filter((i) => i.count === max && max > 0);
  const leader = markLeader && leaders.length === 1 ? leaders[0] : undefined;

  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.key} title={`${i.label}: ${i.count}`}>
          <span className="name">{i.label}</span>
          <span className="track" aria-hidden="true">
            <span
              className={i === leader ? "fill mark" : "fill"}
              style={{ width: `${max > 0 ? (i.count / max) * 100 : 0}%` }}
            />
          </span>
          <span className="num">
            {fmtNum(i.count)}
            {!plain && base > 0 && (
              <small> {Math.round((i.count / base) * 100)}%</small>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
