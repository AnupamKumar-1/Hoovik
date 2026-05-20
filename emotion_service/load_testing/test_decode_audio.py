import asyncio
import numpy as np
import socketio

SERVER_URL = "http://127.0.0.1:5002"
PARTICIPANT_ID = "test-decode-audio"


async def connect(sio):
    await sio.connect(SERVER_URL, auth={"participantId": PARTICIPANT_ID})
    await asyncio.sleep(1.0)
    print(f"  Connected as {PARTICIPANT_ID}")


async def run_tests():
    print("\n=== _decode_audio_bytes failure path test ===\n")
    print("Watch server logs for DEBUG lines.\n")

    sio = socketio.AsyncClient(logger=False)
    await connect(sio)
    bad_bytes = b"this is not audio at all!!!"
    await sio.emit("audio_chunk", bad_bytes)
    await asyncio.sleep(0.5)
    await sio.disconnect()
    print("TEST 1 — Corrupt bytes (not % 4):")
    print(f"  Sent {len(bad_bytes)} bytes of garbage")
    print("  Expected: DEBUG | _decode_audio_bytes soundfile decode failed len=27")
    print("  Expected: DEBUG | _decode_audio_bytes: unrecognised format len=27")
    await asyncio.sleep(0.3)

    sio = socketio.AsyncClient(logger=False)
    await connect(sio)
    bad_bytes_4 = b"BADBADBA"
    await sio.emit("audio_chunk", bad_bytes_4)
    await asyncio.sleep(0.5)
    await sio.disconnect()
    print("\nTEST 2 — Corrupt bytes (% 4 == 0, hits float32 path):")
    print(f"  Sent {len(bad_bytes_4)} bytes")
    print("  Expected: DEBUG | _decode_audio_bytes soundfile decode failed len=8")
    await asyncio.sleep(0.3)

    sio = socketio.AsyncClient(logger=False)
    await connect(sio)
    pcm = np.zeros(1600, dtype=np.float32)
    await sio.emit("audio_chunk", pcm.tobytes())
    await asyncio.sleep(0.5)
    await sio.disconnect()
    print("\nTEST 3 — Valid float32 PCM (happy path, 1600 samples):")
    print(f"  Sent {len(pcm.tobytes())} bytes of silent float32 PCM")
    print("  Expected: float32 fallback succeeds, no unrecognised format log")
    await asyncio.sleep(0.3)

    sio = socketio.AsyncClient(logger=False)
    await connect(sio)
    await sio.emit("audio_chunk", b"")
    await asyncio.sleep(0.5)
    await sio.disconnect()
    print("\nTEST 4 — Empty payload:")
    print("  Sent 0 bytes")
    print("  Expected: WARNING | audio size invalid len=0")
    await asyncio.sleep(0.3)

    sio = socketio.AsyncClient(logger=False)
    await connect(sio)
    await sio.emit(
        "audio_chunk",
        {"participantId": PARTICIPANT_ID, "buffer": list(b"not audio!!!")},
    )
    await asyncio.sleep(0.5)
    await sio.disconnect()
    print("\nTEST 5 — Dict payload with bad audio buffer:")
    print("  Sent dict with int list buffer (12 bytes)")
    print("  Expected: DEBUG | _decode_audio_bytes soundfile decode failed len=12")

    print("\n=== All payloads sent ===")


if __name__ == "__main__":
    asyncio.run(run_tests())
