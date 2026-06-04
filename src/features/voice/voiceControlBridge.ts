import { useEffect, useState } from 'react';
import type { VoiceState } from './useVoiceInput';

export interface VoiceControlSnapshot {
  voiceState: VoiceState;
  continuousVoiceEnabled: boolean;
  voiceError: string | null;
}

export const VOICE_CONTROL_STATE_EVENT = 'nerve:voice-control-state';
export const VOICE_CONTROL_COMMAND_EVENT = 'nerve:voice-control-command';

type VoiceControlCommand = 'toggle-voice' | 'toggle-live';

const DEFAULT_VOICE_CONTROL_SNAPSHOT: VoiceControlSnapshot = {
  voiceState: 'idle',
  continuousVoiceEnabled: false,
  voiceError: null,
};

let latestVoiceControlSnapshot = DEFAULT_VOICE_CONTROL_SNAPSHOT;

export function publishVoiceControlSnapshot(snapshot: VoiceControlSnapshot) {
  latestVoiceControlSnapshot = snapshot;
  window.dispatchEvent(new CustomEvent<VoiceControlSnapshot>(VOICE_CONTROL_STATE_EVENT, { detail: snapshot }));
}

export function sendVoiceControlCommand(command: VoiceControlCommand) {
  window.dispatchEvent(new CustomEvent<VoiceControlCommand>(VOICE_CONTROL_COMMAND_EVENT, { detail: command }));
}

export function useVoiceControlSnapshot() {
  const [snapshot, setSnapshot] = useState(latestVoiceControlSnapshot);

  useEffect(() => {
    const handleState = (event: Event) => {
      setSnapshot((event as CustomEvent<VoiceControlSnapshot>).detail);
    };

    window.addEventListener(VOICE_CONTROL_STATE_EVENT, handleState);
    return () => window.removeEventListener(VOICE_CONTROL_STATE_EVENT, handleState);
  }, []);

  return snapshot;
}
