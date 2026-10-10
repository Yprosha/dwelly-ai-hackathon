"""ElevenLabs voice layer: speech-to-text for call recordings / voicemails, text-to-speech for the broker's reply.

Plain HTTPS via urllib (no SDK). Needs ELEVENLABS_API_KEY (env or .env); without it every call raises
VoiceUnavailable, and callers must carry on without voice.

Loader integration (one branch in load_case, before the 'unsupported file type' else):
    elif ext in voice.AUDIO_EXT:
        texts.append((rel, voice.event_text(voice.audio_to_event(p)))); case['files'].append(f'{rel} (audio, transcribed)')
The loader's per-file try/except already turns a VoiceUnavailable/HTTP error into a note, so the case still runs.
"""
import json
import mimetypes
import os
import urllib.error
import urllib.request
import uuid
from functools import lru_cache
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:  # dotenv is a core dep, but voice must never be the thing that breaks a run
    pass

API = 'https://api.elevenlabs.io/v1'
AUDIO_EXT = {'.mp3', '.wav', '.m4a', '.ogg', '.oga', '.opus', '.webm', '.flac', '.aac', '.amr', '.mp4'}
STT_MODEL = os.environ.get('ELEVENLABS_STT_MODEL', 'scribe_v2')
TTS_MODEL = os.environ.get('ELEVENLABS_TTS_MODEL', 'eleven_multilingual_v2')
VOICE_ID = os.environ.get('ELEVENLABS_VOICE_ID', 'JBFqnCBsd6RMkjVDRZzb')  # "George": calm British English
ROLE = {'customer': 'Caller', 'agent': 'Broker'}  # labels from Scribe's detect_speaker_roles


class VoiceUnavailable(RuntimeError):
    pass


def _key():
    k = os.environ.get('ELEVENLABS_API_KEY')
    if not k:
        raise VoiceUnavailable('ELEVENLABS_API_KEY is not set (env or .env); voice features are off')
    return k


def _post(url, body, content_type, timeout=180):
    req = urllib.request.Request(url, data=body, method='POST',
                                 headers={'xi-api-key': _key(), 'Content-Type': content_type})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise VoiceUnavailable(f'ElevenLabs {e.code}: {e.read()[:300].decode(errors="replace")}') from e
    except urllib.error.URLError as e:
        raise VoiceUnavailable(f'ElevenLabs unreachable: {e.reason}') from e


