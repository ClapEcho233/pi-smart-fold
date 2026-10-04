# AGENTS.md

Agent instructions for working in this repository (a pi coding-agent extension, TypeScript, no build step — `index.ts` is loaded directly).

## Commands

- `npm run check` — full check: link pi, typecheck, load-check, tests
- `npm run typecheck` — link pi, then `tsc -p tsconfig.json`
- `npm test` / `npm run test:sim` — unit / click-simulation tests
- `npm run link:pi` — link the locally installed pi runtime into `node_modules/` (once after a fresh clone; also run automatically by `typecheck`/`check`)

## No install-phase lifecycle scripts (deliberate — do not re-add)

`package.json` must not declare `preinstall`/`install`/`postinstall`. npm ≥ 11.4 warns about install scripts not covered by `allowScripts`, and npm 12 blocks them by default; v0.2.1 shipped `postinstall: node scripts/link-pi.mjs` and triggered that warning on every install/update. The link is dev-only (typecheck/load-check/tests): at runtime pi's jiti loader aliases `@earendil-works/*` imports to its own modules, so installed extensions never resolve them through `node_modules`.

## Lockfile discipline (required after touching package metadata)

`package-lock.json` must stay byte-consistent with `package.json`. Incident `688fb9a` fixed a stale lock (name/version left at `pi-smart-fold`/`0.1.1`, plus an `extraneous` Homebrew Cellar entry from pi 0.86.1 dev links) after a release bump forgot to regenerate it.

**Any change to `name`, `version`, or dependencies in `package.json` must include a regenerated lockfile in the same commit:**

```bash
npm install --package-lock-only --ignore-scripts
git diff --exit-code package-lock.json && echo LOCK-IN-SYNC   # must pass before committing
```

Verify (no local pi install needed):

```bash
node -e '
  const l = require("./package-lock.json"), p = require("./package.json");
  if (!(l.name===p.name && l.version===p.version
    && l.packages[""].name===p.name && l.packages[""].version===p.version
    && Object.keys(l.packages).every(k => k==="" || k.startsWith("node_modules/"))
    && !Object.values(l.packages).some(v => "extraneous" in v))) process.exit(1);
  console.log("lock OK")'
! grep -qE 'Cellar|extraneous' package-lock.json
```

### Never commit machine-local paths in the lockfile

The pi runtime is linked into `node_modules/` on demand by `scripts/link-pi.mjs` (resolves whatever `pi` is on PATH; run via `npm run link:pi`, or automatically by `npm run typecheck`/`npm run check`). It is **never** a lockfile dependency. If `npm install` (full, not `--package-lock-only`) records the linked package as an `extraneous` local-path entry (e.g. `../../opt/homebrew/Cellar/pi-coding-agent/<ver>/...`), remove that entry before committing, or regenerate with `--package-lock-only`, which ignores `node_modules` state.

## Git push over blocked SSH port 22 (this machine's network)

The local proxy blocks outbound SSH port 22, and the machine's global git config rewrites every `https://github.com/...` push to `git@github.com:...` (`url.git@github.com:.pushInsteadOf`), so both the configured remote and explicit HTTPS push URLs fail with `Connection closed by ... port 22`. Push over SSH on port 443 instead — the rewrite does not match this URL form:

```bash
git push ssh://git@ssh.github.com:443/ClapEcho233/pi-smart-fold.git main
git push ssh://git@ssh.github.com:443/ClapEcho233/pi-smart-fold.git vX.Y.Z
```

Alternatively `git config --global --unset url.git@github.com:.pushInsteadOf` and push plain HTTPS (the `gh` credential helper is configured), but prefer the non-invasive port-443 URL.

## npm publish requires browser OTP (headless-safe recipe)

`npm publish` on this account requires web-based OTP. In a non-TTY it exits immediately (`EOTP`) with the auth URL masked as `***`, and even under a PTY it sits at `Press ENTER to open in the browser...` without opening anything. Recipe that works (v0.2.3):

```bash
nohup script -q /tmp/npm-publish.typescript npm publish --access public > /tmp/npm-publish.log 2>&1 &
sleep 6
grep -o 'https://www.npmjs.com/auth/cli/[^"]*' /tmp/npm-publish.log   # full URL is in the raw log
open "$(grep -o 'https://www.npmjs.com/auth/cli/[^"]*' /tmp/npm-publish.log | head -1)"
```

Then wait for `+ @clapecho233/pi-smart-fold@X.Y.Z` in the log; the registry may take a few minutes to serve the new version (`npm view ... version`), and "Your package is being processed" is normal. Note: the auth URL printed to the PTY is also live in the debug log only in masked form — read the raw stdout log, not `~/.npm/_logs`.

## Release checklist

1. Bump `version` in `package.json`
2. `npm install --package-lock-only --ignore-scripts` and confirm only the intended lockfile lines changed (name/version, optionally `hasInstallScript`)
3. Update README compatibility note if the supported pi version changed
4. Commit `package.json` + `package-lock.json` together (README too if touched)
5. Push `main` and the `vX.Y.Z` tag over SSH port 443 (see "Git push over blocked SSH port 22")
6. `gh release create vX.Y.Z --title "vX.Y.Z — <summary>"` with install/upgrade notes
7. `npm publish --access public` via the browser-OTP recipe (see "npm publish requires browser OTP")
