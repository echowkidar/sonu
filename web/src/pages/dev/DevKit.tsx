import * as React from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import { Bell, Smartphone, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Field } from '@/components/ui/form';
import { toast } from '@/components/ui/sonner';
import { DataTable } from '@/components/DataTable';
import { BarStack } from '@/components/BarStack';
import { KpiTile } from '@/components/KpiTile';
import { JobCard } from '@/components/JobCard';
import { BigActionButton } from '@/components/BigActionButton';
import { PhotoPicker, type PickedPhoto } from '@/components/PhotoPicker';
import { DayCounter } from '@/components/DayCounter';
import { StatusBadge } from '@/components/StatusBadge';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FileDrop } from '@/components/FileDrop';
import { Timeline } from '@/components/Timeline';
import { Logo } from '@/components/Logo';
import { useThemeContext } from '@/components/shell/ThemeContext';

interface Row { code: string; zone: string; status: string; day: number; owner: string }
const ZONES = ['North', 'South', 'East', 'West', 'Central'];
const ROWS: Row[] = Array.from({ length: 1200 }, (_, i) => ({
  code: `WR-${String(10000 + i)}`,
  zone: ZONES[i % ZONES.length]!,
  status: ['Open', 'Inspected', 'Estimated', 'Issued'][i % 4]!,
  day: (i * 7) % 20,
  owner: `Supervisor ${(i % 9) + 1}`,
}));
const COLS: ColumnDef<Row>[] = [
  { accessorKey: 'code', header: 'WR code', size: 130 },
  { accessorKey: 'zone', header: 'Zone', size: 110 },
  { accessorKey: 'status', header: 'Status', size: 130 },
  { accessorKey: 'day', header: 'Day', size: 90 },
  { accessorKey: 'owner', header: 'Owner', size: 160 },
];
const BAR = ZONES.map((z, i) => ({ zone: z, open: 12 + i * 3, inspected: 8 + i, issued: 5 + (i % 3) * 4 }));

