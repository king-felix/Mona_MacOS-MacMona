// The one operation Swift cannot express: fork() and the child-side session
// setup. Everything here runs between fork and exec, so it calls only
// async-signal-safe functions.

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <termios.h>
#include <unistd.h>

int mona_spawn_pty(const char *slave, const char *shell, char *const argv[],
                   char *const envp[], const char *cwd) {
  pid_t pid = fork();
  if (pid < 0) {
    return -errno;
  }
  if (pid == 0) {
    // A new session makes the child a process-group leader, so kill(-pid)
    // reaches every descendant it starts.
    setsid();
    // Opened without O_NOCTTY by the new session leader: this pty becomes the
    // controlling terminal, which is what makes Ctrl-C and job control work.
    int fd = open(slave, O_RDWR);
    if (fd < 0) {
      _exit(126);
    }
    ioctl(fd, TIOCSCTTY, 0);
    dup2(fd, STDIN_FILENO);
    dup2(fd, STDOUT_FILENO);
    dup2(fd, STDERR_FILENO);
    if (fd > STDERR_FILENO) {
      close(fd);
    }
    // Nothing else from the parent may leak into the shell: no pty master, no
    // control/event pipes, no inherited descriptor at all.
    for (int candidate = 3; candidate < 256; candidate++) {
      close(candidate);
    }
    chdir(cwd);
    execve(shell, argv, envp);
    _exit(127);
  }
  return (int)pid;
}
