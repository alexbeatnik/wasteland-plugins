/**
 * Voice input.
 *
 * Speaking into the composer instead of typing. The app owns the microphone
 * button, the capture and the encoding — `getUserMedia` only exists in the
 * window, and no plugin runs code there — and hands over a finished 16 kHz mono
 * WAV. This plugin owns everything else: which model, where it came from, and
 * what the words are.
 *
 * **It contributes nothing to the system prompt, on purpose.** Nothing the model
 * can do changes: it receives text in the composer exactly as if it had been
 * typed, and it has no idea which. Telling it about a microphone it cannot
 * operate would spend context on a fact it can never act on — and would invite
 * it to offer to "listen", which it cannot.
 *
 * The mic button appears only once a model is on disk. A microphone that records
 * into nothing is a dead control, and the row below is where a model is
 * obtained.
 */
import { MODELS, ensureBinary, ensureModel, modelFor, modelPath, transcribe } from './whisper.mjs';

/** Long enough that a stuck subprocess is not a permanently wedged button. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;

export function activate(ctx) {
  const mic = ctx.service('mic');
  const dataDir = ctx.dataDir();

  /** Resolved once and reused: finding the binary walks a directory tree. */
  let binary = '';
  /** In flight, so two clicks on the picker do not start two downloads. */
  let provisioning = null;

  const chosen = () => String(ctx.store.get('model', '') || '').trim();
  const language = () => String(ctx.store.get('language', 'auto') || 'auto').trim();

  const label = () => {
    const model = modelFor(chosen());
    return model ? `Whisper ${model.value}` : 'Whisper';
  };

  /**
   * Register with the app, saying whether it can actually work.
   *
   * `ready` is what decides whether the button is drawn at all, so it is a
   * statement about the model being on disk rather than about this plugin being
   * switched on.
   */
  const announce = (ready) => {
    mic.setTranscriber({
      pluginId: ctx.id,
      label: label(),
      ready,
      transcribe: async (wav) => {
        const engine = await ensureEngine();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
        try {
          return await transcribe({
            binary: engine,
            model: modelPath(dataDir, chosen()),
            wav,
            language: language(),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      },
    });
  };

  /** The binary, fetched on first use rather than at activation. */
  async function ensureEngine() {
    if (binary) return binary;
    binary = await ensureBinary(dataDir, {
      configured: ctx.store.get('binary', ''),
      onProgress: (progress) => ctx.progress(progress.text, progress),
    });
    ctx.progress('');
    return binary;
  }

  /**
   * Make the chosen model usable, downloading it if it is not there yet.
   *
   * Everything is reported on the plugin's own row, because that is where the
   * choice was made and a gigabyte-and-a-half download needs somewhere to be
   * watched. Concurrent callers share one attempt: choosing `medium` twice in a
   * second must not start two downloads of the same file.
   */
  async function provision() {
    const model = modelFor(chosen());
    if (!model) {
      mic.setReady(ctx.id, false);
      return;
    }
    if (provisioning) return provisioning;

    provisioning = (async () => {
      try {
        ctx.progress(`fetching ${model.file}`, { received: 0, total: 0 });
        await ensureModel(dataDir, model.value, {
          onProgress: ({ received, total }) => ctx.progress(`fetching ${model.file}`, { received, total }),
        });
        // The engine as well, so the first press of the button is not a
        // surprise second download with the microphone already open.
        await ensureEngine();

        ctx.progress('');
        announce(true);
        ctx.log(`${model.value} is ready`);
      } catch (err) {
        ctx.progress('');
        mic.setReady(ctx.id, false);
        // On the row rather than thrown: this runs from a settings change, where
        // there is nobody to catch anything, and the row is where the retry is.
        ctx.log(`could not set up ${model.value} — ${err.message}`);
      } finally {
        provisioning = null;
      }
    })();
    return provisioning;
  }

  // Registered before anything is fetched, so the app knows who drives the
  // button; `ready` stays false until a model is actually on disk.
  announce(false);

  // A model chosen, a language changed, or a path typed in. The model is what
  // has to be fetched; the rest take effect on the next recording by themselves,
  // since both are read live.
  ctx.onSettingsChanged((key) => {
    if (key === 'binary') binary = '';
    if (key === 'model' || key === 'binary') return provision();
    announce(Boolean(modelFor(chosen())));
    return undefined;
  });

  // On startup: if a model was chosen in an earlier session and is still on
  // disk, the button comes back without asking. Unawaited — a plugin must not
  // hold up activation, and a missing file resolves to a quiet `ready: false`.
  if (chosen()) provision();
}

/** Switched off: the app takes the button down when the transcriber is released. */
export function deactivate() {
  /* the host releases the mic service, which is what hides the button */
}

/** Re-exported so the manifest and the code cannot drift about what is offered. */
export { MODELS };
