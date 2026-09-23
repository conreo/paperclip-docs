/**
 * Path safety for corpus reads.
 *
 * `read_doc` and `list_docs` take a path from an *agent*. A corpus is a
 * directory tree on the server, so an unvalidated path is a filesystem read
 * primitive: `../../etc/passwd` or an absolute `/etc/passwd` would turn a
 * documentation tool into a credential-exfiltration tool. Every path therefore
 * passes through {@link resolveWithinRoot}, which is deny-by-default and fails
 * closed:
 *
 *   - the input must be a non-empty string with no NUL byte;
 *   - absolute paths are refused outright (`/etc/passwd`, `C:\Windows`, UNC);
 *   - any `..` segment is refused, *before* any join, so no amount of
 *     normalisation can be used to argue the result is inside the root;
 *   - the resolved path is checked to be lexically inside the root;
 *   - the path is then symlink-resolved and the *real* path is checked again, so
 *     a symlink inside the corpus cannot point outward. This includes a symlink
 *     in an ancestor directory, which is why the nearest existing ancestor is
 *     resolved rather than only the leaf.
 *
 * The reference CodeGraph plugin learned the last rule the hard way: a check
 * that validates the path *before* following symlinks is a check an attacker
 * steps around by making the last component a link.
 */

import fs from "node:fs";
import path from "node:path";

import type { PathRefusalCode } from "../constants.js";

export class PathRefusal extends Error {
  constructor(
    readonly code: PathRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "PathRefusal";
  }
}

/** True when `candidate` is `root` itself or lives underneath it. */
export function isContainedIn(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedRoot === normalizedCandidate) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolve a path as far as it exists, then re-append the part that does not.
 *
 * `fs.realpathSync` fails on a missing leaf, but a missing leaf is exactly the
 * "not found" case the caller wants to report cleanly. Resolving the nearest
 * existing ancestor still exposes an escaping symlink partway down.
 */
function realpathNearest(target: string): string {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length === 0 ? real : path.join(real, ...[...suffix].reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Turn a caller-supplied corpus-relative path into an absolute path inside
 * `root`, or throw {@link PathRefusal} naming the rule that refused it.
 *
 * `candidate` is typed `unknown` because it arrives from a tool argument and is
 * not trustworthy until this function has said so.
 */
export function resolveWithinRoot(root: string, candidate: unknown): string {
  if (candidate === undefined || candidate === null) {
    throw new PathRefusal("empty", "a corpus path is required");
  }
  if (typeof candidate !== "string") {
    throw new PathRefusal("not_a_string", "the corpus path must be a string");
  }

  const raw = candidate.trim();
  if (raw.length === 0) {
    throw new PathRefusal("empty", "the corpus path is empty");
  }
  if (raw.includes("\0")) {
    throw new PathRefusal("invalid_path", "the corpus path contains a NUL byte");
  }

  // Reject absolute paths in every form the three platforms use. A leading `/`
  // or `\` is all it takes to escape the root on POSIX; the drive and UNC forms
  // matter because a corpus directory can be served to a Windows worker.
  if (
    path.isAbsolute(raw) ||
    raw.startsWith("/") ||
    raw.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(raw)
  ) {
    throw new PathRefusal(
      "absolute_path",
      "absolute paths are refused; a corpus path must be relative to the corpus root",
    );
  }

  // Split on both separators, then refuse `..` *as a segment*. Checking the raw
  // string for ".." would also refuse a legitimate file named "v1..2.md".
  const segments = raw
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    throw new PathRefusal(
      "path_traversal",
      "`..` segments are refused; a corpus path may not leave the corpus root",
    );
  }
  if (segments.length === 0) {
    throw new PathRefusal("invalid_path", "the corpus path names no file or directory");
  }

  const resolved = path.resolve(root, ...segments);

  // Lexical containment. This holds by construction after the segment check, but
  // it is cheap and it is the check that survives a future edit to the rules
  // above, so it stays.
  if (!isContainedIn(root, resolved)) {
    throw new PathRefusal(
      "path_traversal",
      "the corpus path resolves outside the corpus root",
    );
  }

  // Physical containment, which is the check the lexical one cannot make: a
  // symlink *inside* the root can still point outside it.
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const realTarget = realpathNearest(resolved);
  if (!isContainedIn(realRoot, realTarget)) {
    throw new PathRefusal(
      "symlink_escape",
      "the corpus path follows a symbolic link outside the corpus root",
    );
  }

  return resolved;
}
