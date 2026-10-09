"""
Synthesises the two background tracks the year-wrap templates use, so the
videos ship with music we own outright (no licensing, no attribution).

    python3 scripts/make-music.py      # writes public/music/*.mp3 (needs numpy + ffmpeg)

  sunny-steps.mp3  Preparatory — 118 BPM, bouncy marimba + claps
  big-sky.mp3      Middle      — 96 BPM, warm piano arpeggios that build

Deterministic (fixed seed): re-running produces the same files. Swap either
file for a licensed track with the same name to change the music.
"""
import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'music')
rng = np.random.default_rng(7)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n, attack=0.005, decay=0.3):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t / decay)


def tone(freq, dur, partials=((1, 1.0),), attack=0.005, decay=0.3, detune=0.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.zeros(n)
    for mult, amp in partials:
        s += amp * np.sin(2 * np.pi * freq * mult * t)
        if detune:
            s += amp * 0.6 * np.sin(2 * np.pi * freq * mult * (1 + detune) * t)
    return s * env(n, attack, decay)


def kick(dur=0.35):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 45 + 90 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def noise(dur, decay, hp=True):
    n = int(dur * SR)
    x = rng.standard_normal(n)
    if hp:
        x = np.diff(x, prepend=0)
    return x * np.exp(-np.arange(n) / SR / decay)


def clap():
    out = np.zeros(int(0.25 * SR))
    for i in range(3):  # three tiny offset bursts read as a hand clap
        place(out, noise(0.18, 0.05), i * 0.011)
    return out * 0.35


def place(buf, sig, at):
    i = int(at * SR)
    j = min(len(buf), i + len(sig))
    if i < len(buf):
        buf[i:j] += sig[: j - i]


def lowpass(x, alpha):
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):  # one-pole; fine for a few seconds of bass
        acc += alpha * (v - acc)
        y[i] = acc
    return y


def write_mp3(name, stereo):
    stereo = np.tanh(stereo * 1.2)
    stereo /= np.max(np.abs(stereo)) + 1e-9
    pcm = (stereo * 0.89 * 32767).astype(np.int16)
    os.makedirs(OUT, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        tmp = f.name
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    dest = os.path.join(OUT, name)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp,
                    '-af', 'aecho=0.8:0.5:60|110:0.18|0.10,afade=t=in:d=0.4',
                    '-codec:a', 'libmp3lame', '-b:a', '160k', dest], check=True)
    os.remove(tmp)
    print('wrote', dest)


def track(bpm, bars, progression, voicing, pattern_fn, drums_from_bar, style):
    beat = 60 / bpm
    total = bars * 4 * beat + 2
    L = np.zeros(int(total * SR))
    R = np.zeros_like(L)
    for bar in range(bars):
        root, quality = progression[bar % len(progression)]
        chord = [root + i for i in voicing[quality]]
        t0 = bar * 4 * beat
        # pad
        for k, n in enumerate(chord):
            p = tone(midi(n), 4 * beat + 0.3, ((1, 0.5), (2, 0.12)), attack=0.4 if style == 'mid' else 0.05,
                     decay=3.0, detune=0.003) * (0.05 if style == 'prep' else 0.075)
            place(L if k % 2 else R, p, t0)
            place(R if k % 2 else L, p * 0.6, t0)
        # bass
        bass_steps = [0, 1.5, 2, 3] if style == 'prep' else [0, 2, 2.5]
        for b in bass_steps:
            s = tone(midi(root - 12), beat * 0.9, ((1, 1), (2, 0.5), (3, 0.25)), decay=0.25) * 0.22
            place(L, s, t0 + b * beat)
            place(R, s, t0 + b * beat)
        # lead (marimba for prep, piano for mid)
        for step, note, vel in pattern_fn(bar, chord):
            if style == 'prep':
                s = tone(midi(note), 0.6, ((1, 1), (4, 0.35), (10, 0.06)), decay=0.16) * 0.2 * vel
            else:
                s = tone(midi(note), 1.4, ((1, 1), (2, 0.35), (3, 0.12)), decay=0.55) * 0.16 * vel
            pan = 0.5 + 0.3 * np.sin(step)
            place(L, s * (1 - pan) * 2, t0 + step * beat)
            place(R, s * pan * 2, t0 + step * beat)
        # drums
        if bar >= drums_from_bar and bar < bars - 1:
            for b in range(4):
                if style == 'prep' or b % 2 == 0:
                    k = kick() * (0.55 if style == 'prep' else 0.45)
                    place(L, k, t0 + b * beat)
                    place(R, k, t0 + b * beat)
                if b in (1, 3):
                    c = clap() * (1.0 if style == 'prep' else 0.7)
                    place(L, c, t0 + b * beat)
                    place(R, c * 0.9, t0 + b * beat)
            for e in range(8):
                h = noise(0.05, 0.012) * (0.08 if e % 2 else 0.05)
                place(R if e % 2 else L, h, t0 + e * beat / 2)
    # gentle final chord
    t_end = (bars - 1) * 4 * beat
    root, quality = progression[0]
    for n in [root + i for i in voicing[quality]] + [root + 12]:
        s = tone(midi(n), 4.0, ((1, 1), (2, 0.3)), decay=1.6) * 0.12
        place(L, s, t_end)
        place(R, s, t_end)
    return np.stack([L, R], axis=1)


VOICING = {'maj': (0, 4, 7, 12), 'min': (0, 3, 7, 12)}


def prep_pattern(bar, chord):
    # bouncy syncopated marimba on chord tones + pentatonic pickups
    tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[3] + 12]
    steps = [(0, 0), (0.75, 2), (1.5, 1), (2, 3), (2.75, 2), (3.5, 1)]
    if bar % 4 == 3:
        steps = [(0, 3), (0.5, 2), (1, 1), (1.5, 0), (2, 1), (2.5, 2), (3, 3), (3.5, 3)]
    return [(s, tones[i], 1.0 if s == int(s) else 0.75) for s, i in steps]


def mid_pattern(bar, chord):
    # rising arpeggio in eighths; denser and higher as the track builds
    octave = 12 if bar >= 8 else 0
    seq = [0, 1, 2, 3, 2, 1, 2, 3]
    notes = [chord[i] + 12 + octave for i in seq]
    out = [(e * 0.5, n, 0.8 if e % 2 else 1.0) for e, n in enumerate(notes)]
    if bar >= 12 and bar % 2 == 1:  # melody on top in the last third
        out.append((0, chord[3] + 24, 0.9))
        out.append((2, chord[2] + 24, 0.8))
    return out


if __name__ == '__main__':
    # C major: I–V–vi–IV
    write_mp3('sunny-steps.mp3', track(118, 38, [(60, 'maj'), (55, 'maj'), (57, 'min'), (53, 'maj')],
                                       VOICING, prep_pattern, drums_from_bar=2, style='prep'))
    # G major: I–vi–IV–V
    write_mp3('big-sky.mp3', track(96, 32, [(55, 'maj'), (52, 'min'), (48, 'maj'), (50, 'maj')],
                                   VOICING, mid_pattern, drums_from_bar=4, style='mid'))
