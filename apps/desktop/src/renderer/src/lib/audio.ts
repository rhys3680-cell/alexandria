export type RecordingSource = 'mic' | 'system' | 'both';

export const SOURCE_LABELS: Record<RecordingSource, string> = {
  mic: '마이크',
  system: '시스템 소리',
  both: '마이크+시스템',
};

/**
 * Opens the system audio loopback.
 *
 * Chromium only hands over desktop audio as part of a desktop *capture*, so a
 * video track has to be requested alongside it. It is asked for at 1x1 and
 * stopped immediately — nothing is ever recorded from the screen.
 */
async function openSystemAudio(sourceId: string): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'desktop' } },
    video: {
      mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 1, maxHeight: 1 },
    },
  } as unknown as MediaStreamConstraints);

  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  if (stream.getAudioTracks().length === 0) {
    throw new Error('시스템 소리를 가져오지 못했습니다.');
  }
  return stream;
}

export interface OpenedRecording {
  /** What MediaRecorder should record. */
  stream: MediaStream;
  /** Everything that must be stopped afterwards, mixed stream included. */
  release: () => void;
}

/**
 * Builds the stream for a recording.
 *
 * `both` is the case that matters for a meeting: your own voice comes from the
 * microphone and everyone else's from the loopback, and they have to end up in
 * one track or the transcript only carries half the conversation.
 */
export async function openRecording(
  source: RecordingSource,
  getSourceId: () => Promise<string | undefined>,
): Promise<OpenedRecording> {
  const opened: MediaStream[] = [];
  let context: AudioContext | undefined;

  const release = () => {
    for (const stream of opened) {
      for (const track of stream.getTracks()) track.stop();
    }
    void context?.close();
  };

  try {
    if (source === 'mic') {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      opened.push(mic);
      return { stream: mic, release };
    }

    const sourceId = await getSourceId();
    if (!sourceId) throw new Error('캡처할 화면을 찾지 못했습니다.');

    const system = await openSystemAudio(sourceId);
    opened.push(system);

    if (source === 'system') return { stream: system, release };

    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    opened.push(mic);

    context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    context.createMediaStreamSource(mic).connect(destination);
    context.createMediaStreamSource(system).connect(destination);
    return { stream: destination.stream, release };
  } catch (error) {
    release();
    throw error;
  }
}