function KitBody() {
  const [photos, setPhotos] = React.useState<PickedPhoto[]>([]);
  const [files, setFiles] = React.useState<File[]>([]);
  const [confirm, setConfirm] = React.useState(false);
  const [checked, setChecked] = React.useState(true);
  return (
    <TooltipProvider>
      <div className="grid gap-6">
        <Logo />
        <PageHeader title="Page header" description="Short description under the title." actions={<Button size="sm">Action</Button>} />

        <Section title="Buttons">
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button><Button variant="secondary">Secondary</Button><Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button><Button variant="destructive">Delete</Button><Button variant="success">Success</Button>
            <Button size="icon" aria-label="Bell"><Bell className="size-5" /></Button>
          </div>
        </Section>

        <Section title="Form controls">
          <div className="grid gap-3">
            <Field label="Text field" hint="Helper text.">{(p) => <Input {...p} placeholder="Type here" />}</Field>
            <Field label="With error" error="This is required.">{(p) => <Input {...p} />}</Field>
            <Field label="Notes">{(p) => <Textarea {...p} />}</Field>
            <div className="grid gap-1.5">
              <Label>Select</Label>
              <Select defaultValue="a"><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="a">Electrical</SelectItem><SelectItem value="b">Mechanical</SelectItem></SelectContent></Select>
            </div>
            <label className="flex min-h-11 items-center gap-3"><Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} /> Checkbox</label>
            <label className="flex min-h-11 items-center gap-3"><Switch defaultChecked /> Switch</label>
          </div>
        </Section>

        <Section title="Status, badges, day counter">
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="success">Approved</StatusBadge><StatusBadge tone="warning">Waiting</StatusBadge>
            <StatusBadge tone="danger">Returned</StatusBadge><StatusBadge tone="info">Permit open</StatusBadge><StatusBadge>Draft</StatusBadge>
            <Badge>Default</Badge><Badge variant="outline">Outline</Badge>
          </div>
          <div className="mt-3 flex flex-wrap gap-2"><DayCounter day={4} /><DayCounter day={12} /><DayCounter day={14} /><DayCounter day={16} /></div>
        </Section>

        <Section title="Job cards and big actions">
          <div className="grid gap-3">
            <JobCard code="WR-10231" title="Replace faulty ceiling light" location="Building 12 · Room 204" status={{ label: 'Assigned', tone: 'info' }} permit="open" day={4} action="start" />
            <JobCard code="WR-10188" title="AC unit not cooling" location="Building 3 · Plant room" status={{ label: 'In progress', tone: 'warning' }} day={12} action="update" />
            <BigActionButton action="done" />
          </div>
        </Section>

        <Section title="KPI tiles and chart">
          <div className="grid grid-cols-2 gap-3"><KpiTile label="Open" value={128} delta={6} /><KpiTile label="Late" value={9} delta={-2} tone="danger" /></div>
          <div className="mt-3 rounded-xl border bg-card p-3">
            <BarStack data={BAR} xKey="zone" series={[{ key: 'open', label: 'Open' }, { key: 'inspected', label: 'Inspected' }, { key: 'issued', label: 'Issued' }]} />
          </div>
        </Section>

        <Section title="Photo picker">
          <PhotoPicker value={photos} onChange={setPhotos} />
        </Section>

        <Section title="File drop">
          <FileDrop files={files} onFiles={setFiles} accept=".xls,.xlsx" />
        </Section>

        <Section title="Timeline">
          <Timeline items={[
            { id: '1', title: 'Created in Marafiq', at: 'Mon 08:10' },
            { id: '2', title: 'Inspected', at: 'Tue 11:40', note: 'Photos attached' },
            { id: '3', title: 'Estimate sent', state: 'current' },
            { id: '4', title: 'Issued to technician', state: 'upcoming' },
          ]} />
        </Section>

        <Section title="Empty states">
          <div className="grid gap-2 sm:grid-cols-2">
            <EmptyState illustration="done" title="All caught up" description="Nothing needs your action today." />
            <EmptyState illustration="search" title="No matches" description="Try another search." action={<Button variant="outline">Clear filters</Button>} />
          </div>
        </Section>

        <Section title="Overlays">
          <div className="flex flex-wrap gap-2">
            <Dialog><DialogTrigger asChild><Button variant="outline">Dialog</Button></DialogTrigger>
              <DialogContent><DialogHeader><DialogTitle>Dialog title</DialogTitle><DialogDescription>Short explanation.</DialogDescription></DialogHeader></DialogContent></Dialog>
            <Sheet><SheetTrigger asChild><Button variant="outline">Bottom sheet</Button></SheetTrigger>
              <SheetContent side="responsive"><SheetTitle className="text-lg font-semibold">Quick actions</SheetTitle><SheetDescription className="text-sm text-muted-foreground">Bottom sheet on phone, side panel on desktop.</SheetDescription>
                <Button>Take ownership</Button><Button variant="outline">Assign technician</Button></SheetContent></Sheet>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline">Menu</Button></DropdownMenuTrigger>
              <DropdownMenuContent><DropdownMenuItem>One</DropdownMenuItem><DropdownMenuItem>Two</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            <Tooltip><TooltipTrigger asChild><Button variant="outline">Tooltip</Button></TooltipTrigger><TooltipContent>Helpful hint</TooltipContent></Tooltip>
            <Button variant="outline" onClick={() => toast.success('Saved')}>Toast</Button>
            <Button variant="destructive" onClick={() => setConfirm(true)}>Confirm</Button>
          </div>
          <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this item?" description="This cannot be undone." confirmLabel="Delete" destructive onConfirm={() => undefined} />
        </Section>

        <Section title="Cards, tabs, alerts, avatar, skeleton">
          <Card><CardHeader><CardTitle>Card title</CardTitle><CardDescription>Card description</CardDescription></CardHeader><CardContent>Content</CardContent></Card>
          <Tabs defaultValue="a" className="mt-3"><TabsList><TabsTrigger value="a">Open</TabsTrigger><TabsTrigger value="b">Closed</TabsTrigger></TabsList>
            <TabsContent value="a">Open tab</TabsContent><TabsContent value="b">Closed tab</TabsContent></Tabs>
          <div className="mt-3 grid gap-2">
            <Alert variant="info"><AlertTitle>Info</AlertTitle><AlertDescription>Neutral information.</AlertDescription></Alert>
            <Alert variant="warning"><AlertTitle>Warning</AlertTitle></Alert>
            <Alert variant="danger"><AlertTitle>Error</AlertTitle></Alert>
            <Alert variant="success"><AlertTitle>Success</AlertTitle></Alert>
          </div>
          <div className="mt-3 flex items-center gap-3"><Avatar><AvatarFallback>SK</AvatarFallback></Avatar><Skeleton className="h-4 w-40" /></div>
          <Separator className="my-3" />
          <Table><TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Zone</TableHead></TableRow></TableHeader>
            <TableBody><TableRow><TableCell>WR-1</TableCell><TableCell>North</TableCell></TableRow></TableBody></Table>
        </Section>

        <Section title="DataTable (1,200 rows, virtualised)">
          <DataTable columns={COLS} data={ROWS} height={320} pinStart={['code']} columnFilters aria-label="Demo work requests" />
        </Section>
      </div>
    </TooltipProvider>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export default function DevKit() {
  const { dir, setDir } = useThemeContext();
  const [phone, setPhone] = React.useState(false);
  return (
    <div className="mx-auto max-w-[1400px] p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-2xl font-bold">SONU UI kit (dev only)</h1>
        <Button variant="outline" onClick={() => setPhone((p) => !p)}>{phone ? <Monitor /> : <Smartphone />}{phone ? 'Full width' : 'Phone width (360 px)'}</Button>
        <Button variant="outline" onClick={() => setDir(dir === 'rtl' ? 'ltr' : 'rtl')}>{dir === 'rtl' ? 'LTR' : 'RTL'}</Button>
      </div>
      <div className={phone ? 'flex flex-wrap justify-center gap-6' : 'grid gap-6 lg:grid-cols-2'}>
        {(['light', 'dark'] as const).map((t) => (
          <div key={t} className={`${t === 'dark' ? 'dark' : ''} rounded-2xl border bg-background p-4 text-foreground`} style={phone ? { width: 360 } : undefined}>
            <p className="mb-3 text-xs font-semibold uppercase text-muted-foreground">{t} theme</p>
            <KitBody />
          </div>
        ))}
      </div>
    </div>
  );
}
