import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface DataTableProps<T> {
  columns: ColumnDef<T, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  data: T[];
  /** Visible height of the scroll area in px. */
  height?: number;
  rowHeight?: number;
  getRowId?: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  /** Column ids pinned to the start edge (left in LTR, right in RTL). */
  pinStart?: string[];
  /** Show the global search box. */
  searchable?: boolean;
  /** Show a text filter under every header. */
  columnFilters?: boolean;
  /** Extra toolbar content (saved views, export button ...). */
  toolbar?: React.ReactNode;
  emptyMessage?: string;
  className?: string;
  'aria-label'?: string;
}

/**
 * Virtualised data grid: sorting, global + per-column filtering, pinned columns.
 * Only the visible rows (plus a small overscan) are in the DOM, so 1,200+ rows stay fast.
 * Set `size` on each column def to control its width (default 150).
 */
export function DataTable<T>({
  columns, data, height = 480, rowHeight = 44, getRowId, onRowClick, pinStart = [],
  searchable = true, columnFilters = false, toolbar, emptyMessage = 'Nothing to show.', className, ...rest
}: DataTableProps<T>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [filters, setFilters] = React.useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = React.useState('');

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, columnFilters: filters, globalFilter, columnPinning: { left: pinStart } },
    onSortingChange: setSorting,
    onColumnFiltersChange: setFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    defaultColumn: { size: 150, minSize: 60 },
  });

  const rows = table.getRowModel().rows;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    initialRect: { width: 800, height },
  });
  const items = virtualizer.getVirtualItems();
  const totalWidth = table.getTotalSize();

  const pinStyle = (colId: string, isHeader: boolean): React.CSSProperties => {
    const col = table.getColumn(colId)!;
    if (col.getIsPinned() !== 'left') return {};
    return { position: 'sticky', insetInlineStart: col.getStart('left'), zIndex: isHeader ? 3 : 1 };
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {(searchable || toolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchable && (
            <div className="relative min-w-48 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder="Search…"
                aria-label="Search rows"
                className="ps-9"
              />
            </div>
          )}
          {toolbar}
          <span className="ms-auto text-sm text-muted-foreground" aria-live="polite">
            {rows.length === data.length ? `${data.length.toLocaleString()} rows` : `${rows.length.toLocaleString()} of ${data.length.toLocaleString()} rows`}
          </span>
        </div>
      )}

      <div
        ref={scrollRef}
        style={{ height }}
        className="overflow-auto rounded-xl border bg-card shadow-sm"
        role="table"
        aria-label={rest['aria-label'] ?? 'Data table'}
        aria-rowcount={rows.length}
      >
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          <div role="rowgroup" className="sticky top-0 z-[2] bg-muted">
            {table.getHeaderGroups().map((hg) => (
              <div role="row" key={hg.id} className="flex" style={{ width: totalWidth }}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  const canSort = h.column.getCanSort();
                  return (
                    <div
                      role="columnheader"
                      key={h.id}
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                      style={{ width: h.getSize(), ...pinStyle(h.column.id, true) }}
                      className="shrink-0 border-b bg-muted"
                    >
                      <button
                        type="button"
                        disabled={!canSort}
                        onClick={h.column.getToggleSortingHandler()}
                        className="flex h-11 w-full items-center gap-1 px-3 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground disabled:cursor-default"
                      >
                        <span className="truncate">{flexRender(h.column.columnDef.header, h.getContext())}</span>
                        {canSort && (sorted === 'asc' ? <ArrowUp className="size-3.5" /> : sorted === 'desc' ? <ArrowDown className="size-3.5" /> : <ArrowUpDown className="size-3.5 opacity-40" />)}
                      </button>
                      {columnFilters && h.column.getCanFilter() && (
                        <div className="px-2 pb-2">
                          <Input
                            value={(h.column.getFilterValue() as string) ?? ''}
                            onChange={(e) => h.column.setFilterValue(e.target.value || undefined)}
                            aria-label={`Filter ${String(h.column.columnDef.header ?? h.column.id)}`}
                            className="min-h-9 text-sm"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {rows.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground">{emptyMessage}</div>
          ) : (
            <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map((vi) => {
                const row = rows[vi.index]!;
                return (
                  <div
                    role="row"
                    aria-rowindex={vi.index + 2}
                    key={row.id}
                    data-testid="dt-row"
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={cn('absolute start-0 top-0 flex border-b bg-card hover:bg-muted/60', onRowClick && 'cursor-pointer')}
                    style={{ height: vi.size, transform: `translateY(${vi.start}px)`, width: totalWidth }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <div
                        role="cell"
                        key={cell.id}
                        style={{ width: cell.column.getSize(), ...pinStyle(cell.column.id, false) }}
                        className={cn('flex shrink-0 items-center truncate px-3 text-sm', cell.column.getIsPinned() && 'border-e bg-card')}
                      >
                        <span className="truncate">{flexRender(cell.column.columnDef.cell, cell.getContext())}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