def _multipart(fields, filename, data, mime):
    b = uuid.uuid4().hex
    parts = [f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
    parts.append(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                 f'Content-Type: {mime}\r\n\r\n'.encode() + data + b'\r\n')
    return b''.join(parts) + f'--{b}--\r\n'.encode(), f'multipart/form-data; boundary={b}'


def stt_raw(data, filename='audio.webm', mime=None):
    """Scribe transcription with diarization and caller/broker role detection. Returns the response JSON."""
    mime = mime or mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    fields = {'model_id': STT_MODEL, 'diarize': 'true', 'detect_speaker_roles': 'true', 'tag_audio_events': 'true'}
    try:
        out = _post(f'{API}/speech-to-text', *_multipart(fields, filename, data, mime))
    except VoiceUnavailable as e:
        if 'ElevenLabs 4' not in str(e) or '401' in str(e):
            raise
        del fields['detect_speaker_roles']  # older model / plan without role detection: plain diarization
        out = _post(f'{API}/speech-to-text', *_multipart(fields, filename, data, mime))
    return json.loads(out)


def format_transcript(resp):
    """Words -> 'Caller: ...' lines, one per speaker turn. Unknown roles become Speaker 1/2/...;
    a single anonymous speaker (voicemail) is the Caller."""
    turns, ids = [], []
    for w in resp.get('words') or []:
        if w.get('type') == 'spacing' and turns:
            turns[-1][1].append(' ')
            continue
        sid = w.get('speaker_id') or 'speaker_0'
        if sid not in ids:
            ids.append(sid)
        text = w.get('text', '')
        if not turns or turns[-1][0] != sid:
            turns.append((sid, []))
        turns[-1][1].append(text)
    if not turns:
        return (resp.get('text') or '').strip()

    def label(sid):
        if len(ids) == 1:  # voicemail / one voice: role detection guesses here (seen: 'agent'), so trust the context
            return 'Caller'
        return ROLE.get(sid) or f'Speaker {ids.index(sid) + 1}'
    return '\n'.join(f'{label(sid)}: {"".join(t).strip()}' for sid, t in turns if ''.join(t).strip())


def transcribe_bytes(data, filename='audio.webm', mime=None):
    return format_transcript(stt_raw(data, filename, mime))


@lru_cache(maxsize=256)
def _transcribe_cached(path, _mtime):
    p = Path(path)
    return transcribe_bytes(p.read_bytes(), p.name)


def transcribe(path):
    """Audio file -> call-note style transcript ('Caller: ... / Broker: ...')."""
    p = Path(path)
    return _transcribe_cached(str(p.resolve()), p.stat().st_mtime)


def speak(text, out_path, voice_id=VOICE_ID):
    """Text -> mp3 at out_path (ElevenLabs TTS). Returns out_path."""
    out_path = Path(out_path)
    out_path.write_bytes(speak_bytes(text, voice_id))
    return out_path


def speak_bytes(text, voice_id=VOICE_ID):
    body = json.dumps({'text': text, 'model_id': TTS_MODEL,
                       'voice_settings': {'stability': 0.6, 'similarity_boost': 0.75, 'speed': 0.95}}).encode()
    return _post(f'{API}/text-to-speech/{voice_id}?output_format=mp3_44100_128', body, 'application/json')


def audio_to_event(path):
    """Audio file in a case folder -> a Call event dict the loader can render into the case text."""
    p = Path(path)
    transcript = transcribe(p)
    return {'channel': 'Call', 'from_': 'Caller (identity not verified; from audio)', 'body': transcript, 'source': p.name}


def event_text(ev):
    """Render an event dict in the same markdown shape as history.md events."""
    return (f"## Call recording — {ev['source']}\n\n- **Channel:** {ev['channel']}\n- **From:** {ev['from_']}\n"
            f"- **Source:** audio file {ev['source']}, transcribed automatically by ElevenLabs Scribe "
            f"(speaker labels and wording may contain recognition errors)\n\n{ev['body']}\n")


if __name__ == '__main__':  # self-check, no network
    import sys
    os.environ.pop('ELEVENLABS_API_KEY', None)
    try:
        speak_bytes('hi')
        raise AssertionError('should need a key')
    except VoiceUnavailable as e:
        assert 'ELEVENLABS_API_KEY' in str(e)
    w = lambda t, s, ty='word': {'text': t, 'speaker_id': s, 'type': ty}
    resp = {'words': [w('Hello', 'agent'), w(' ', 'agent', 'spacing'), w('broker.', 'agent'), w(' ', 'agent', 'spacing'),
                      w('Water', 'customer'), w(' ', 'customer', 'spacing'), w('everywhere.', 'customer'),
                      w('(sigh)', 'customer', 'audio_event')]}
    assert format_transcript(resp) == 'Broker: Hello broker.\nCaller: Water everywhere.(sigh)', format_transcript(resp)
    one = {'words': [w('Hi', 'speaker_0'), w(' ', 'speaker_0', 'spacing'), w('there', 'speaker_0')]}
    assert format_transcript(one) == 'Caller: Hi there'
    assert format_transcript({'words': [w('Hi', 'agent')]}) == 'Caller: Hi'
    two = {'words': [w('A', 'speaker_0'), w('B', 'speaker_1')]}
    assert format_transcript(two) == 'Speaker 1: A\nSpeaker 2: B'
    assert format_transcript({'text': ' plain ', 'words': []}) == 'plain'
    body, ct = _multipart({'model_id': 'm'}, 'a.mp3', b'\x00\x01', 'audio/mpeg')
    assert ct.split('boundary=')[1] in body.decode('latin1') and b'name="model_id"\r\n\r\nm\r\n' in body
    assert 'Call recording' in event_text({'channel': 'Call', 'from_': 'x', 'body': 'Caller: hi', 'source': 'v.mp3'})
    print('ok')
    sys.exit(0)
