import { describe, expect, it } from "vitest";
import { NOT_READ, queuePhotos, readPhotoQueue, type PhotoAttempt } from "./photo-queue";

const photo = (name: string) => new File([name], name, { type: "image/jpeg" });

/** A reader that answers by file name and records what was sent. */
function reader(answers: Record<string, PhotoAttempt>) {
  const sent: string[] = [];
  const read = async (file: File) => {
    sent.push(file.name);
    return answers[file.name] ?? { ok: true };
  };
  return { sent, read };
}

describe("photo queue", () => {
  it("drops photos that were read and keeps failures with their error", async () => {
    const { sent, read } = reader({ "b.jpg": { ok: false, message: "The photo could not be read.", stop: false } });
    const left = await readPhotoQueue(queuePhotos([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]), read);
    expect(sent).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(left.map((p) => [p.file.name, p.error])).toEqual([["b.jpg", "The photo could not be read."]]);
  });

  it("a quota stop keeps the stopped photo and every unattempted one, unsent", async () => {
    const { sent, read } = reader({ "b.jpg": { ok: false, message: "Daily photo limit reached.", stop: true } });
    const left = await readPhotoQueue(queuePhotos([photo("a.jpg"), photo("b.jpg"), photo("c.jpg"), photo("d.jpg")]), read);
    expect(sent).toEqual(["a.jpg", "b.jpg"]);
    expect(left.map((p) => [p.file.name, p.error])).toEqual([
      ["b.jpg", "Daily photo limit reached."],
      ["c.jpg", NOT_READ],
      ["d.jpg", NOT_READ],
    ]);
  });

  it("retry sends only what is still listed, never a photo that already succeeded", async () => {
    const first = reader({ "b.jpg": { ok: false, message: "Try again.", stop: false }, "c.jpg": { ok: false, message: "Try again.", stop: true } });
    const left = await readPhotoQueue(queuePhotos([photo("a.jpg"), photo("b.jpg"), photo("c.jpg"), photo("d.jpg")]), first.read);

    const one = reader({});
    const afterOne = await readPhotoQueue(left, one.read, [left[0].id]);
    expect(one.sent).toEqual(["b.jpg"]);
    expect(afterOne.map((p) => p.file.name)).toEqual(["c.jpg", "d.jpg"]);

    const all = reader({});
    expect(await readPhotoQueue(afterOne, all.read)).toEqual([]);
    expect(all.sent).toEqual(["c.jpg", "d.jpg"]);
  });
});
