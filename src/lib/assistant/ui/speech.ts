const LIMIT = 2000;

export const SPEECH_LIMIT_MESSAGE = "That's the 2000-character limit.";

const ERROR_COPY: Record<string, string> = {
  "not-allowed": "Microphone access is off. You can type instead.",
  "service-not-allowed": "Microphone access is off. You can type instead.",
  "no-speech": "I didn't hear anything. Tap the mic to try again.",
  network: "Voice needs a connection. You can type instead.",
  "audio-capture": "No microphone found.",
};

export function speechErrorCopy(code: string): string | null {
  if (code === "aborted") return null;
  return ERROR_COPY[code] ?? null;
}

export function recognitionLanguage(pageLang: string, navigatorLanguage: string): string {
  const page = pageLang.trim();
  if (page) return page;
  const navigator = navigatorLanguage.trim();
  return navigator || "en-US";
}

export type SpeechState = {
  session: number;
  listening: boolean;
  accepting: boolean;
  prefix: string;
  finals: ReadonlyMap<number, string>;
  settled: ReadonlySet<number>;
  interim: string;
  interimIndex: number;
  committed: ReadonlyMap<number, string>;
  draft: string;
  notice: string | null;
};

function cloneMap(source: ReadonlyMap<number, string>): Map<number, string> {
  return new Map(source);
}

function normalizeSpoken(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A later Android final often repeats the earlier phrase and then continues it. */
function repeatsKept(previous: string, next: string): boolean {
  if (next === previous) return true;
  if (!next.startsWith(previous)) return false;
  const boundary = next.charAt(previous.length);
  return boundary === "" || /[^\p{L}\p{N}]/u.test(boundary);
}

function spokenFrom(finals: ReadonlyMap<number, string>): string {
  const kept: string[] = [];
  const ordered = [...finals.entries()].sort((left, right) => left[0] - right[0]);
  for (const [, text] of ordered) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const previous = kept.length > 0 ? normalizeSpoken(kept[kept.length - 1] ?? "") : null;
    if (previous != null && repeatsKept(previous, normalizeSpoken(trimmed))) {
      kept[kept.length - 1] = trimmed;
      continue;
    }
    kept.push(trimmed);
  }
  return kept.join(" ");
}

function compose(prefix: string, spoken: string): string {
  if (!spoken) return prefix;
  if (!prefix.trim()) return spoken;
  return `${prefix.trimEnd()} ${spoken}`;
}

function clamp(text: string): { text: string; limited: boolean } {
  if (text.length <= LIMIT) return { text, limited: false };
  return { text: text.slice(0, LIMIT), limited: true };
}

function paint(state: SpeechState, finals: ReadonlyMap<number, string>, prefix = state.prefix): SpeechState {
  const composed = compose(prefix, spokenFrom(finals));
  const limited = clamp(composed);
  return {
    ...state,
    prefix,
    finals,
    draft: limited.text,
    listening: limited.limited ? false : state.listening,
    notice: limited.limited ? SPEECH_LIMIT_MESSAGE : state.notice,
  };
}

export function beginSpeech(prefix: string, session: number): SpeechState {
  return {
    session,
    listening: true,
    accepting: true,
    prefix,
    finals: new Map(),
    settled: new Set(),
    interim: "",
    interimIndex: 0,
    committed: new Map(),
    draft: prefix,
    notice: null,
  };
}

