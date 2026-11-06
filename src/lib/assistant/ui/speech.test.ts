import { describe, expect, it } from "vitest";
import {
  abortSpeech,
  applyFinal,
  applyInterim,
  beginSpeech,
  bindRecognizer,
  commitInterim,
  endSpeech,
  noteCustomerEdit,
  recognitionLanguage,
  speechErrorCopy,
  SPEECH_LIMIT_MESSAGE,
  sealSpeech,
  stopSpeech,
  type BrowserSpeech,
} from "./speech";

describe("assistant speech", () => {
  it("replaces the same index and a longer copy of an earlier final", () => {
    let state = beginSpeech("I want to cook ", 1);
    state = applyFinal(state, 1, 0, "rice");
    state = applyFinal(state, 1, 1, "rice flour");
    expect(state.draft).toBe("I want to cook rice flour");
    state = applyFinal(state, 1, 0, "jollof rice");
    expect(state.draft).toBe("I want to cook jollof rice rice flour");
  });

  it("keeps a final that arrives after stop and drops one after abort or end", () => {
    let stopped = stopSpeech(beginSpeech("", 1));
    stopped = applyFinal(stopped, 1, 0, "plantain");
    expect(stopped.draft).toBe("plantain");
    const aborted = abortSpeech(beginSpeech("yam", 1), 2);
    expect(applyFinal(aborted, 1, 0, "late").draft).toBe("yam");
    const ended = endSpeech(stopSpeech(beginSpeech("", 3)));
    expect(applyFinal(ended, 3, 0, "late").draft).toBe("");
  });

  it("commits the interim once on send and lets the longer final replace that suffix", () => {
    let state = applyInterim(beginSpeech("beans ", 1), 1, 0, "and rice");
    state = commitInterim(state);
    expect(state.draft).toBe("beans and rice");
    expect(state.listening).toBe(false);
    state = applyFinal(state, 1, 0, "and rice flour");
    expect(state.draft).toBe("beans and rice flour");
    expect(state.draft.match(/and rice/g)).toHaveLength(1);
  });

  it("does not send a final twice when Send follows the final", () => {
    let state = applyInterim(beginSpeech("beans ", 1), 1, 0, "and rice");
    state = applyFinal(state, 1, 0, "and rice");
    state = commitInterim(state);
    expect(state.draft).toBe("beans and rice");
    expect(state.interim).toBe("");
  });

  it("does not replace text the customer typed during recognition", () => {
    let state = applyFinal(beginSpeech("I want ", 1), 1, 0, "rice");
    state = noteCustomerEdit(state, "I want rice and beans");
    state = applyFinal(state, 1, 0, "rice flour");
    expect(state.draft).toBe("I want rice and beans");
    state = applyInterim(state, 1, 1, "now");
    state = applyFinal(state, 1, 1, "now");
    expect(state.draft).toBe("I want rice and beans now");
  });

  it("stops at 2000 characters", () => {
    const state = applyFinal(beginSpeech("a".repeat(1990), 1), 1, 0, "b".repeat(20));
    expect(state.draft).toHaveLength(2000);
    expect(state.notice).toBe(SPEECH_LIMIT_MESSAGE);
    expect(state.listening).toBe(false);
  });

  it("replaces the same final after the limit clamp", () => {
    let state = applyFinal(beginSpeech("a".repeat(1990), 1), 1, 0, "b".repeat(20));
    state = applyFinal(state, 1, 0, "c".repeat(20));
    expect(state.draft).toHaveLength(2000);
    expect(state.draft.endsWith("c".repeat(9))).toBe(true);
    expect(state.notice).toBe(SPEECH_LIMIT_MESSAGE);
    expect(state.accepting).toBe(true);
    expect(state.listening).toBe(false);
  });

  it("tells the recognizer to stop when speech reaches the limit", () => {
    const stops: number[] = [];
    const recognizer: BrowserSpeech = {
      lang: "",
      continuous: true,
      interimResults: false,
      start: () => {},
      stop: () => { stops.push(1); },
      abort: () => {},
      onresult: null,
      onerror: null,
      onend: null,
    };
    let state = beginSpeech("a".repeat(1990), 1);
    bindRecognizer(recognizer, {
      lang: "en-US",
      session: 1,
      read: () => state,
      write: (next) => { state = next; },
    });
    recognizer.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "b".repeat(20) } }],
    });
    expect(state.draft).toHaveLength(2000);
    expect(state.notice).toBe(SPEECH_LIMIT_MESSAGE);
    expect(state.listening).toBe(false);
    expect(stops).toHaveLength(1);
    recognizer.onresult?.({
      resultIndex: 1,
      results: [
        { isFinal: true, 0: { transcript: "b".repeat(20) } },
        { isFinal: true, 0: { transcript: "plantain" } },
      ],
    });
    expect(stops).toHaveLength(1);
    expect(state.accepting).toBe(true);
  });

  it("picks the page language, then the browser language, then en-US", () => {
    expect(recognitionLanguage("fr", "en-GB")).toBe("fr");
    expect(recognitionLanguage("  ", "en-GB")).toBe("en-GB");
    expect(recognitionLanguage("", "")).toBe("en-US");
    expect(speechErrorCopy("aborted")).toBeNull();
    expect(speechErrorCopy("not-allowed")).toBeTruthy();
  });

  it("retries an unsupported language once in en-US", () => {
    const starts: string[] = [];
    const recognizer: BrowserSpeech = {
      lang: "",
      continuous: true,
      interimResults: false,
      start: () => { starts.push(recognizer.lang); },
      stop: () => {},
      abort: () => {},
      onresult: null,
      onerror: null,
      onend: null,
    };
    let state = beginSpeech("", 1);
    bindRecognizer(recognizer, {
      lang: "yo",
      session: 1,
      read: () => state,
      write: (next) => { state = next; },
    });
    recognizer.onerror?.({ error: "language-not-supported" });
    expect(starts).toEqual(["yo", "en-US"]);
    recognizer.onerror?.({ error: "language-not-supported" });
    expect(state.listening).toBe(false);
  });

  it("ignores an error from a recognizer after a newer session has started", () => {
    const starts: string[] = [];
    const recognizer: BrowserSpeech = {
      lang: "",
      continuous: true,
      interimResults: false,
      start: () => { starts.push(recognizer.lang); },
      stop: () => {},
      abort: () => {},
      onresult: null,
      onerror: null,
      onend: null,
    };
    let state = beginSpeech("beans", 1);
    bindRecognizer(recognizer, {
      lang: "yo",
      session: 1,
      read: () => state,
      write: (next) => { state = next; },
    });
    state = beginSpeech("beans", 2);
    recognizer.onerror?.({ error: "aborted" });
    expect(state.session).toBe(2);
    expect(state.listening).toBe(true);
    expect(state.draft).toBe("beans");
    expect(state.notice).toBeNull();
    recognizer.onerror?.({ error: "language-not-supported" });
    expect(starts).toEqual(["yo"]);
    expect(state.listening).toBe(true);
  });

  it("replaces a repeated final instead of appending it", () => {
    const rows = [
      { prefix: "rice ", finals: ["and beans", "and beans please"], draft: "rice and beans please" },
      { prefix: "", finals: ["and beans", "and beans"], draft: "and beans" },
      { prefix: "", finals: ["and", "and beans", "and beans please"], draft: "and beans please" },
      { prefix: "", finals: ["rice", "beans"], draft: "rice beans" },
      { prefix: "", finals: ["rice", "ricer"], draft: "rice ricer" },
    ];
    for (const row of rows) {
      let state = beginSpeech(row.prefix, 1);
      row.finals.forEach((text, index) => {
        state = applyFinal(state, 1, index, text);
      });
      expect(state.draft).toBe(row.draft);
    }
  });

  it("does not write the draft after a send ends acceptance", () => {
    const writes: string[] = [];
    let state = beginSpeech("", 1);
    const recognizer: BrowserSpeech = {
      lang: "",
      continuous: true,
      interimResults: false,
      start: () => {},
      stop: () => {},
      abort: () => {},
      onresult: null,
      onerror: null,
      onend: null,
    };
    bindRecognizer(recognizer, {
      lang: "en-US",
      session: 1,
      read: () => state,
      write: (next) => {
        state = next;
        writes.push(next.draft);
      },
    });
    recognizer.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "beans" } }],
    });
    const written = writes.length;
    state = sealSpeech(state);
    recognizer.onend?.();
    recognizer.onresult?.({
      resultIndex: 1,
      results: [
        { isFinal: true, 0: { transcript: "beans" } },
        { isFinal: true, 0: { transcript: "beans please" } },
      ],
    });
    expect(writes).toHaveLength(written);
    expect(state.accepting).toBe(false);
    expect(state.draft).toBe("beans");
  });
});
