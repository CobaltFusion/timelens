import { AnomalyKind, EventAnalyzer } from "./event_analyzer.js";

// Stable string hash (FNV-1a), so a message type always gets the same note.
function hashString(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; ++i) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

// Major pentatonic over three octaves from A3: any combination of notes sounds consonant,
// so normal traffic sounds calm and the anomaly sounds stand out.
const pentatonic = [0, 2, 4, 7, 9];
function noteFor(key) {
    const index = hashString(key) % (pentatonic.length * 3);
    const semitones = Math.floor(index / pentatonic.length) * 12 + pentatonic[index % pentatonic.length];
    return 220 * Math.pow(2, semitones / 12);
}

/**
 * Turns the event stream into sound, to hear exceptional events.
 *
 * Background: every message type plays its own note, as loud as that type is busy. Together they
 * form a chord, a steady system keeps a steady chord, a change in the mix changes the chord.
 *
 * Foreground: anomalies found by the EventAnalyzer play a short, louder cue in the note of their type:
 *   early: rising chirp, late: falling chirp, missing: low falling "uh-oh",
 *   long duration: low buzz, short duration: high blip, new type: two note chime.
 */
export class SignatureSound {
    constructor(audioAlerts, getNowUs) {
        this.audioAlerts = audioAlerts;
        this.getNowUs = getNowUs;           // current time in the event timebase (µs)
        this.analyzer = new EventAnalyzer();

        this.tickMs = 100;
        this.maxVoices = 16;                // message types with their own background note
        this.backgroundVolume = 0.12;       // of the whole chord
        this.cueVolume = 0.35;
        this.maxCuesPerTick = 2;            // the most unusual ones are played, the rest is dropped

        this.enabled = false;
        this.timer = null;
        this.master = null;                 // background chord: voices -> filter -> master -> output
        this.filter = null;
        this.voices = new Map();            // key -> { oscillator, gain, rate }
        this.tickCounts = new Map();        // key -> messages during this tick
        this.pendingCues = [];
    }

    // Always called, also while disabled, so the analyzer keeps learning what is normal.
    onIncomingEvent(event) {
        const anomaly = this.analyzer.observe(event);
        if (!this.enabled) {
            return;
        }

        const key = EventAnalyzer.keyOf(event);
        this.tickCounts.set(key, (this.tickCounts.get(key) ?? 0) + 1);
        if (anomaly) {
            this.pendingCues.push(anomaly);
        }
    }

    isEnabled() {
        return this.enabled;
    }

    setEnabled(value) {
        if (value === this.enabled) {
            return;
        }
        this.enabled = value;
        if (value) {
            this.#start();
        }
        else {
            this.#stop();
        }
    }

    toggle() {
        this.setEnabled(!this.enabled);
        return this.enabled;
    }

    #start() {
        const audio = this.audioAlerts.context;
        this.filter = audio.createBiquadFilter();
        this.filter.type = "lowpass";
        this.filter.frequency.value = 1500;     // a soft pad, it should not distract
        this.master = audio.createGain();
        this.master.gain.value = this.backgroundVolume;
        this.filter.connect(this.master);
        this.master.connect(this.audioAlerts.output);

        this.tickCounts.clear();
        this.pendingCues = [];
        this.timer = setInterval(() => this.#tick(), this.tickMs);
    }

    #stop() {
        clearInterval(this.timer);
        this.timer = null;

        const audio = this.audioAlerts.context;
        const master = this.master;
        const voices = [...this.voices.values()];
        master.gain.setTargetAtTime(0, audio.currentTime, 0.05);
        setTimeout(() => {
            for (const voice of voices) {
                voice.oscillator.stop();
                voice.oscillator.disconnect();
                voice.gain.disconnect();
            }
            this.filter?.disconnect();
            master.disconnect();
        }, 300);

