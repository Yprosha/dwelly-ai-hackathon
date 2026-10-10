## Voice (ElevenLabs)

Calls are a normal channel in a broker's day: voicemails, recorded calls, a policyholder ringing in about a leak.
The voice layer brings them into the same agent workflow as email and notes.

**Speech-to-text (ingestion).** Any audio file in a case folder (`.mp3 .wav .m4a .ogg .opus .webm .flac .aac .amr .mp4`)
is transcribed with ElevenLabs Scribe (`scribe_v2`), with speaker diarization and caller/broker role detection, and is added
to the case as a `Call` event (`Caller: ... / Broker: ...`). The event says the text is an automatic transcript and that
the caller's identity is unverified, so the agent treats it as evidence, not as fact. If the key is missing or the API
fails, the loader records a note on the case saying the file could not be read and why, and the case still runs on its other content.

**Live voice line (demo).** `python -m agent.voice_demo` serves a one-page phone line on http://127.0.0.1:8777.
The caller presses the mic and speaks. The audio is transcribed by Scribe and added to the case as a new Call event.
The core broker agent then runs its usual tool loop, with the same tools, self-check and safety rules as the batch run,
and decides to act, ask for information, escalate or take no action. Its message to the caller is spoken back with
ElevenLabs TTS in a calm British voice. A message the agent marks as needing human approval is never spoken; the caller
hears a neutral holding line and the case goes to a human. Every turn is traced to `logs/voice_demo/<call>.jsonl`.

```bash
uv pip install -e .
# .env: ELEVENLABS_API_KEY=...  plus ANTHROPIC_API_KEY (or AWS_BEARER_TOKEN_BEDROCK)
python -m agent.voice_demo                    # built-in demo policyholder
python -m agent.voice_demo --case path/to/case  # take the call on an existing case file
python -m agent.voice_make_audio <cases_dir> <out_dir> 006 016 022   # turn Call events into recordings for testing
python -m agent.voice                          # offline self-check
```

| Env var | Default | |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | none | required for voice; without it voice is off and everything else runs |
| `ELEVENLABS_STT_MODEL` | `scribe_v2` | |
| `ELEVENLABS_TTS_MODEL` | `eleven_multilingual_v2` | |
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` (George, British) | the broker's voice |
