import * as React from 'react';
import { Link } from 'react-router';
import { BarChart3, Table2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BarStack } from '@/components/BarStack';
import { statusFilterValue, wrListUrl } from '@/lib/ops';
import type { Matrix } from '@/lib/types';

/**
 * Tracker table "status x something" with row and column totals, plus a stacked bar chart (toggle).
 * Every count opens /work-requests with the matching filter in the URL.
 * `dimension` is the filter key of the columns (discipline, zone, facility).
 */
export function StatusMatrix({ title, matrix, dimension, defaultView = 'table', filters = {} }: { filters?: Record<string, string | undefined>; title: string; matrix: Matrix; dimension: 'discipline' | 'zone' | 'facility'; defaultView?: 'table' | 'chart' }) {
  const [view, setView] = React.useState<'table' | 'chart'>(defaultView);
  const rows = matrix.rows.filter((r) => (matrix.rowTotals[r] ?? 0) > 0);
  const cols = matrix.columns;

  const chartData = React.useMemo(
    () => rows.map((r) => ({ status: r, ...Object.fromEntries(cols.map((c) => [c, matrix.cells[r]?.[c] ?? 0])) })),
    [rows, cols, matrix.cells],
  );
  const series = cols.map((c) => ({ key: c, label: c }));

  const link = (status: string | null, col: string | null) => wrListUrl({ ...filters, contractorStatus: status ? statusFilterValue(status) : undefined, ...(col ? { [dimension]: col } : {}) });
  const cell = 'whitespace-nowrap border-b px-3 py-2 text-end tabular-nums';
  const num = (n: number, to: string, label: string) =>
    n > 0 ? <Link to={to} aria-label={label} className="rounded px-1 font-medium text-primary hover:underline">{n.toLocaleString()}</Link> : <span className="text-muted-foreground">0</span>;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <div className="flex gap-1" role="group" aria-label={`${title} view`}>
          <Button size="sm" variant={view === 'table' ? 'default' : 'outline'} aria-pressed={view === 'table'} onClick={() => setView('table')}><Table2 className="size-4" aria-hidden /> Table</Button>
          <Button size="sm" variant={view === 'chart' ? 'default' : 'outline'} aria-pressed={view === 'chart'} onClick={() => setView('chart')}><BarChart3 className="size-4" aria-hidden /> Chart</Button>
        </div>
      </CardHeader>
      <CardContent>
        {matrix.total === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No open work requests.</p>
        ) : view === 'chart' ? (
          <BarStack data={chartData} xKey="status" series={series} horizontal height={Math.max(260, rows.length * 34 + 80)} aria-label={`${title}: stacked bars`} />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-max border-collapse text-sm" aria-label={title}>
              <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="sticky start-0 bg-muted px-3 py-2 text-start">Status</th>
                  {cols.map((c) => <th key={c} scope="col" className="px-3 py-2 text-end">{c}</th>)}
                  <th scope="col" className="px-3 py-2 text-end">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r} className="hover:bg-muted/40">
                    <th scope="row" className="sticky start-0 whitespace-nowrap border-b bg-card px-3 py-2 text-start font-medium">{r}</th>
                    {cols.map((c) => <td key={c} className={cell}>{num(matrix.cells[r]?.[c] ?? 0, link(r, c), `${r}, ${c}`)}</td>)}
                    <td className={`${cell} font-semibold`} data-testid={`row-total-${r}`}>{num(matrix.rowTotals[r] ?? 0, link(r, null), `${r}, all`)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/60 font-semibold">
                <tr>
                  <th scope="row" className="sticky start-0 bg-muted px-3 py-2 text-start">Total</th>
                  {cols.map((c) => <td key={c} className={cell} data-testid={`col-total-${c}`}>{num(matrix.columnTotals[c] ?? 0, link(null, c), `All statuses, ${c}`)}</td>)}
                  <td className={cell} data-testid="grand-total">{num(matrix.total, wrListUrl({ ...filters }), 'All work requests')}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
