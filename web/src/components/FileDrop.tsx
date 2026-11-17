import * as React from 'react';
import { FileSpreadsheet, UploadCloud, X } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';

/** Drag-and-drop or click. Shows chosen file name and size. Parent owns the file list. */
export function FileDrop({
  files, onFiles, accept, multiple = false, label = 'Drop a file here, or click to choose',
}: { files: File[]; onFiles: (f: File[]) => void; accept?: string; multiple?: boolean; label?: string }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);

  const take = (list: FileList | null) => {
    if (!list?.length) return;
    const arr = Array.from(list);
    onFiles(multiple ? [...files, ...arr] : [arr[0]!]);
  };

  return (
    <div className="grid gap-2">
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
        className={cn(
          'flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-card px-4 text-center transition-colors',
          over ? 'border-primary bg-primary-soft' : 'border-input hover:bg-muted/50',
        )}
      >
        <UploadCloud className="size-8 text-primary" aria-hidden />
        <p className="text-sm font-medium">{label}</p>
        {accept && <p className="text-xs text-muted-foreground">{accept}</p>}
      </div>
      <input ref={inputRef} type="file" hidden accept={accept} multiple={multiple} onChange={(e) => { take(e.target.files); e.target.value = ''; }} data-testid="filedrop-input" />
      {files.length > 0 && (
        <ul className="grid gap-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex min-h-11 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
              <FileSpreadsheet className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-muted-foreground">{formatBytes(f.size)}</span>
              <button type="button" aria-label={`Remove ${f.name}`} className="tap inline-flex items-center justify-center" onClick={() => onFiles(files.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
