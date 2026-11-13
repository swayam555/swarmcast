// Hand-drawn SVG/canvas visuals: throughput area chart, piece map, sparkline.
import { useEffect, useMemo, useRef, useState } from 'react';
import { rate, type Sample } from '../lib/api';

export function Throughput({ samples, height = 180 }: { samples: Sample[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, e.contentRect.width)));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const pad = { l: 72, r: 12, t: 12, b: 22 };
  const data = samples.length ? samples : [{ timestamp: Date.now(), downloadSpeed: 0, uploadSpeed: 0 }];
  const max = Math.max(1024, ...data.map((s) => Math.max(s.downloadSpeed, s.uploadSpeed))) * 1.15;
  const iw = w - pad.l - pad.r; const ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (data.length < 2 ? iw : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = (k: 'downloadSpeed' | 'uploadSpeed') => data.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[k]).toFixed(1)}`).join('');
  const area = (k: 'downloadSpeed' | 'uploadSpeed') => `${line(k)}L${x(data.length - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z`;
  const ticks = [0, 0.5, 1].map((f) => f * max / 1.15);
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="chart" ref={ref}>
      <svg width={w} height={height} role="img" aria-label="Fleet throughput over the last two minutes"
        onMouseMove={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const i = Math.round(((e.clientX - r.left - pad.l) / iw) * (data.length - 1)); setHover(i >= 0 && i < data.length ? i : null); }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="axis">{rate(t)}</text>
          </g>
        ))}
        <path d={area('downloadSpeed')} className="area-down" />
        <path d={line('downloadSpeed')} className="line-down" />
        <path d={area('uploadSpeed')} className="area-up" />
        <path d={line('uploadSpeed')} className="line-up" />
        <text x={pad.l} y={height - 4} className="axis">−{Math.max(0, Math.round((data[data.length - 1].timestamp - data[0].timestamp) / 1000))}s</text>
        <text x={w - pad.r} y={height - 4} textAnchor="end" className="axis">now</text>
        {h && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="cursor" />
            <circle cx={x(hover)} cy={y(h.downloadSpeed)} r={3.5} className="dot-down" />
            <circle cx={x(hover)} cy={y(h.uploadSpeed)} r={3.5} className="dot-up" />
          </g>
        )}
      </svg>
      <div className="legend">
        <span><i className="sw-down" />Down {rate(h ? h.downloadSpeed : data[data.length - 1].downloadSpeed)}</span>
        <span><i className="sw-up" />Up {rate(h ? h.uploadSpeed : data[data.length - 1].uploadSpeed)}</span>
      </div>
    </div>
  );
}

/** One cell per piece: 0 missing, 1 in flight, 2 verified. Canvas so 50k pieces stay cheap. */
export function PieceMap({ map }: { map: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const counts = useMemo(() => map.reduce((c, v) => { c[v]++; return c; }, [0, 0, 0]), [map]);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const width = c.parentElement?.clientWidth || 600;
    const n = Math.max(1, map.length);
    const cell = n > 4000 ? 3 : n > 1200 ? 5 : n > 300 ? 8 : 12;
    const gap = cell > 5 ? 2 : 1;
    const cols = Math.max(1, Math.floor(width / (cell + gap)));
    const rows = Math.ceil(n / cols);
    const dpr = window.devicePixelRatio || 1;
    c.width = cols * (cell + gap) * dpr; c.height = rows * (cell + gap) * dpr;
    c.style.width = `${cols * (cell + gap)}px`; c.style.height = `${rows * (cell + gap)}px`;
    const g = c.getContext('2d')!; g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const colors = [css.getPropertyValue('--piece-missing'), css.getPropertyValue('--piece-active'), css.getPropertyValue('--piece-done')];
    map.forEach((v, i) => { g.fillStyle = colors[v] || colors[0]; g.fillRect((i % cols) * (cell + gap), Math.floor(i / cols) * (cell + gap), cell, cell); });
  }, [map]);
  if (!map.length) return <p className="muted small">Piece map appears once a worker has the metadata.</p>;
  return (
    <div>
      <div className="piecemap"><canvas ref={ref} /></div>
      <div className="legend small">
        <span><i className="sw-done" />{counts[2]} verified</span>
        <span><i className="sw-active" />{counts[1]} in flight</span>
        <span><i className="sw-missing" />{counts[0]} missing</span>
      </div>
    </div>
  );
}

export function Spark({ values, w = 90, h = 26 }: { values: number[]; w?: number; h?: number }) {
  if (values.length < 2) return <svg width={w} height={h} />;
  const max = Math.max(1, ...values);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join('');
  return <svg width={w} height={h} className="spark" aria-hidden="true"><path d={d} /></svg>;
}
