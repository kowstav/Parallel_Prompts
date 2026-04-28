#!/usr/bin/env python3
"""
Install / uninstall the Parallel Prompts helper as a Chrome Native Messaging host.

Usage:
    python install.py           # install
    python install.py uninstall # remove the manifest

After install, restart Chrome and click "Recheck" in the Background Jobs tab.

The host name is "io.parallelprompts.helper" — must match the hard-coded name
the extension uses in chrome.runtime.connectNative().
"""

import json
import os
import platform
import stat
import sys
from pathlib import Path

HOST_NAME = "io.parallelprompts.helper"
DESCRIPTION = "Parallel Prompts local helper daemon"


def host_dirs(system: str) -> list[Path]:
    """Return possible Chrome / Chromium NativeMessagingHosts dirs for this user."""
    home = Path.home()
    if system == "Linux":
        return [
            home / ".config/google-chrome/NativeMessagingHosts",
            home / ".config/chromium/NativeMessagingHosts",
            home / ".config/google-chrome-beta/NativeMessagingHosts",
            home / ".config/google-chrome-unstable/NativeMessagingHosts",
        ]
    if system == "Darwin":  # macOS
        return [
            home / "Library/Application Support/Google/Chrome/NativeMessagingHosts",
            home / "Library/Application Support/Chromium/NativeMessagingHosts",
        ]
    if system == "Windows":
        # Windows uses registry, handled separately in install_windows()
        return []
    return []


def make_manifest(daemon_path: Path, allowed_origin: str) -> dict:
    return {
        "name": HOST_NAME,
        "description": DESCRIPTION,
        "path": str(daemon_path.resolve()),
        "type": "stdio",
        "allowed_origins": [allowed_origin],
    }


def install_unix(daemon_path: Path, allowed_origin: str) -> list[Path]:
    written: list[Path] = []
    for d in host_dirs(platform.system()):
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            print(f"  skipped {d}: {e}")
            continue
        manifest_path = d / f"{HOST_NAME}.json"
        manifest_path.write_text(json.dumps(make_manifest(daemon_path, allowed_origin), indent=2))
        written.append(manifest_path)
        print(f"  wrote {manifest_path}")
    # ensure daemon is executable
    try:
        st = daemon_path.stat()
        daemon_path.chmod(st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except Exception as e:
        print(f"  warning: could not chmod daemon: {e}")
    return written


def install_windows(daemon_path: Path, allowed_origin: str) -> Path:
    """On Windows the manifest path goes in HKCU registry; we still write the JSON file too."""
    import winreg  # type: ignore

    here = Path(__file__).resolve().parent
    manifest_path = here / f"{HOST_NAME}.json"
    # Wrap the .py file in a .bat so Chrome can launch it
    bat_path = here / f"{HOST_NAME}.bat"
    bat_path.write_text(f'@echo off\r\n"{sys.executable}" "{daemon_path}" %*\r\n')
    manifest = make_manifest(bat_path, allowed_origin)
    manifest_path.write_text(json.dumps(manifest, indent=2))

    key_path = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as k:
        winreg.SetValue(k, "", winreg.REG_SZ, str(manifest_path))
    print(f"  wrote {manifest_path}")
    print(f"  registry: HKCU\\{key_path} -> {manifest_path}")
    return manifest_path


def uninstall():
    system = platform.system()
    if system == "Windows":
        try:
            import winreg
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}")
            print("  removed Windows registry key")
        except Exception as e:
            print(f"  registry removal failed: {e}")
    for d in host_dirs(system):
        p = d / f"{HOST_NAME}.json"
        if p.exists():
            try:
                p.unlink()
                print(f"  removed {p}")
            except Exception as e:
                print(f"  could not remove {p}: {e}")


def detect_extension_id() -> str | None:
    """Best-effort: look at the most recent extension dirs for a manifest naming us."""
    home = Path.home()
    candidates = []
    for path in [
        home / ".config/google-chrome/Default/Extensions",
        home / "Library/Application Support/Google/Chrome/Default/Extensions",
        home / "AppData/Local/Google/Chrome/User Data/Default/Extensions",
    ]:
        if not path.exists():
            continue
        for ext_dir in path.iterdir():
            if not ext_dir.is_dir():
                continue
            # Each extension has versioned subdirs containing manifest.json
            for ver_dir in ext_dir.iterdir():
                m = ver_dir / "manifest.json"
                if not m.exists():
                    continue
                try:
                    data = json.loads(m.read_text())
                    if data.get("name") == "Parallel Prompts":
                        candidates.append((m.stat().st_mtime, ext_dir.name))
                except Exception:
                    pass
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "uninstall":
        uninstall()
        print("Done. Restart Chrome.")
        return

    here = Path(__file__).resolve().parent
    daemon_path = here / "daemon.py"
    if not daemon_path.exists():
        print("ERROR: daemon.py not found next to install.py")
        sys.exit(1)

    # Get the extension ID either from CLI arg or by guessing
    if len(sys.argv) > 1 and sys.argv[1].startswith("--id="):
        ext_id = sys.argv[1].split("=", 1)[1]
    else:
        ext_id = detect_extension_id()
        if not ext_id:
            print("Couldn't auto-detect the Parallel Prompts extension ID.")
            print("Find it at chrome://extensions (toggle Developer Mode), then re-run:")
            print(f"    python {sys.argv[0]} --id=<32-char-id>")
            sys.exit(1)
        print(f"Detected extension ID: {ext_id}")

    allowed_origin = f"chrome-extension://{ext_id}/"
    system = platform.system()
    print(f"Installing on {system}…")

    if system == "Windows":
        install_windows(daemon_path, allowed_origin)
    else:
        written = install_unix(daemon_path, allowed_origin)
        if not written:
            print("ERROR: no NativeMessagingHosts directory was writable.")
            sys.exit(1)

    print("\nDone. Restart Chrome, then click 'Recheck' in the Background Jobs tab.")


if __name__ == "__main__":
    main()
