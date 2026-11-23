#!/usr/bin/python3 -I
"""Keep Herdr's updates a fixed number of days behind upstream.

Herdr (the desktop app) and herdr-core read their release feed from
HERDR_RELEASES_URL. This script keeps a local copy of that feed which only
names a release once it has been public for the lag, and points Herdr at it.

  lag.py install --app VERSION --core VERSION [--lag-days N]   set it up on this Mac
  lag.py uninstall                                             remove the job and the setting
  lag.py sync [--lag-days N]    record new releases, let old enough ones through
  lag.py status [--json]        what the mirror offers, what waits, until when
  lag.py set-lag N              change the lag
  lag.py hold | resume          stop or resume letting releases through
"""
import datetime as dt
import glob
import hashlib
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile

UPSTREAM = "https://releases.herdr.dev"
TEAM = "2W9652Q7QR"
IDENTIFIER = {"app": "dev.herdr.app", "core": "dev.herdr.core"}
TARGET = "macos-aarch64"
DEFAULT_LAG_DAYS = 7
LABEL = "com.user.herdr-lagged-releases"

HOME = os.path.expanduser("~")
BASE = os.path.join(HOME, ".local/share/herdr-lagged-releases")
MIRROR = os.path.join(BASE, "mirror")
SEEN = os.path.join(BASE, "seen")
LOG = os.path.join(BASE, "sync.log")
HOLD = os.path.join(BASE, "hold")
LAG_FILE = os.path.join(BASE, "lag_days")
PLIST = os.path.join(HOME, "Library/LaunchAgents", LABEL + ".plist")
MIRROR_URL = "file://" + MIRROR
INSTALLED = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)


def supported():
    return sys.platform == "darwin" and platform.machine() == "arm64"


def now():
    return dt.datetime.now(dt.timezone.utc)


def log(message):
    line = "%s %s" % (now().strftime("%Y-%m-%dT%H:%M:%SZ"), message)
    print(line, file=sys.stderr)
    os.makedirs(BASE, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def vkey(version):
    return tuple(int(part) for part in version.split("."))


CURL = ["/usr/bin/curl", "-fsSL", "--proto", "=https", "--max-time", "600"]


def curl(url):
    return subprocess.run(CURL + [url], check=True, capture_output=True, text=True).stdout


def download(url, to):
    subprocess.run(CURL + [url, "-o", to], check=True, capture_output=True)


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f, indent=2)
    os.replace(tmp, path)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def lag_days():
    try:
        with open(LAG_FILE) as f:
            return max(0, int(f.read().strip()))
    except (OSError, ValueError):
        return DEFAULT_LAG_DAYS


def set_lag(days):
    os.makedirs(BASE, exist_ok=True)
    with open(LAG_FILE, "w") as f:
        f.write("%d\n" % max(0, days))


def seen(kind):
    records = []
    for path in glob.glob(os.path.join(SEEN, kind, "*.json")):
        record = read_json(path)
        if record:
            records.append(record)
    return sorted(records, key=lambda r: vkey(r["manifest"]["version"]))


def record(kind, manifest, first_seen, source):
    version = manifest["version"]
    vkey(version)  # refuse a version that is not plain numbers
    path = os.path.join(SEEN, kind, version + ".json")
    if os.path.exists(path):
        return False
    write_json(path, {"first_seen": first_seen.isoformat(), "source": source, "manifest": manifest})
    log("%s %s recorded (%s)" % (kind, version, source))
    return True


def mirrored(kind):
    manifest = read_json(os.path.join(MIRROR, kind, "latest.json"))
    return manifest["version"] if manifest else None


