import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface BarSeries { key: string; label: string; color?: string }

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

/**
 * Stacked bars (status by zone, ageing buckets ...). Colours come from the theme tokens so dark mode works.
 * Every segment is also readable in the tooltip and legend by name (colour is not the only cue).
 */
export function BarStack({
  data, xKey, series, height = 260, horizontal = false, 'aria-label': ariaLabel,
}: { data: Record<string, string | number>[]; xKey: string; series: BarSeries[]; height?: number; horizontal?: boolean; 'aria-label'?: string }) {
  return (
    <div style={{ height }} role="img" aria-label={ariaLabel ?? 'Stacked bar chart'}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} stroke="var(--border)" />
              <YAxis type="category" dataKey={xKey} width={90} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} stroke="var(--border)" />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} stroke="var(--border)" />
              <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} stroke="var(--border)" allowDecimals={false} />
            </>
          )}
          <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--popover-foreground)' }} cursor={{ fill: 'var(--muted)' }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color ?? PALETTE[i % PALETTE.length]} isAnimationActive animationDuration={200} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
