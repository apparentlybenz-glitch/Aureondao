// A plain SVG polyline. Points are spaced evenly unless xs (one per value, any
// increasing scale such as times) is given. A flat series draws a middle line.
export function Sparkline({
  values,
  xs,
  width = 48,
  height = 20,
  className,
  svgClassName = "h-5 w-12 shrink-0",
}: {
  values: number[];
  xs?: number[];
  width?: number;
  height?: number;
  className: string;
  svgClassName?: string;
}) {
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const x0 = xs ? xs[0] : 0;
  const xSpan = xs ? xs[xs.length - 1] - x0 : values.length - 1;
  const points = values
    .map((v, i) => {
      const x = xSpan === 0 ? 0 : (((xs ? xs[i] : i) - x0) / xSpan) * width;
      const y = span === 0 ? height / 2 : height - 1 - ((v - min) / span) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" className={svgClassName}>
      <polyline
        points={points}
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className={className}
      />
    </svg>
  );
}
