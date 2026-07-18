# Releasing & auto-updates

Eric's app updates itself from **GitHub Releases**. You build a new version on
your PC, publish it, and his installed app downloads and installs it silently the
next time it's running. Only the **NSIS installer** self-updates — the portable
`.exe` cannot, so give Eric the installer.

> `package.json` is already set to publish to **github.com/slinnerb/cricket-calorie-tracker**
> (`build.publish.owner: "slinnerb"`). Just create that repo and you're set.

## One-time setup

1. **Create a GitHub repo** named `cricket-calorie-tracker` under your account and
   push this project. Either way works:

   **With GitHub Desktop (you have it):** File → *Add Local Repository…* → pick
   `C:\CricketCalorieCounterTracker` → it offers to *create a repository* → commit
   the files → *Publish repository* (leave "Keep this code private" **unchecked**).

   **Or with the git CLI:**
   ```powershell
   cd C:\CricketCalorieCounterTracker
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/slinnerb/cricket-calorie-tracker.git
   git push -u origin main
   ```
2. **Make the repo public.** Eric's app reads the release feed without logging in,
   so the releases must be public. (If you want the source private, create a
   separate public repo e.g. `cricket-releases` and set `build.publish.repo` to it.)
3. **Enable 2FA** on the GitHub account — the account is the entire trust root for
   auto-updates (the app is not code-signed).
4. **Create a fine-grained Personal Access Token** with **Contents: Read and write**
   on that repo. This is the `GH_TOKEN` used to publish (never commit it).
5. `npm install` (once).

## Every release

```powershell
cd C:\CricketCalorieCounterTracker
$env:GH_TOKEN = "github_pat_xxxxxxxx"   # this shell only; use setx to persist

npm run smoke            # sanity check — must print "SMOKE OK"
npm run test:store       # 30 store tests — must print "30 passed"

# bump version, tag, push, build the NSIS installer, and publish the GitHub Release:
npm run release:patch    # 1.0.0 -> 1.0.1   (bug fixes)
# npm run release:minor  # 1.0.0 -> 1.1.0   (new features)
# npm run release:major  # 1.0.0 -> 2.0.0   (big changes)
```

That one command bumps the version in `package.json`, commits + pushes the tag,
builds, and uploads the release.

### Verify the release
On the GitHub Releases page, the new release should contain **three** files:
- `Cricket Calorie Tracker Setup <version>.exe`  ← the installer
- `latest.yml`                                    ← the update feed (required!)
- `Cricket Calorie Tracker Setup <version>.exe.blockmap`

If `latest.yml` is missing, `GH_TOKEN` wasn't set — Eric's app won't see the update.

## Giving Eric the app (first time only)
Send him **`Cricket Calorie Tracker Setup <version>.exe`** from the Releases page
(not the portable one). On first run Windows SmartScreen may warn because the app
isn't code-signed — he clicks **More info → Run anyway** once. Every future
version installs automatically; he never downloads again.

## How updating works for Eric
- On launch (and every 6 hours) the app checks the GitHub feed.
- A newer version downloads in the background; a small **"Restart & update"**
  banner appears. Clicking it (or just quitting and reopening) installs it.
- Integrity is verified via the `sha512` in `latest.yml` — no code-signing needed
  for updates to be safe, though the first manual install shows SmartScreen.

## Notes
- Auto-update is disabled in `npm start`/`npm run dev` and for the portable build
  (by design). Test the real update flow with an installed NSIS build.
- Versions never go backwards (`allowDowngrade:false`).
- No internet / GitHub down → the check fails silently and the app runs normally.
