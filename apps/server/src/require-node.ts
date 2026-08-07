/**
 * Fail with a sentence, not a stack trace.
 *
 * The database is Node's built-in `node:sqlite`, which only exists without a
 * flag from Node 23.4. On anything older the first thing a new user sees is
 * `Cannot find module 'node:sqlite'`, which says nothing about what to do. This
 * runs before that import is evaluated, so they get the version instead.
 */
const MINIMUM = [23, 4] as const;

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const tooOld = major < MINIMUM[0] || (major === MINIMUM[0] && minor < MINIMUM[1]);

if (tooOld) {
  process.stderr.write(
    `\nUni Study needs Node ${MINIMUM[0]}.${MINIMUM[1]} or newer — you're on ${process.versions.node}.\n` +
      `It stores everything in Node's built-in SQLite, which isn't available before then.\n\n` +
      `  nvm install 24 && nvm use 24     (or: brew install node)\n\n`,
  );
  process.exit(1);
}
