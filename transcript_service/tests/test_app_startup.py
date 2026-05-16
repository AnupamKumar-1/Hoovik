"""Startup ordering tests for transcript_service/app.py."""

import importlib
import importlib.abc
import os
import sys
import types
import unittest
from unittest import mock


SERVICE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, SERVICE_ROOT)


def module_stub(name: str, **attrs):
    module = types.ModuleType(name)
    for attr_name, value in attrs.items():
        setattr(module, attr_name, value)
    return module


class BlockAsrImport(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname == "services.asr_service":
            raise AssertionError("services.asr_service imported before ffmpeg check")
        return None


class TranscriptServiceStartupTests(unittest.TestCase):
    def test_ffmpeg_check_runs_before_asr_model_import(self):
        """Missing ffmpeg should fail before importing model-heavy ASR code."""
        sys.modules.pop("app", None)
        previous_asr = sys.modules.pop("services.asr_service", None)

        dotenv = module_stub("dotenv", load_dotenv=lambda: None)
        fastapi = module_stub(
            "fastapi",
            FastAPI=object,
            File=lambda *args, **kwargs: None,
            Form=lambda *args, **kwargs: None,
            Header=lambda *args, **kwargs: None,
            UploadFile=object,
            Request=object,
            BackgroundTasks=object,
        )
        fastapi.__path__ = []
        fastapi_middleware = module_stub("fastapi.middleware")
        fastapi_middleware.__path__ = []
        fastapi_cors = module_stub("fastapi.middleware.cors", CORSMiddleware=object)
        fastapi_responses = module_stub(
            "fastapi.responses",
            JSONResponse=object,
        )
        werkzeug = module_stub("werkzeug")
        werkzeug.__path__ = []
        werkzeug_utils = module_stub(
            "werkzeug.utils",
            secure_filename=lambda filename: filename,
        )

        stubbed_modules = {
            "dotenv": dotenv,
            "fastapi": fastapi,
            "fastapi.middleware": fastapi_middleware,
            "fastapi.middleware.cors": fastapi_cors,
            "fastapi.responses": fastapi_responses,
            "werkzeug": werkzeug,
            "werkzeug.utils": werkzeug_utils,
        }

        import_blocker = BlockAsrImport()

        try:
            sys.meta_path.insert(0, import_blocker)
            with mock.patch.dict(sys.modules, stubbed_modules):
                with mock.patch(
                    "utils.audio.ensure_ffmpeg_available",
                    side_effect=RuntimeError("missing ffmpeg"),
                ) as ensure_ffmpeg_available:
                    with self.assertRaisesRegex(RuntimeError, "missing ffmpeg"):
                        importlib.import_module("app")

                    ensure_ffmpeg_available.assert_called_once_with()
                    self.assertNotIn("services.asr_service", sys.modules)
        finally:
            if import_blocker in sys.meta_path:
                sys.meta_path.remove(import_blocker)
            sys.modules.pop("app", None)
            if previous_asr is not None:
                sys.modules["services.asr_service"] = previous_asr


if __name__ == "__main__":
    unittest.main()
