/** A picked shelf photo still waiting to be read: never sent, or sent and refused. */
export interface QueuedPhoto {
  id: string;
  file: File;
  error: string | null;
}

/** `stop`: the store is out of reads for now (quota or copilot resting), so later photos are not sent. */
export type PhotoAttempt = { ok: true } | { ok: false; message: string; stop: boolean };

export const NOT_READ = "Not read yet: reading stopped before this photo.";

let nextId = 0;

export function queuePhotos(files: File[]): QueuedPhoto[] {
  return files.map((file) => ({ id: `photo-${++nextId}`, file, error: null }));
}

/**
 * Sends the queued photos (or only `ids`) one at a time and returns the queue that is left:
 * a photo that was read leaves it, so no retry can send it again.
 */
export async function readPhotoQueue(
  queue: QueuedPhoto[],
  read: (file: File, index: number, count: number) => Promise<PhotoAttempt>,
  ids?: string[],
): Promise<QueuedPhoto[]> {
  const sending = queue.filter((photo) => !ids || ids.includes(photo.id));
  const outcome = new Map<string, string | null>();
  let stopped = false;
  for (const [index, photo] of sending.entries()) {
    if (stopped) {
      outcome.set(photo.id, NOT_READ);
      continue;
    }
    const attempt = await read(photo.file, index, sending.length);
    if (attempt.ok) {
      outcome.set(photo.id, null);
    } else {
      outcome.set(photo.id, attempt.message);
      stopped = attempt.stop;
    }
  }
  return queue.flatMap((photo) => {
    if (!outcome.has(photo.id)) return [photo];
    const error = outcome.get(photo.id);
    return error ? [{ ...photo, error }] : [];
  });
}
