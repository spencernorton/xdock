"""The real child status must survive the compositor's EXIT trap."""
import subprocess
import os
import sys
import tempfile
import unittest
from pathlib import Path


class StopShellTest(unittest.TestCase):
    def run_child(self, mode, body_status=0):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            child = work / 'child.py'
            child.write_text('''import os, resource, signal, sys
from pathlib import Path
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
def stop(_signal, _frame):
    if sys.argv[1] == 'clean': sys.exit(0)
    if sys.argv[1] == 'timeout': sys.exit(124)
    os.kill(os.getpid(), getattr(signal, sys.argv[1]))
if sys.argv[1] != 'term': signal.signal(signal.SIGTERM, stop)
Path(sys.argv[2]).touch()
while True: signal.pause()
''')
            result = subprocess.run([
                'bash', '-euo', 'pipefail', '-c', '''
source "$1"
"$2" "$3/child.py" "$4" "$3/ready" &
shell=$!
trap 'finish_shell "$?" "$shell" "$3/status"' EXIT
for _ in {1..200}; do
    [ ! -f "$3/ready" ] || break
    sleep 0.01
done
test -f "$3/ready"
exit "$5"
''', 'bash', str(Path(__file__).with_name('stop-shell.sh')),
                sys.executable, str(work), mode, str(body_status),
            ], capture_output=True, text=True, timeout=10)
            status = int((work / 'status').read_text())
            return result, status

    def test_graceful_exit_passes(self):
        result, status = self.run_child('clean')
        self.assertEqual((result.returncode, status), (0, 0), result.stderr)

    def test_requested_term_passes(self):
        result, status = self.run_child('term')
        self.assertEqual((result.returncode, status), (0, 143), result.stderr)

    def test_segfault_at_shutdown_fails(self):
        result, status = self.run_child('SIGSEGV')
        self.assertEqual((result.returncode, status), (139, 139), result.stderr)

    def test_forced_kill_at_shutdown_fails(self):
        result, status = self.run_child('SIGKILL')
        self.assertEqual((result.returncode, status), (137, 137), result.stderr)

    def test_deadline_failure_is_not_success(self):
        result, status = self.run_child('timeout')
        self.assertEqual((result.returncode, status), (124, 124), result.stderr)

    def test_cleanup_preserves_earlier_failure(self):
        result, status = self.run_child('clean', 42)
        self.assertEqual((result.returncode, status), (42, 0), result.stderr)


class HarnessStatusTest(unittest.TestCase):
    def run_harness(self, crash, harness=None):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            tools = work / 'bin'
            tools.mkdir()
            extension = work / 'extension'
            extension.mkdir()
            stubs = {
                'gsettings': '#!/bin/sh\nexit 0\n',
                'dbus-run-session': '#!/bin/sh\nshift\nexec "$@"\n',
                'gnome-shell': f'''#!{sys.executable}
import os, resource, signal, sys
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
def stop(_signal, _frame):
    if {crash!r}: os.kill(os.getpid(), signal.SIGSEGV)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
print('IDLE-FRAMES result: pass', flush=True)
print('IDLE-FRAMES done', flush=True)
while True: signal.pause()
''',
            }
            for name, content in stubs.items():
                path = tools / name
                path.write_text(content)
                path.chmod(0o755)
            return subprocess.run([
                'bash', str(harness or Path(__file__).with_name('idle-frames.sh')),
                str(extension),
            ], env={**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH']},
                capture_output=True, text=True, timeout=10)

    def test_completion_followed_by_graceful_shutdown_passes(self):
        result = self.run_harness(False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_completion_followed_by_silent_shutdown_crash_fails(self):
        result = self.run_harness(True)
        self.assertIn('IDLE-FRAMES done', result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
