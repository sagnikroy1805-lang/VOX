"""Generate a small synthetic demo dataset with espeak-ng (developer utility).

The shipped data/samples/ folder was created with this script so VOX can be
tried before downloading LibriSpeech. Sentences are from the IEEE "Harvard
sentences" list (phonetically balanced, standard in speech testing).
Requires espeak-ng on PATH. Usage:  python scripts/make_demo_samples.py
"""
import csv
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "samples"

SENTENCES = [
    "The birch canoe slid on the smooth planks.",
    "Glue the sheet to the dark blue background.",
    "It's easy to tell the depth of a well.",
    "These days a chicken leg is a rare dish.",
    "Rice is often served in round bowls.",
    "The juice of lemons makes fine punch.",
    "The box was thrown beside the parked truck.",
    "The hogs were fed chopped corn and garbage.",
    "Four hours of steady work faced us.",
    "Large size in stockings is hard to sell.",
    "The boy was there when the sun rose.",
    "A rod is used to catch pink salmon.",
    "The source of the huge river is the clear spring.",
    "Kick the ball straight and follow through.",
    "Help the woman get back to her feet.",
    "A pot of tea helps to pass the evening.",
    "Smoky fires lack flame and heat.",
    "The soft cushion broke the man's fall.",
    "The salt breeze came across from the sea.",
    "The girl at the booth sold fifty bonds.",
    "The small pup gnawed a hole in the sock.",
    "The fish twisted and turned on the bent hook.",
    "Press the pants and sew a button on the vest.",
    "The swan dive was far short of perfect.",
    "The beauty of the view stunned the young boy.",
    "Two blue fish swam in the tank.",
    "Her purse was full of useless trash.",
    "The colt reared and threw the tall rider.",
    "It snowed, rained, and hailed the same morning.",
    "Read verse out loud for pleasure.",
    "Hoist the load to your left shoulder.",
    "Take the winding path to reach the lake.",
    "Note closely the size of the gas tank.",
    "Wipe the grease off his dirty face.",
    "Mend the coat before you go out.",
    "The wrist was badly strained and hung limp.",
    "The stray cat gave birth to kittens.",
    "The young girl gave no clear response.",
    "The meal was cooked before the bell rang.",
    "What joy there is in living.",
]
VOICES = ["en-us", "en", "en-us+m3", "en+f2"]

SPANISH = [
    "El perro corre rápido por el parque.",
    "Mañana vamos a la playa con mis amigos.",
    "La comida de mi abuela es la mejor del mundo.",
    "¿Dónde está la estación de tren?",
    "Me gusta leer libros por la noche.",
    "El cielo está muy azul hoy.",
    "Necesito comprar pan y leche.",
    "Mi hermano estudia ingeniería en la universidad.",
    "La música suena muy bien esta tarde.",
    "Hace mucho calor en verano.",
]
# espeak-ng can only pronounce kana, so these sentences are written in kana.
JAPANESE = [
    "おはようございます。",
    "きょうは いい てんき です ね。",
    "わたしは がくせい です。",
    "これは なん です か。",
    "ありがとう ございます。",
    "えき は どこ です か。",
    "すし が すき です。",
    "また あした。",
    "コーヒー を ください。",
    "にほんご を べんきょう して います。",
]
EXTRA = {"es": ("samples_es", SPANISH, ["es", "es-419"]),
         "ja": ("samples_ja", JAPANESE, ["ja"])}


def make_lang(lang):
    folder, sentences, voices = EXTRA[lang]
    out = ROOT / "data" / folder
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, text in enumerate(sentences):
        name = f"{lang}_{i:02d}.wav"
        subprocess.run(["espeak-ng", "-v", voices[i % len(voices)], "-s", "140",
                        "-w", str(out / name), text], check=True)
        rows.append({"id": f"{lang}_{i:02d}", "path": name,
                     "reference": text.replace(" ", "") if lang == "ja" else text,
                     "language": lang})
    with open(out / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["id", "path", "reference", "language"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} {lang} files to {out}")


def main():
    for lang in EXTRA:
        make_lang(lang)
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, text in enumerate(SENTENCES):
        voice = VOICES[i % len(VOICES)]
        tmp = OUT / f"_tmp_{i}.wav"
        subprocess.run(["espeak-ng", "-v", voice, "-s", "150", "-w", str(tmp), text], check=True)
        y, sr = sf.read(tmp, dtype="float32")
        tmp.unlink()
        pad = np.zeros(int(sr * 0.6), np.float32)          # silence to exercise trimming
        y = np.concatenate([pad, y, pad])
        ext = "flac" if i % 3 == 0 else "wav"               # mixed formats on purpose
        name = f"harvard_{i:02d}.{ext}"
        sf.write(OUT / name, y, sr)
        rows.append({"id": f"harvard_{i:02d}", "path": name, "reference": text,
                     "language": "en"})
    with open(OUT / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["id", "path", "reference", "language"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} files to {OUT}")


if __name__ == "__main__":
    sys.exit(main())
