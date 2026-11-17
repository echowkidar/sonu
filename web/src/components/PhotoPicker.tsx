import * as React from 'react';
import { Camera, ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { compressImage } from '@/lib/image';
import { formatBytes } from '@/lib/utils';

export interface PickedPhoto { id: string; file: File; url: string }

/**
 * Camera-first photo picker. `capture="environment"` opens the rear camera on phones.
 * Each photo is compressed client-side to max 1600 px JPEG before it reaches `onChange`.
 */
export function PhotoPicker({
  value, onChange, max = 8, label = 'Take photo',
}: { value: PickedPhoto[]; onChange: (photos: PickedPhoto[]) => void; max?: number; label?: string }) {
  const camRef = React.useRef<HTMLInputElement>(null);
  const galRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const next = [...value];
      for (const f of Array.from(files)) {
        if (next.length >= max) break;
        const file = await compressImage(f);
        next.push({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) });
      }
      onChange(next);
    } catch {
      setError('Could not read that photo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function remove(id: string) {
    const p = value.find((x) => x.id === id);
    if (p) URL.revokeObjectURL(p.url);
    onChange(value.filter((x) => x.id !== id));
  }

  return (
    <div className="grid gap-3">
      <div className="flex gap-2">
        <Button size="lg" className="h-14 flex-1 text-base" disabled={busy || value.length >= max} onClick={() => camRef.current?.click()}>
          <Camera className="size-6" aria-hidden /> {label}
        </Button>
        <Button size="lg" variant="outline" className="h-14" aria-label="Choose from gallery" disabled={busy || value.length >= max} onClick={() => galRef.current?.click()}>
          <ImagePlus className="size-6" aria-hidden />
        </Button>
      </div>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void add(e.target.files); e.target.value = ''; }} data-testid="photo-camera" />
      <input ref={galRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {value.length > 0 && (
        <ul className="grid grid-cols-3 gap-2" aria-label="Selected photos">
          {value.map((p) => (
            <li key={p.id} className="relative overflow-hidden rounded-lg border bg-muted">
              <img src={p.url} alt="Selected photo preview" className="aspect-square w-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1.5 py-0.5 text-[11px] text-white">{formatBytes(p.file.size)}</span>
              <button type="button" onClick={() => remove(p.id)} aria-label="Remove photo" className="absolute end-1 top-1 inline-flex size-9 items-center justify-center rounded-full bg-black/60 text-white">
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{value.length} of {max} photos</p>
    </div>
  );
}
