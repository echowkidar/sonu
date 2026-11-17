import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BigActionButton } from '@/components/BigActionButton';
import { PhotoPicker, type PickedPhoto } from '@/components/PhotoPicker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FormError, FormSheet } from '@/components/admin/kit';
import { api, apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import type { JobStatus } from '@/lib/types';

/** Which big buttons a job shows: assigned -> Start; started -> Update and Done; done -> none. */
export function actionsFor(status: JobStatus): ('start' | 'update' | 'done')[] {
  return status === 'assigned' ? ['start'] : status === 'started' ? ['update', 'done'] : [];
}

function useRefreshJobs() {
  const qc = useQueryClient();
  return () => { for (const k of ['my-jobs', 'team-jobs', 'job']) void qc.invalidateQueries({ queryKey: [k] }); };
}

function buildForm(note: string, photos: PickedPhoto[]): FormData {
  const f = new FormData();
  if (note.trim()) f.append('note', note.trim());
  for (const p of photos) f.append('photos', p.file, p.file.name);
  return f;
}

/** Note + photos bottom sheet used by Update and Done. */
function NoteSheet({
  open, onOpenChange, title, description, submitLabel, requireContent, onSubmit,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; submitLabel: string; requireContent: boolean;
  onSubmit: (note: string, photos: PickedPhoto[]) => Promise<unknown>;
}) {
  const [note, setNote] = React.useState('');
  const [photos, setPhotos] = React.useState<PickedPhoto[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const empty = !note.trim() && photos.length === 0;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(note, photos);
      setNote(''); setPhotos([]);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="job-note" className="text-base">Note {requireContent ? '' : '(optional)'}</Label>
          <Textarea id="job-note" rows={4} className="text-base" value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
        </div>
        <PhotoPicker value={photos} onChange={setPhotos} max={6} />
        <FormError message={error} />
        <Button size="lg" className="h-14 text-lg" disabled={busy || (requireContent && empty)} onClick={() => void submit()}>{submitLabel}</Button>
      </div>
    </FormSheet>
  );
}

/** The one-thumb buttons of a job. Hidden when the user cannot act. */
export function JobActions({ jobId, status, canAct = true }: { jobId: string; status: JobStatus; canAct?: boolean }) {
  const refresh = useRefreshJobs();
  const [sheet, setSheet] = React.useState<'update' | 'done' | null>(null);
  const start = useMutation({
    mutationFn: () => apiPost(OPS.jobStart(jobId)),
    onSuccess: () => { toast.success('Job started.'); refresh(); },
    onError: (e) => { toast.error(errorMessage(e)); refresh(); },
  });
  if (!canAct) return null;
  const acts = actionsFor(status);
  if (acts.length === 0) return null;

  const send = async (path: string, note: string, photos: PickedPhoto[], okText: string) => {
    if (photos.length) await api(path, { method: 'POST', form: buildForm(note, photos) });
    else await apiPost(path, note.trim() ? { note: note.trim() } : {});
    toast.success(okText);
    refresh();
  };

  return (
    <>
      {acts.includes('start') && <BigActionButton action="start" loading={start.isPending} onClick={() => start.mutate()} />}
      {acts.includes('update') && <BigActionButton action="update" onClick={() => setSheet('update')} />}
      {acts.includes('done') && <BigActionButton action="done" onClick={() => setSheet('done')} />}
      <NoteSheet
        open={sheet === 'update'} onOpenChange={(o) => setSheet(o ? 'update' : null)} title="Update" description="Add a note or photos for the supervisor." submitLabel="Send update" requireContent
        onSubmit={(n, p) => send(OPS.jobUpdates(jobId), n, p, 'Update sent.')}
      />
      <NoteSheet
        open={sheet === 'done'} onOpenChange={(o) => setSheet(o ? 'done' : null)} title="Mark this job as done?" description="The supervisor is told. You can add a last note or photo." submitLabel="Yes, it is done" requireContent={false}
        onSubmit={(n, p) => send(OPS.jobDone(jobId), n, p, 'Job done. Well done.')}
      />
    </>
  );
}