export function applyFinal(state: SpeechState, session: number, index: number, transcript: string): SpeechState {
  if (session !== state.session || !state.accepting) return state;
  const text = transcript.trim();
  if (!text) return state;
  const previous = state.finals.get(index);
  if (previous != null) {
    const composed = compose(state.prefix, spokenFrom(state.finals));
    const limited = clamp(composed);
    const clampedOnly = state.notice === SPEECH_LIMIT_MESSAGE && state.draft === limited.text;
    if (state.draft !== composed && !clampedOnly) return clearInterimFor(state, index);
    const finals = cloneMap(state.finals);
    finals.set(index, text);
    return paint(clearInterimFor(state, index), finals);
  }
  const committed = state.committed.get(index);
  if (committed) {
    const committedNext = cloneMap(state.committed);
    committedNext.delete(index);
    if (state.draft.endsWith(committed) && text.startsWith(committed)) {
      const prefix = state.draft.slice(0, -committed.length);
      const finals = cloneMap(state.finals);
      finals.set(index, text);
      return paint(clearInterimFor({ ...state, committed: committedNext }, index), finals, prefix);
    }
    return clearInterimFor({ ...state, committed: committedNext }, index);
  }
  if (state.settled.has(index)) return clearInterimFor(state, index);
  const finals = cloneMap(state.finals);
  finals.set(index, text);
  return paint(clearInterimFor(state, index), finals);
}

function clearInterimFor(state: SpeechState, index: number): SpeechState {
  if (state.interimIndex !== index) return state;
  return { ...state, interim: "" };
}

export function applyInterim(state: SpeechState, session: number, index: number, transcript: string): SpeechState {
  if (session !== state.session || !state.listening) return state;
  return { ...state, interim: transcript, interimIndex: index };
}

export function commitInterim(state: SpeechState): SpeechState {
  const text = state.interim.trim();
  const cleared = { ...state, listening: false, interim: "" };
  if (!text) return cleared;
  const committed = cloneMap(state.committed);
  committed.set(state.interimIndex, text);
  const limited = clamp(compose(state.draft, text));
  return {
    ...cleared,
    committed,
    draft: limited.text,
    notice: limited.limited ? SPEECH_LIMIT_MESSAGE : state.notice,
  };
}

export function noteCustomerEdit(state: SpeechState, nextDraft: string): SpeechState {
  if (nextDraft === state.draft) return state;
  const settled = new Set(state.settled);
  for (const index of state.finals.keys()) settled.add(index);
  for (const index of state.committed.keys()) settled.add(index);
  return {
    ...state,
    prefix: nextDraft,
    finals: new Map(),
    committed: new Map(),
    settled,
    draft: nextDraft,
    interim: state.listening ? state.interim : "",
  };
}

export function abortSpeech(state: SpeechState, nextSession: number): SpeechState {
  return { ...state, session: nextSession, listening: false, accepting: false, interim: "" };
}

export function stopSpeech(state: SpeechState): SpeechState {
  return { ...state, listening: false };
}

/** A real send has taken this draft. Later events from its recognizer must not write it back. */
export function sealSpeech(state: SpeechState): SpeechState {
  return { ...state, session: state.session + 1, listening: false, accepting: false, interim: "" };
}

export function endSpeech(state: SpeechState): SpeechState {
  return { ...state, listening: false, accepting: false, interim: "" };
}

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }>;
};

export type BrowserSpeech = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export function bindRecognizer(
  recognizer: BrowserSpeech,
  input: { lang: string; session: number; read: () => SpeechState; write: (state: SpeechState) => void },
): void {
  let retried = false;
  let stoppedForLimit = false;
  recognizer.lang = input.lang;
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.onresult = (event) => {
    let state = input.read();
    if (state.session !== input.session || !state.accepting) return;
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript ?? "";
      state = result?.isFinal
        ? applyFinal(state, input.session, index, transcript)
        : applyInterim(state, input.session, index, transcript);
    }
    input.write(state);
    if (!stoppedForLimit && state.notice === SPEECH_LIMIT_MESSAGE) {
      stoppedForLimit = true;
      recognizer.stop();
    }
  };
  recognizer.onerror = (event) => {
    const current = input.read();
    if (current.session !== input.session) return;
    if (event.error === "language-not-supported" && !retried && recognizer.lang !== "en-US") {
      retried = true;
      recognizer.lang = "en-US";
      recognizer.start();
      return;
    }
    const copy = speechErrorCopy(event.error);
    input.write({ ...current, listening: false, notice: copy ?? current.notice });
  };
  recognizer.onend = () => {
    const current = input.read();
    if (current.session !== input.session || !current.accepting) return;
    input.write(endSpeech(current));
  };
  recognizer.start();
}
