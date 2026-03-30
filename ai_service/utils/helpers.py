import os
import threading

def allowed_file(filename, allowed_ext):
    return filename.rsplit(".", 1)[-1].lower() in allowed_ext

def clean_speaker(name):
    if not name or name.lower() in ["unknown", "undefined"]:
        return "Guest"
    return name

def schedule_file_cleanup(paths, delay):
    def cleanup():
        for p in paths:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception as e:
                print(f"[cleanup error]: {e}")

    t = threading.Timer(delay, cleanup)
    t.daemon = True
    t.start()