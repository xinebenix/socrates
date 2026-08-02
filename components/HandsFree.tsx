'use client';

/**
 * Hands-free mode: the session as a spoken loop.
 *
 * Reads each question and its options aloud (ByteDance TTS via /api/tts), listens for
 * the answer, asks for confidence *before* submitting — invariant 1 holds on the road
 * too — then reads the verdict and the rationale and moves on. Built so a driver never
 * has to look at or touch the screen mid-session.
 *
 * The division of labour: everything decidable without a browser lives in
 * lib/handsfree (what to say, what an utterance means); this component owns only the
 * machinery — an audio queue with prefetch, a speech recognizer that is stopped while
 * audio plays so the engine does not hear itself, and the phase it is listening in.
 *
 * It drives the same callbacks the buttons do and mutates nothing itself, so every
 * invariant enforced in SessionRunner and on the server applies unchanged: it cannot
 * submit without confidence, cannot change an answer after feedback, and "I don't
 * know" is honoured only once the countdown has run out — early, the reply is spoken
 * rather than obeyed.
 *
 * Degradation: without TTS credentials the toggle never renders (the page does not
 * pass ttsEnabled). With TTS but no SpeechRecognition in the browser, it still reads
 * everything aloud and the driver answers by tapping — stated on screen, not guessed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Confidence } from '@/lib/mastery/bkt';
import { useDict, useLocale } from '@/components/I18nProvider';
import { fill } from '@/lib/i18n/dict';
import {
  answerPrompt,
  confidencePrompt,
  feedbackScript,
  itemScript,
  type SpokenFeedback,
} from '@/lib/handsfree/script';
import { parseCommand, type ListenPhase } from '@/lib/handsfree/commands';

/** How long the post-feedback ear stays open before moving on by itself. */
const AUTO_ADVANCE_MS = 5000;

export interface HandsFreeItem {
  itemId: number;
  kind: 'mc' | 'free';
  stem: string;
  position: number;
  total: number;
  options: { id: number; text: string }[];
}

export interface HandsFreeProps {
  item: HandsFreeItem | null;
  feedback: SpokenFeedback | null;
  selectedOptionId: number | null;
  confidence: Confidence | null;
  freeText: string;
  submitting: boolean;
  canGiveUp: boolean;
  done: boolean;
  onSelectOption: (id: number) => void;
  onConfidence: (c: Confidence) => void;
  onSubmit: () => void;
  onDontKnow: () => void;
  onFreeText: (v: string) => void;
  onNext: () => void;
}

/* The Web Speech API is not in TypeScript's DOM lib; the slice used here is small. */
interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  abort: () => void;
}