def verify(kind, manifest):
    """Download the macOS build, check it against the recorded sha256 and Herdr's signature."""
    target = manifest["targets"][TARGET]
    with tempfile.TemporaryDirectory(prefix="herdr-lagged-") as work:
        tarball = os.path.join(work, "release.tar.gz")
        download(target["url"], tarball)
        digest = hashlib.sha256()
        with open(tarball, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                digest.update(chunk)
        if digest.hexdigest() != target["sha256"].lower():
            return "sha256 differs from the one recorded when the release was first seen"
        out = os.path.join(work, "out")
        os.makedirs(out)
        subprocess.run(["/usr/bin/tar", "-xzf", tarball, "-C", out], check=True, capture_output=True)
        bundles = glob.glob(os.path.join(out, "*.app")) + glob.glob(os.path.join(out, "*", "*.app"))
        if len(bundles) != 1:
            return "expected one .app in the archive, found %d" % len(bundles)
        requirement = '=identifier "%s" and anchor apple generic and certificate leaf[subject.OU] = "%s"' % (IDENTIFIER[kind], TEAM)
        check = subprocess.run(
            ["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", requirement, bundles[0]],
            capture_output=True, text=True,
        )
        if check.returncode != 0:
            return "not signed by Herdr (team %s): %s" % (TEAM, check.stderr.strip())
    return None


def promote(kind, days):
    cutoff = now() - dt.timedelta(days=days)
    old_enough = [r for r in seen(kind) if dt.datetime.fromisoformat(r["first_seen"]) <= cutoff]
    if not old_enough:
        return
    manifest = old_enough[-1]["manifest"]
    version = manifest["version"]
    current = mirrored(kind)
    if current and vkey(version) <= vkey(current):
        return
    if kind == "app":
        core = mirrored("core")
        need = manifest.get("core_min")
        if need and (not core or vkey(core) < vkey(need)):
            log("app %s waits: it needs core %s and the mirror has %s" % (version, need, core))
            return
    problem = verify(kind, manifest)
    if problem:
        log("%s %s NOT let through: %s" % (kind, version, problem))
        return
    if kind == "app":
        try:
            notes = curl("%s/app/%s/changelog.md" % (UPSTREAM, version))
            path = os.path.join(MIRROR, "app", version, "changelog.md")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(notes)
        except subprocess.CalledProcessError:
            pass
    write_json(os.path.join(MIRROR, kind, "latest.json"), manifest)
    log("%s %s let through to the mirror (was %s)" % (kind, version, current))


def app_bundle():
    real = os.path.realpath(os.path.join(HOME, ".local/bin/herdr-app"))
    marker = ".app/Contents/MacOS/"
    return real[: real.index(marker) + 4] if marker in real else None


def drop_early_stage():
    """An app started without HERDR_RELEASES_URL stages upstream's latest. Remove it before a quit installs it."""
    bundle, allowed = app_bundle(), mirrored("app")
    if not bundle or not allowed:
        return
    receipt = bundle + ".new.json.noindex"
    staged = bundle + ".new.noindex"
    info = read_json(receipt)
    if info and vkey(info["version"]) > vkey(allowed):
        shutil.rmtree(staged, ignore_errors=True)
        os.remove(receipt)
        log("removed staged app %s: newer than the mirror's %s" % (info["version"], allowed))


def launchctl(*args):
    return subprocess.run(["/bin/launchctl"] + list(args), capture_output=True, text=True)


def sync(days):
    launchctl("setenv", "HERDR_RELEASES_URL", MIRROR_URL)
    for kind in ("core", "app"):
        try:
            manifest = json.loads(curl("%s/%s/latest.json" % (UPSTREAM, kind)))
            record(kind, manifest, now(), "first seen")
        except (subprocess.CalledProcessError, ValueError, KeyError) as e:
            log("%s: cannot read upstream: %s" % (kind, e))
    if not os.path.exists(HOLD):
        for kind in ("core", "app"):
            try:
                promote(kind, days)
            except (subprocess.CalledProcessError, OSError, KeyError, ValueError) as e:
                log("%s: could not let a release through: %s" % (kind, e))
    drop_early_stage()


def app_uses_mirror():
    pids = subprocess.run(["/usr/bin/pgrep", "-x", "Herdr"], capture_output=True, text=True).stdout.split()
    if not pids:
        return None
    out = subprocess.run(["/bin/ps", "eww", "-o", "command=", "-p", pids[0]], capture_output=True, text=True).stdout
    return ("HERDR_RELEASES_URL=" + MIRROR_URL) in out


def status():
    days = lag_days()
    kinds = {}
    for kind in ("app", "core"):
        offers = mirrored(kind)
        waiting = []
        for r in seen(kind):
            version = r["manifest"]["version"]
            if not offers or vkey(version) > vkey(offers):
                due = dt.datetime.fromisoformat(r["first_seen"]) + dt.timedelta(days=days)
                waiting.append({"version": version, "due": due.isoformat()})
        kinds[kind] = {"offers": offers, "waiting": waiting}
    return {
        "supported": supported(),
        "installed": os.path.exists(PLIST),
        "lag_days": days,
        "hold": os.path.exists(HOLD),
        "app_uses_mirror": app_uses_mirror(),
        "mirror": MIRROR_URL,
        "kinds": kinds,
    }


def print_status():
    s = status()
    print("mirror: %s (lag %d days%s%s)" % (s["mirror"], s["lag_days"], ", ON HOLD" if s["hold"] else "", "" if s["installed"] else ", NOT SET UP"))
    uses = s["app_uses_mirror"]
    print("Herdr is not running" if uses is None else "running Herdr uses the mirror" if uses else "running Herdr does NOT use the mirror yet: quit and reopen it")
    for kind in ("app", "core"):
        print("%s: mirror offers %s" % (kind, s["kinds"][kind]["offers"]))
        for w in s["kinds"][kind]["waiting"]:
            print("  %s waits until %s" % (w["version"], w["due"][:16].replace("T", " ") + " UTC"))


def install(app, core, days):
    if days is not None:
        set_lag(days)
    for kind, version in (("app", app), ("core", core)):
        if version and not os.path.exists(os.path.join(SEEN, kind, version + ".json")):
            manifest = json.loads(curl("%s/%s/%s/manifest.json" % (UPSTREAM, kind, version)))
            if manifest["version"] != version:
                sys.exit("manifest names %s, not %s" % (manifest["version"], version))
            record(kind, manifest, INSTALLED, "already installed")
    sync(lag_days())
    os.makedirs(os.path.dirname(PLIST), exist_ok=True)
    with open(PLIST, "wb") as f:
        plistlib.dump({
            "Label": LABEL,
            "ProgramArguments": ["/usr/bin/python3", "-I", os.path.realpath(__file__), "sync"],
            "RunAtLoad": True,
            "StartInterval": 1800,
            "StandardOutPath": "/dev/null",
            "StandardErrorPath": "/dev/null",
        }, f)
    domain = "gui/%d" % os.getuid()
    launchctl("bootout", "%s/%s" % (domain, LABEL))
    result = launchctl("bootstrap", domain, PLIST)
    if result.returncode != 0:
        sys.exit("launchctl bootstrap failed: %s" % result.stderr.strip())
    log("set up: lag %d days, job %s" % (lag_days(), LABEL))


def uninstall():
    launchctl("bootout", "gui/%d/%s" % (os.getuid(), LABEL))
    if os.path.exists(PLIST):
        os.remove(PLIST)
    launchctl("unsetenv", "HERDR_RELEASES_URL")
    log("removed: Herdr reads the live feed again after it is reopened")


def option(argv, name):
    return argv[argv.index(name) + 1] if name in argv else None


def main(argv):
    command = argv[1] if len(argv) > 1 else "status"
    if command == "status":
        print(json.dumps(status())) if "--json" in argv else print_status()
        return
    if not supported():
        sys.exit("update-lag works on macOS with Apple Silicon only")
    days = option(argv, "--lag-days")
    days = int(days) if days is not None else None
    if command == "sync":
        sync(lag_days() if days is None else days)
    elif command == "install":
        install(option(argv, "--app"), option(argv, "--core"), days)
    elif command == "uninstall":
        uninstall()
    elif command == "set-lag":
        set_lag(int(argv[2]))
        sync(lag_days())
    elif command == "hold":
        os.makedirs(BASE, exist_ok=True)
        open(HOLD, "w").close()
    elif command == "resume":
        if os.path.exists(HOLD):
            os.remove(HOLD)
        sync(lag_days())
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
