import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import { DayCounter, dayState } from '@/components/DayCounter';
import { DataTable } from '@/components/DataTable';

describe('DayCounter', () => {
  it('computes states', () => {
    expect(dayState(4)).toBe('ok');
    expect(dayState(9)).toBe('ok');
    expect(dayState(10)).toBe('warn');
    expect(dayState(13)).toBe('warn');
    expect(dayState(14)).toBe('late');
    expect(dayState(17)).toBe('late');
  });

  it('always shows text, not just colour', () => {
    const { rerender } = render(<DayCounter day={4} />);
    expect(screen.getByText('Day 4 of 14')).toBeInTheDocument();
    expect(screen.getByText(/On track/)).toBeInTheDocument();
    rerender(<DayCounter day={12} />);
    expect(screen.getByText(/Due soon/)).toBeInTheDocument();
    rerender(<DayCounter day={16} />);
    expect(screen.getByText(/overdue by 2/)).toBeInTheDocument();
    expect(document.querySelector('[data-state="late"]')).not.toBeNull();
  });
});

interface Row { id: number; name: string }

describe('DataTable', () => {
  it('virtualises 2,000 rows', () => {
    const data: Row[] = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `Row ${i}` }));
    const columns: ColumnDef<Row>[] = [
      { accessorKey: 'id', header: 'Id' },
      { accessorKey: 'name', header: 'Name' },
    ];
    render(<DataTable columns={columns} data={data} height={440} />);
    const rendered = screen.getAllByTestId('dt-row').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
    expect(screen.getByText('2,000 rows')).toBeInTheDocument();
    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.queryByText('Row 1999')).toBeNull();
  });
});
