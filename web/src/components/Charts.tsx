import { useId, useMemo, useState, type ReactNode } from 'react';
import { cx } from '../lib/cx';

/**
 * Small SVG charts in the v1 card style (accounts dashboard). Colours: --chart-1 / --chart-2 (validated
 * colour-blind-safe pair, tokens.css). Thin marks, rounded data ends, recessive grid, hover tooltips;
 * every chart also renders a visually-hidden table so the numbers never depend on seeing the chart.
 */

interface HBarDatum {
  key: string;
  label: string;
  value: number;
  /** Shown at the end of the bar, e.g. "₹1,200 · 37%". */
  valueLabel: ReactNode;
}

/** Horizontal bars, one series (magnitude by category) — e.g. revenue by department. Sorted by the caller. */
export function HBarChart({ data, caption, empty = 'No data in this range' }: { data: HBarDatum[]; caption: string; empty?: ReactNode }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <p className="muted">{empty}</p>;
  return (
    <div className="mb-hbars">
      <ul className="mb-hbars__list" aria-hidden="true">
        {data.map((d) => (
          <li key={d.key} className="mb-hbars__row" title={`${d.label}: ${typeof d.valueLabel === 'string' ? d.valueLabel : ''}`}>
            <span className="mb-hbars__label">{d.label}</span>
            <span className="mb-hbars__track">
              <span className="mb-hbars__bar" style={{ width: `${Math.max(1.5, (d.value / max) * 100)}%` }} />
            </span>
            <span className="mb-hbars__value">{d.valueLabel}</span>
          </li>
        ))}
      </ul>
      <table className="sr-only">
        <caption>{caption}</caption>
        <tbody>{data.map((d) => <tr key={d.key}><th scope="row">{d.label}</th><td>{d.valueLabel}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

interface TrendSeries {
  key: string;
  label: string;
  values: number[];
}

interface TrendChartProps {
  /** X labels (one per point), e.g. "14 Nov". */
  labels: string[];
  /** One or two series sharing one y-scale (never a second axis). */
  series: TrendSeries[];
  format: (v: number) => string;
  /** Short axis format, e.g. "₹12k". */
  formatAxis?: (v: number) => string;
  caption: string;
}

const W = 640;
const H = 220;
const PAD = { top: 14, right: 16, bottom: 26, left: 52 };

/** Line chart over days with a crosshair tooltip; legend above (series identity never by colour alone: legend + tooltip + table). */
export function TrendChart({ labels, series, format, formatAxis = format, caption }: TrendChartProps) {
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const max = useMemo(() => niceMax(Math.max(1, ...series.flatMap((s) => s.values))), [series]);
  const x = (i: number) => PAD.left + (n <= 1 ? (W - PAD.left - PAD.right) / 2 : (i * (W - PAD.left - PAD.right)) / (n - 1));
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const every = Math.max(1, Math.ceil(n / 7));

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * (W - PAD.left - PAD.right);
    setHover(n <= 1 ? 0 : Math.min(n - 1, Math.max(0, Math.round((px / (W - PAD.left - PAD.right)) * (n - 1)))));
  };

  return (
    <div className="mb-trend">
      <ul className="mb-legend" aria-label="Legend">
        {series.map((s, i) => (
          <li key={s.key}><span className={cx('mb-legend__swatch', `mb-legend__swatch--${i + 1}`)} aria-hidden="true" />{s.label}</li>
        ))}
      </ul>
      <div className="mb-trend__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={caption}>
          <defs><clipPath id={clipId}><rect x={PAD.left} y={0} width={W - PAD.left - PAD.right + 6} height={H} /></clipPath></defs>
          {ticks.map((t) => (
            <g key={t}>
              <line className="mb-trend__grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="mb-trend__axis" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">{formatAxis(t)}</text>
            </g>
          ))}
          {labels.map((l, i) => (i % every === 0 || i === n - 1) && (
            <text key={l + i} className="mb-trend__axis" x={x(i)} y={H - 6} textAnchor={n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{l}</text>
          ))}
          <g clipPath={`url(#${clipId})`}>
            {series.map((s, si) => (
              <g key={s.key} className={`mb-trend__series mb-trend__series--${si + 1}`}>
                {n > 1 && <polyline points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />}
                {(n <= 14 || hover !== null) && s.values.map((v, i) => (n <= 14 || i === hover) && <circle key={i} cx={x(i)} cy={y(v)} r={i === hover ? 5 : 3.5} />)}
              </g>
            ))}
          </g>
          {hover !== null && <line className="mb-trend__cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} />}
          <rect
            x={PAD.left - 10} y={0} width={W - PAD.left - PAD.right + 20} height={H} fill="transparent"
            onPointerMove={onMove} onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover !== null && (
          <div className="mb-trend__tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
            <strong>{labels[hover]}</strong>
            {series.map((s, i) => (
              <span key={s.key}><span className={cx('mb-legend__swatch', `mb-legend__swatch--${i + 1}`)} aria-hidden="true" />{s.label}<b>{format(s.values[hover] ?? 0)}</b></span>
            ))}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead><tr><th scope="col">Day</th>{series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}</tr></thead>
        <tbody>{labels.map((l, i) => <tr key={l + i}><th scope="row">{l}</th>{series.map((s) => <td key={s.key}>{format(s.values[i] ?? 0)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Rounds a maximum up to 1, 2, 2.5 or 5 × 10ⁿ so gridlines land on round numbers. */
function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = [1, 2, 2.5, 5, 10].find((k) => k * p >= v)!;
  return m * p;
}