        this.voices.clear();
        this.master = null;
        this.filter = null;
    }

    #tick() {
        for (const missing of this.analyzer.findMissing(this.getNowUs())) {
            this.pendingCues.push(missing);
        }

        if (!this.audioAlerts.isAudioEnabled()) {
            // muted: nothing is scheduled, otherwise it would all play at once on unmute
            this.tickCounts.clear();
            this.pendingCues = [];
            return;
        }

        this.#updateBackground();
        this.#playCues();
    }

    #updateBackground() {
        const audio = this.audioAlerts.context;
        const ticksPerSecond = 1000 / this.tickMs;

        for (const key of this.tickCounts) {
            if (!this.voices.has(key) && this.voices.size < this.maxVoices) {
                this.voices.set(key, this.#createVoice(key));
            }
        }

        // the loudness follows the log of the message rate, smoothed over a few ticks
        for (const [key, voice] of this.voices) {
            const rate = (this.tickCounts.get(key) ?? 0) * ticksPerSecond;
            voice.rate += (rate - voice.rate) * 0.3;
            const level = Math.min(1, Math.log10(1 + voice.rate) / 3);     // 1000 messages/s is full
            voice.gain.gain.setTargetAtTime(level / Math.sqrt(this.maxVoices), audio.currentTime, 0.15);
        }
        this.tickCounts.clear();
    }

    #createVoice(key) {
        const audio = this.audioAlerts.context;
        const oscillator = audio.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.value = noteFor(key);
        const gain = audio.createGain();
        gain.gain.value = 0;
        oscillator.connect(gain);
        gain.connect(this.filter);
        oscillator.start();
        return { oscillator, gain, rate: 0 };
    }

    #playCues() {
        if (this.pendingCues.length === 0) {
            return;
        }
        // one cue per name, a late open is usually followed by a late close
        const strongest = new Map();
        for (const cue of this.pendingCues) {
            if (cue.score > (strongest.get(cue.name)?.score ?? -Infinity)) {
                strongest.set(cue.name, cue);
            }
        }
        const cues = [...strongest.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, this.maxCuesPerTick);
        this.pendingCues = [];

        // spread within the tick, so two cues are heard as two
        const spacing = this.tickMs / 1000 / this.maxCuesPerTick;
        cues.forEach((cue, index) => this.#playCue(cue, index * spacing));
    }

    #playCue(anomaly, delay) {
        const note = noteFor(anomaly.key);
        // more unusual is louder, up to twice the threshold
        const loudness = this.cueVolume * Math.min(1, 0.5 + 0.5 * (anomaly.score / this.analyzer.threshold - 1));

        switch (anomaly.kind) {
            case AnomalyKind.EARLY:
                this.#tone({ delay, type: "triangle", from: note * 2, to: note * 3, duration: 0.15, volume: loudness });
                break;
            case AnomalyKind.LATE:
                this.#tone({ delay, type: "triangle", from: note * 3, to: note * 2, duration: 0.15, volume: loudness });
                break;
            case AnomalyKind.MISSING:
                this.#tone({ delay, type: "sine", from: note / 2, to: note / 2, duration: 0.12, volume: loudness });
                this.#tone({ delay: delay + 0.14, type: "sine", from: note / 2 * 0.84, to: note / 2 * 0.84, duration: 0.2, volume: loudness });
                break;
            case AnomalyKind.LONG:
                this.#tone({ delay, type: "sawtooth", from: note / 2, to: note / 2, duration: 0.3, volume: loudness * 0.6 });
                break;
            case AnomalyKind.SHORT:
                this.#tone({ delay, type: "square", from: note * 4, to: note * 4, duration: 0.04, volume: loudness * 0.5 });
                break;
            case AnomalyKind.NEW:
                this.#tone({ delay, type: "sine", from: note * 2, to: note * 2, duration: 0.12, volume: loudness });
                this.#tone({ delay: delay + 0.12, type: "sine", from: note * 3, to: note * 3, duration: 0.2, volume: loudness });
                break;
        }
    }

    // one tone with a pitch glide 'from' -> 'to' and a short fade in, fading out until the end
    #tone({ delay, type, from, to, duration, volume }) {
        const audio = this.audioAlerts.context;
        const begin = audio.currentTime + delay;
        const end = begin + duration;

        const oscillator = audio.createOscillator();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(from, begin);
        oscillator.frequency.exponentialRampToValueAtTime(to, end);

        const gain = audio.createGain();
        gain.gain.setValueAtTime(0, begin);
        gain.gain.linearRampToValueAtTime(volume, begin + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.001, end);

        oscillator.connect(gain);
        gain.connect(this.audioAlerts.output);
        oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
        };
        oscillator.start(begin);
        oscillator.stop(end);
    }
}