function recognitionCtor(): (new () => RecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * A tenth of a second of silence, built by hand. Played inside the toggle's click
 * handler to spend the user gesture that mobile browsers require before an element
 * may play audio — every later play() is programmatic and needs the unlock.
 */
function silentWavUrl(): string {
  const rate = 8000;
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

type Status = 'speaking' | 'listening' | 'working' | 'paused' | null;

export function HandsFree(props: HandsFreeProps) {
  const t = useDict();
  const locale = useLocale();

  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [micSupported, setMicSupported] = useState<boolean | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);

  /** Latest props and dict for async handlers, without re-binding them per render. */
  const latest = useRef({ props, t, locale });
  latest.current = { props, t, locale };

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playDone = useRef<(() => void) | null>(null);
  const speakToken = useRef(0);
  const recRef = useRef<RecognitionLike | null>(null);
  const listeningFor = useRef<ListenPhase | null>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Which item has been read out, and which item's feedback; guards double reads. */
  const spokenItem = useRef<number | null>(null);
  const spokenFeedback = useRef<number | null>(null);
  const submittedFor = useRef<number | null>(null);
  const spokenDone = useRef(false);

  const clearAdvanceTimer = useCallback(() => {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }, []);

  const stopRecognition = useCallback(() => {
    listeningFor.current = null;
    try {
      recRef.current?.abort();
    } catch {
      /* already stopped */
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    speakToken.current++;
    audioRef.current?.pause();
    playDone.current?.();
  }, []);

  const fetchSpeech = useCallback(async (text: string): Promise<Blob> => {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, locale: latest.current.locale }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `TTS answered ${res.status}`);
    }
    return await res.blob();
  }, []);

  const playBlob = useCallback((blob: Blob): Promise<void> => {
    return new Promise((resolve) => {
      const audio = audioRef.current;
      if (!audio) return resolve();
      const url = URL.createObjectURL(blob);
      const finish = () => {
        URL.revokeObjectURL(url);
        audio.onended = null;
        audio.onerror = null;
        playDone.current = null;
        resolve();
      };
      playDone.current = finish;
      audio.onended = finish;
      audio.onerror = finish;
      audio.src = url;
      void audio.play().catch(finish);
    });
  }, []);

  /**
   * Speak chunks in order, fetching chunk n+1 while chunk n plays, so the pause
   * between sentences is the sentence boundary rather than the network. Returns false
   * if cancelled part-way (new item, toggle off, pause).
   */
  const speak = useCallback(
    async (chunks: string[]): Promise<boolean> => {
      const token = ++speakToken.current;
      stopRecognition();
      setStatus('speaking');

      // A cancelled read abandons its prefetch mid-flight; the swallow keeps that from
      // surfacing as an unhandled rejection. Awaiting it later still gets the error.
      const prefetch = (text: string) => {
        const p = fetchSpeech(text);
        p.catch(() => {});
        return p;
      };
      let pending: Promise<Blob> | null = chunks.length > 0 ? prefetch(chunks[0]) : null;
      for (let i = 0; i < chunks.length; i++) {
        let blob: Blob;
        try {
          blob = await (pending as Promise<Blob>);
        } catch (err) {
          // One failed chunk should not silence the rest of the read.
          setSpeechError(err instanceof Error ? err.message : String(err));
          pending = i + 1 < chunks.length ? prefetch(chunks[i + 1]) : null;
          continue;
        }
        if (token !== speakToken.current) return false;
        pending = i + 1 < chunks.length ? prefetch(chunks[i + 1]) : null;
        await playBlob(blob);
        if (token !== speakToken.current) return false;
      }
      return token === speakToken.current;
    },
    [fetchSpeech, playBlob, stopRecognition]
  );

  /** Open the ear in a phase, restarting the engine through its silence timeouts. */
  const listen = useCallback((phase: ListenPhase) => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setMicSupported(false);
      setStatus(phase === 'paused' ? 'paused' : null);
      return;
    }
    setMicSupported(true);
    listeningFor.current = phase;
    setStatus(phase === 'paused' ? 'paused' : 'listening');

    try {
      recRef.current?.abort();
    } catch {
      /* fine */
    }
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = latest.current.locale === 'zh' ? 'zh-CN' : 'en-US';
    rec.continuous = phase === 'dictation';
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) void handleTranscript(result[0].transcript);
      }
    };
    rec.onend = () => {
      // Engines stop themselves after a stretch of silence; a hands-free ear must not.
      if (listeningFor.current === phase && recRef.current === rec) {
        try {
          rec.start();
        } catch {
          listen(phase);
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setMicSupported(false);
        listeningFor.current = null;
        setStatus(null);
      }
    };
    try {
      rec.start();
    } catch {
      /* an engine mid-restart throws; onend re-enters */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Read the question and open the answer ear. Also the "repeat" path. */
  const readItem = useCallback(
    async (item: HandsFreeItem) => {
      const { t: dict, locale: loc } = latest.current;
      const finished = await speak([
        ...itemScript(item, dict, loc),
        answerPrompt(item, dict, loc),
      ]);
      if (finished) listen(item.kind === 'mc' ? 'answer' : 'dictation');
    },
    [speak, listen]
  );

  const askConfidence = useCallback(
    async (selectedIndex: number | null) => {
      const { t: dict, locale: loc } = latest.current;
      const finished = await speak([confidencePrompt(selectedIndex, dict, loc)]);
      if (finished) listen('confidence');
    },
    [speak, listen]
  );

  const readFeedback = useCallback(
    async (feedback: SpokenFeedback) => {
      const { t: dict, locale: loc } = latest.current;
      const finished = await speak([
        ...feedbackScript(feedback, dict, loc),
        dict.session.handsFreeSpokenAfterFeedback,
      ]);
      if (!finished) return;
      listen('feedback');
      clearAdvanceTimer();
      advanceTimer.current = setTimeout(() => {
        stopRecognition();
        setStatus('working');
        latest.current.props.onNext();
      }, AUTO_ADVANCE_MS);
    },
    [speak, listen, clearAdvanceTimer, stopRecognition]
  );

  const handleTranscript = useCallback(
    async (transcript: string) => {
      const phase = listeningFor.current;
      const { props: p, t: dict } = latest.current;
      if (!phase) return;

      const command = parseCommand(transcript, {
        locale: latest.current.locale,
        phase,
        optionCount: p.item?.options.length ?? 0,
      });

      if (phase === 'dictation' && !command) {
        // Content, not command: grow the written answer with what was heard.
        const grown = p.freeText ? `${p.freeText} ${transcript.trim()}` : transcript.trim();
        p.onFreeText(grown);
        return;
      }
      if (!command) return;

      switch (command.type) {
        case 'pause':
          stopSpeaking();
          clearAdvanceTimer();
          listen('paused');
          return;

        case 'resume': {
          if (p.feedback) {
            void readFeedback(p.feedback);
          } else if (p.item) {
            void readItem(p.item);
          }
          return;
        }

        case 'repeat': {
          clearAdvanceTimer();
          if (p.feedback) void readFeedback(p.feedback);
          else if (p.item) void readItem(p.item);
          return;
        }

        case 'select': {
          const option = p.item?.options[command.index];
          if (!option) return;
          p.onSelectOption(option.id);
          void askConfidence(command.index);
          return;
        }

        case 'confidence': {
          // Spoken before submission, like the buttons — the auto-submit effect
          // below fires only once both the choice and the confidence are recorded.
          p.onConfidence(command.value);
          stopRecognition();
          setStatus('working');
          return;
        }

        case 'done': {
          // End of dictation. There must be something to grade before moving on.
          if (p.freeText.trim()) void askConfidence(null);
          return;
        }

        case 'dontKnow': {
          if (p.canGiveUp) {
            stopRecognition();
            setStatus('working');
            p.onDontKnow();
          } else {
            // The countdown exists so the retrieval attempt happens; being early is
            // answered out loud, not obeyed.
            const finished = await speak([dict.session.handsFreeSpokenNotYet]);
            if (finished) listen(phase);
          }
          return;
        }

        case 'next': {
          clearAdvanceTimer();
          stopRecognition();
          setStatus('working');
          p.onNext();
          return;
        }
      }
    },
    [
      askConfidence,
      clearAdvanceTimer,
      listen,
      readFeedback,
      readItem,
      speak,
      stopRecognition,
      stopSpeaking,
    ]
  );

  const shutdown = useCallback(() => {
    stopSpeaking();
    stopRecognition();
    clearAdvanceTimer();
    setStatus(null);
  }, [stopSpeaking, stopRecognition, clearAdvanceTimer]);

  const toggle = useCallback(() => {
    if (active) {
      setActive(false);
      shutdown();
      return;
    }
    // Everything in here is inside the user gesture, which is what unlocks audio
    // playback on mobile browsers for the programmatic play() calls that follow.
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'auto';
    }
    const primer = silentWavUrl();
    audioRef.current.src = primer;
    void audioRef.current.play().catch(() => {});
    setTimeout(() => URL.revokeObjectURL(primer), 2000);

    setMicSupported(recognitionCtor() !== null);
    setSpeechError(null);
    // Re-read whatever is on screen when the mode comes on mid-item.
    spokenItem.current = null;
    spokenFeedback.current = null;
    setActive(true);
  }, [active, shutdown]);

  useEffect(() => shutdown, [shutdown]);

  /**
   * The driver: reacts to what SessionRunner is showing. A new item gets read once; its
   * feedback gets read once; the end of the session is announced. Everything in
   * between is transcript-driven rather than render-driven.
   */
  const itemId = props.item?.itemId ?? null;
  const hasFeedback = props.feedback !== null;
  useEffect(() => {
    if (!active) return;

    if (props.done) {
      if (!spokenDone.current) {
        spokenDone.current = true;
        stopRecognition();
        void speak([latest.current.t.session.handsFreeSpokenDone]);
      }
      return;
    }

    if (itemId === null) return;

    if (hasFeedback && spokenFeedback.current !== itemId) {
      spokenFeedback.current = itemId;
      clearAdvanceTimer();
      void readFeedback(latest.current.props.feedback as SpokenFeedback);
      return;
    }

    if (!hasFeedback && spokenItem.current !== itemId) {
      spokenItem.current = itemId;
      clearAdvanceTimer();
      void readItem(latest.current.props.item as HandsFreeItem);
    }
  }, [
    active,
    itemId,
    hasFeedback,
    props.done,
    readItem,
    readFeedback,
    speak,
    stopRecognition,
    clearAdvanceTimer,
  ]);

  /**
   * Auto-submit, gated exactly the way the submit button is: an answer and a spoken
   * confidence must both exist, and each item is submitted at most once from here.
   * SessionRunner's canSubmit() and the server's own checks still stand behind it.
   */
  useEffect(() => {
    if (!active || !props.item || props.feedback || props.submitting) return;
    if (props.confidence === null) return;
    const answered =
      props.item.kind === 'mc'
        ? props.selectedOptionId !== null
        : props.freeText.trim().length > 0;
    if (!answered) return;
    if (submittedFor.current === props.item.itemId) return;
    submittedFor.current = props.item.itemId;
    setStatus('working');
    props.onSubmit();
  }, [active, props]);

  const statusLabel =
    status === 'speaking'
      ? t.session.handsFreeStatusSpeaking
      : status === 'listening'
        ? t.session.handsFreeStatusListening
        : status === 'paused'
          ? t.session.handsFreeStatusPaused
          : status === 'working'
            ? t.session.handsFreeStatusWorking
            : null;

  return (
    <div className="handsfree" data-testid="handsfree">
      <button
        type="button"
        className="btn small"
        aria-pressed={active}
        data-testid="handsfree-toggle"
        onClick={toggle}
      >
        {t.session.handsFreeToggle}
      </button>

      {!active && <span className="note">{t.session.handsFreeHint}</span>}

      {active && statusLabel && (
        <span className="hf-status" data-status={status ?? 'idle'} aria-live="polite">
          <span className="hf-dot" aria-hidden />
          {statusLabel}
        </span>
      )}

      {active && micSupported === false && (
        <span className="note">{t.session.handsFreeNoMic}</span>
      )}

      {active && speechError && (
        <span className="note" style={{ color: 'var(--terra)' }}>
          {fill(t.session.handsFreeError, { message: speechError })}
        </span>
      )}
    </div>
  );
}
