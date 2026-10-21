"""VOX - Distributed Speech-to-Text Transcription System.

Apache Spark + pretrained deep-learning ASR models (Whisper / wav2vec2.0).
"""
# This file makes the "vox" folder a Python PACKAGE, so other code can write
# "import vox" or "from vox import audio". Spark workers rely on this too.

# Version number of the project (shown by the website in /api/status).
__version__ = "1.0.0"
