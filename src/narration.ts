import { useEffect, useRef } from "react";
import { highlightKindLabel, type HighlightReel } from "../shared/highlights.js";
import type { Language } from "../shared/types.js";

const VOICE_LANG: Record<Language, string> = { en: "en-GB", es: "es-ES", fr: "fr-FR" };

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

export function speak(text: string, language: Language): void {
  if (!speechSupported() || !text.trim()) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = VOICE_LANG[language];
  const voice = synth.getVoices().find((item) => item.lang.toLowerCase().startsWith(language));
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;
  synth.speak(utterance);
}

/** Reads each clip's title and caption aloud as the reel reaches it, in the caption's language. */
export function useClipNarration(reel: HighlightReel, activeIndex: number, playing: boolean, enabled: boolean): void {
  const spoken = useRef(-1);

  useEffect(() => {
    if (playing && enabled) return;
    stopSpeaking();
    spoken.current = -1;
  }, [playing, enabled]);

  useEffect(() => {
    if (!playing || !enabled || activeIndex < 0 || activeIndex === spoken.current) return;
    const clip = reel.clips[activeIndex];
    if (!clip) return;
    spoken.current = activeIndex;
    speak(`${highlightKindLabel(clip.kind, clip.captionLanguage)}. ${clip.caption}`, clip.captionLanguage);
  }, [activeIndex, playing, enabled, reel]);

  useEffect(() => () => stopSpeaking(), []);
}
