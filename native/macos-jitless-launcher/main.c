/*
 * Mach-O trampoline for the packaged York GrowthOS binary.
 *
 * macOS 26+ (Tahoe) often fails V8 CodeRange reservation unless
 * --js-flags=--jitless is on argv before V8 init. A bash
 * CFBundleExecutable is signed as "bundle with generic" and gets
 * host => identifier "com.apple.bash". Squirrel.Mac then copies
 * SecCodeCopySelf from the exec'd Electron binary (*.real), whose
 * codesign identifier is the product name — not ie.york.app — and
 * rejects updates. Keep this trampoline as a real Mach-O whose
 * identifier matches the Electron stub.
 *
 * Marker string YORK_JITLESS_LAUNCHER is used by the installer to
 * detect an already-installed trampoline.
 */
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

#ifndef MACOS_JITLESS_MIN_MAJOR
#define MACOS_JITLESS_MIN_MAJOR 26
#endif

__attribute__((used)) static const char kMarker[] = "YORK_JITLESS_LAUNCHER";

static int macos_major(void) {
  char ver[64];
  size_t size = sizeof(ver);
  memset(ver, 0, sizeof(ver));
  if (sysctlbyname("kern.osproductversion", ver, &size, NULL, 0) != 0) {
    return 0;
  }
  return atoi(ver);
}

int main(int argc, char **argv) {
  char exe[PATH_MAX];
  uint32_t sz = sizeof(exe);
  if (_NSGetExecutablePath(exe, &sz) != 0) {
    fprintf(stderr, "York GrowthOS launcher: executable path too long\n");
    return 1;
  }

  char resolved[PATH_MAX];
  if (realpath(exe, resolved) == NULL) {
    strncpy(resolved, exe, sizeof(resolved) - 1);
    resolved[sizeof(resolved) - 1] = '\0';
  }

  char real_path[PATH_MAX];
  int n = snprintf(real_path, sizeof(real_path), "%s.real", resolved);
  if (n < 0 || n >= (int)sizeof(real_path)) {
    fprintf(stderr, "York GrowthOS launcher: path too long\n");
    return 1;
  }
  if (access(real_path, X_OK) != 0) {
    fprintf(stderr, "York GrowthOS launcher: missing binary: %s (%s)\n", real_path, strerror(errno));
    return 1;
  }

  const int inject = macos_major() >= MACOS_JITLESS_MIN_MAJOR;
  const char *flag = "--js-flags=--jitless";
  const int extra = inject ? 1 : 0;
  char **newargv = calloc((size_t)argc + (size_t)extra + 1, sizeof(char *));
  if (!newargv) {
    perror("calloc");
    return 1;
  }

  int i = 0;
  newargv[i++] = real_path;
  if (inject) {
    newargv[i++] = (char *)flag;
  }
  for (int a = 1; a < argc; a++) {
    newargv[i++] = argv[a];
  }
  newargv[i] = NULL;

  execv(real_path, newargv);
  fprintf(stderr, "York GrowthOS launcher: execv %s: %s\n", real_path, strerror(errno));
  return 1;
}
