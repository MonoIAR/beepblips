# Security policy

## Supported versions

The latest version published on npm (`@monoiar/beepblips`) and the tip of `main`
receive fixes. Older versions are not maintained separately.

## Reporting a vulnerability

Use GitHub's private reporting: open the
[Security tab](https://github.com/MonoIAR/beepblips/security) and choose
**Report a vulnerability**. Please do not open a public issue first.

A useful report includes the version or commit, the text and options that trigger
the problem, and what you expected to happen.

## What counts

beepblips is a pure function library: it reads no files, opens no sockets, touches
no DOM, and never evaluates input as code. The realistic issues are therefore:

- crafted text or options that make `speak()` / `render()` allocate far more
  memory or run far longer than `maxDuration` suggests;
- the CLI writing somewhere other than the requested `--out` path;
- the demo page mishandling text in the DOM, or a code path that loads remote
  code.

Anything in those areas is worth a private report. There is no bug bounty; fixes
are shipped on a best-effort basis.
