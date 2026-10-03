
export class AudioAlerts {
    constructor() {
        this.audio = new AudioContext();
        this.audioEnabled = false;
        this.setAudio();

        // All sounds go through a limiter, so overlapping sounds can not add up past full scale.
        this.limiter = this.audio.createDynamicsCompressor();
        this.limiter.threshold.value = -6;     // dB
        this.limiter.knee.value = 0;
        this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.002;     // s
        this.limiter.release.value = 0.1;
        this.limiter.connect(this.audio.destination);

        this.volume = 0.2;          // of a single sound
        this.activeVoices = 0;
        this.maxRandomVoices = 4;   // random sounds are skipped while this many sounds are playing

        this.types = ["sine", "square", "sawtooth", "triangle"];

        this.notes = [
            261.63, 277.18, 293.66, 311.13,
            329.63, 349.23, 369.99, 392.00,
            415.30, 440.00, 466.16, 493.88,
            523.25, 554.37, 587.33, 622.25,
            659.25, 698.46, 739.99, 783.99,
            830.61, 880.00, 932.33, 987.77
        ];
    }

    alertBeep() {
        this.beep(1300, 0.0, 0.05, "square");
    }

    beep(frequency, startTime, duration, type = "sine") {
        // while muted the context is suspended, scheduled sounds would all play at once on unmute
        if (!this.audioEnabled) {
            return;
        }

        const osc = this.audio.createOscillator();
        const gain = this.audio.createGain();

        osc.type = type;
        osc.frequency.value = frequency;

        // short fade in and out, starting or stopping at full volume clicks
        const begin = this.audio.currentTime + startTime;
        const end = begin + duration;
        const fade = Math.min(0.005, duration / 4);
        gain.gain.setValueAtTime(0, begin);
        gain.gain.linearRampToValueAtTime(this.volume, begin + fade);
        gain.gain.setValueAtTime(this.volume, end - fade);
        gain.gain.linearRampToValueAtTime(0, end);

        osc.connect(gain);
        gain.connect(this.limiter);

        ++this.activeVoices;
        osc.onended = () => {
            --this.activeVoices;
            osc.disconnect();
            gain.disconnect();
        };

        osc.start(begin);
        osc.stop(end);
    }

    randomNote(startTime = 0) {
        const duration = 0.02 + Math.random() * 0.08;

        this.beep(
            this.notes[Math.floor(Math.random() * this.notes.length)],
            startTime,
            duration,
            this.types[Math.floor(Math.random() * this.types.length)]
        );

        return duration;
    }

    playPseudoRandomSound(name) {
        // with many events at once, more sounds only turn into noise
        if (this.activeVoices >= this.maxRandomVoices) {
            return;
        }

        let hash = 0;

        for (let i = 0; i < name.length; ++i) {
            hash = ((hash << 5) - hash) + name.charCodeAt(i);
            hash |= 0;
        }

        hash = Math.abs(hash);

        const note = this.notes[hash % this.notes.length];
        const type = this.types[(hash >> 4) % this.types.length];
        const duration = 0.02 + ((hash >> 8) % 80) / 1000;
        const startTime = ((hash >> 16) % 30) / 1000;

        this.beep(note, startTime, duration, type);
    }

    async toggleAudio() {
        this.audioEnabled = !this.audioEnabled;
        this.setAudio();
        return this.audioEnabled;
    }

    isAudioEnabled() {
        return this.audioEnabled;
    }

    setAudio() {
        if (this.audioEnabled) {
            this.audio.resume();
        } else {
            this.audio.suspend();
        }
    }

}

