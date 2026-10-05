# Aegis deployment checklist

Follow these steps in order. Commands are run in the extracted **`aegis` project directory** unless a step says otherwise. Replace `YOUR-OWNER`, `YOUR-PROJECT`, and identity placeholders with your actual values; do not include angle brackets. `YOUR-OWNER` can be your GitHub username or your team's organization name.

**Prepared October 5, 2026.** Dashboard labels and plan restrictions can change; official references are at the end. This is a static Next.js frontend with no application backend, database, API keys, or secret environment variables. Your team performs the account actions and deployment. No repository or hosted deployment has already been created.

**Release gate:** the authoring environment could not install external dependencies or run a full Next.js build. Run the commands below and do not submit until they pass. Source-component browser checks are not a substitute for this gate.

## 1. Install Node.js LTS and Git; verify your terminal

Use **one** operating-system path. A native Windows install and WSL are separate environments; do not mix their Node installations or `node_modules` directories.

### Windows

Open https://nodejs.org/en/download/ and select **Node.js 24 LTS -> Windows -> Installer (.msi)**, choosing your machine's architecture. Run the installer with the default PATH option. There is no need to select optional native build tools for this prototype.

Open https://git-scm.com/install/windows and install Git for Windows. Keep Git available from the command line and enable Git Credential Manager. Restart your terminal after both installations.

With Windows Package Manager already available, the installer alternative is:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --source winget
winget install --id Git.Git --exact --source winget
```

Open a **new PowerShell** window:

```powershell
node --version
npm.cmd --version
git --version
```

Use `npm.cmd` in place of `npm` throughout this guide if PowerShell says `npm.ps1 cannot be loaded`. This avoids weakening the machine's script-execution policy. Similarly, `npx.cmd` substitutes for `npx`.

### macOS

Install the **Node.js 24 LTS macOS .pkg** for your architecture from https://nodejs.org/en/download/. In Terminal, install Apple's command-line tools, which include Git:

```sh
xcode-select --install
```

Complete the system dialog, then open a new Terminal. A message saying the tools are already installed is fine. If Homebrew is already installed, `brew install git` is an alternative Git installation; Homebrew is not otherwise required.

### Linux (Ubuntu / Debian example)

Install Git and prerequisites. Use a user-level Node version manager rather than `sudo npm install`:

```sh
sudo apt update
sudo apt install -y git curl ca-certificates xz-utils unzip
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh -o /tmp/nvm-install.sh
less /tmp/nvm-install.sh
```

Review the script; press `q` to leave `less`. After accepting its source:

```sh
bash /tmp/nvm-install.sh
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
nvm alias default 24
```

On other Linux distributions use the distribution's package manager for Git, curl, and certificates; the nvm steps are the same in a supported POSIX shell. Source: https://github.com/nvm-sh/nvm.

### All operating systems

```sh
node --version
npm --version
git --version
```

Expected: Node **v24.x**, an npm version, and a Git version. The project also supports Node 22.16+ for its TypeScript test runner. The supplied `.nvmrc` selects Node 24.

**When a step fails:** `command not found` usually means the terminal has not been restarted or the install is not on PATH. Reopen it. Use `where.exe node` on Windows or `command -v node` on macOS/Linux to find an older installation. Do not solve corporate TLS/proxy failures by disabling certificate verification; use your administrator-approved setup or an approved network.

## 2. Run locally and rehearse the real webcam

Extract `aegis-prototype.zip`. Open a terminal **inside the `aegis` folder that contains `package.json`**. On Windows, right-click that folder and choose **Open in Terminal**; on macOS/Linux, use Terminal and `cd` to it. Avoid starting one directory above the package.

```sh
npm install
npm run assets
npm run dev
```

Open **http://localhost:3000** directly in a current Chrome browser, not in an embedded IDE preview. Allow the initial asset download to finish. Visit **Verification**, check the webcam-consent box, click **Enable webcam**, and accept the browser's Camera permission. The optional color check starts disabled; enable it only when comfortable with changing colors. Keep your face well lit and follow the head-turn, blink, and digit prompts. Mouth motion is not digit recognition. An ordinary live session ends in **step-up by design**.

Also test **Attack lab -> Run simulated scenario**. The four expected outcomes are normal 7/approve, replay 73/reject, virtual-camera 31/step-up, and deepfake 67/reject. They are fictional scores, not real attack measurements.

Stop the dev server with `Ctrl+C`, then run the release checks:

```sh
npm run typecheck
npm test
npm run build
npm run start
```

Open http://localhost:3000 again. This serves the real static export **with the production headers**; repeat the camera test here. This catches CSP/WASM problems that `next dev` alone may miss. Stop it when finished.

Optional automated browser checks, after the build:

```sh
npx playwright install chromium
npm run test:browser
```

Linux machines missing browser system libraries can use `npx playwright install --with-deps chromium`, subject to their administrator's package-installation policy. The tests check desktop and mobile Chromium layouts, not physical phone cameras.

**Keep `package-lock.json`:** your first successful installation generates it. Commit it in step 3. Later clean installations should use `npm ci` instead of `npm install`. Run `npm audit` and review any findings before submission; do not automatically force major updates.

### Local recovery

| Symptom | What to do |
| --- | --- |
| `ENOENT ... package.json` | You are in the wrong folder. Change into the extracted `aegis` folder. |
| Port 3000 is busy | Stop the old process or run `npm run dev -- --port 3001`, then open http://localhost:3001. For a production preview use `npm run start -- --port 3001`. |
| PowerShell blocks npm/npx scripts | Use `npm.cmd` / `npx.cmd`; do not disable system execution protections. |
| Camera denied | Address-bar site controls -> Camera -> Allow; reload and start a fresh session. Check OS privacy settings too: Windows Settings -> Privacy & security -> Camera; macOS System Settings -> Privacy & Security -> Camera. |
| Camera busy or black | Close Zoom/Teams/other camera tabs; confirm the OS camera app works; use a supported physical camera; retry. |
| Camera API absent | Use localhost or an HTTPS deployment. A phone opening `http://192.168.x.x:3000` is not localhost and ordinarily cannot use the camera. |
| Landmarks unavailable | Check DevTools Network for `/models/face_landmarker.task` and `/mediapipe/wasm/*`; run `npm run assets`, restart, and use the local static preview to test production headers. No model failure is converted into a pass. |
| Browser freezes or runs slowly | Close other intensive tabs, retry on a desktop, or use the labeled attack lab. Main-thread inference is a prototype limitation. |
| Session cancels when switching tabs | Expected privacy behavior. Return and start a new session; do not leave a live session running while presenting another tab. |
| npm certificate/registry error | Check `npm config get registry`, proxy policy, and approved network access. Do not set `strict-ssl=false`. |
| `npm ci` says no lockfile | Use `npm install` once, commit the generated lockfile, then return to `npm ci`. |

### Model-download recovery

The production build intentionally fails if the face-landmark assets are unavailable. Retry `npm run assets`. On a network that permits the official Google model URL, download the same version manually:

Windows PowerShell:

```powershell
Invoke-WebRequest -Uri "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" -OutFile "public/models/face_landmarker.task"
npm.cmd run assets
```

macOS/Linux:

```sh
curl --fail --location "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" --output public/models/face_landmarker.task
npm run assets
```

The script copies WASM from the installed, pinned npm package. Do not download a model from an untrusted mirror. A printed SHA-256 records the bytes you received; it is **not** verification against a separately authenticated upstream digest. The generated model/WASM files are ignored by Git and recreated during deployment. For a network-isolated team, arrange an approved, license-reviewed asset distribution process before changing this behavior.

## 3. Create an empty GitHub repository and make the first commit

Sign in at https://github.com. Choose **+ -> New repository**. Select your **personal account** or your **team organization** in the Owner menu. Name it **`aegis-presence`**. A useful description is: `Browser-only layered presence-verification prototype with explicit simulated signals.`

Choose **Public** when the hackathon allows it. With a private repository, plan explicit judge access and check Vercel's organization/private-repository restrictions in step 6. **Do not** initialize the remote repository with a README, .gitignore, or license: these already exist in your local project. Click **Create repository**.

Back in the project terminal, identify your commits. Use an email associated with your GitHub account, or copy your exact GitHub-provided no-reply email from **GitHub Settings -> Emails**. A guessed no-reply address can cause author-linking problems in Vercel.

```sh
git config --global user.name "YOUR NAME"
git config --global user.email "YOUR VERIFIED OR GITHUB NO-REPLY EMAIL"
git init
git status --short
git add .
git diff --cached --name-only
git diff --cached
```

Review what is staged. Press `q` if Git opens a pager. The included `.gitignore` excludes dependencies, build output, Vercel metadata, `.env*` secrets except the empty example, generated models/WASM, test reports, and temporary files. It deliberately does **not** ignore `package-lock.json`.

```sh
git commit -m "feat: add Aegis browser-only verification prototype"
```

**When a step fails:** Git's "Please tell me who you are" means the two identity commands need your actual values. An unavailable organization in the Owner menu means you need permission to create repositories there. Do not create a similarly named repository under the wrong owner without coordinating with the team. If you accidentally staged a secret, run `git restore --staged PATH-TO-FILE`, fix the ignore rule, and rotate any exposed credential; ignoring a file does not remove it from existing history.

## 4. Authenticate, connect the remote, and push

Set the remote URL to the repository you just created:

```sh
git remote add origin https://github.com/YOUR-OWNER/aegis-presence.git
git branch -M main
git remote -v
git push -u origin main
```

### Authentication option A: browser login

Git Credential Manager, included with the standard Git for Windows installation, can open a GitHub browser login when you push. Complete the login with the account that owns or can write to the repo. A browser OAuth approval is preferable to manually handling a long-lived token.

With GitHub CLI installed from https://cli.github.com, this explicit browser-login route works across platforms:

```sh
gh auth login --hostname github.com --git-protocol https --web --scopes workflow
gh auth setup-git
gh auth status
git push -u origin main
```

The additional `workflow` scope is needed for uploading `.github/workflows/ci.yml` through an OAuth/classic-token flow. Do not use `--insecure-storage`; check the credential-store location reported by `gh auth status`, especially on Linux machines without a keychain. [Authentication reference: https://cli.github.com/manual/gh_auth_login]

### Authentication option B: personal access token

When a terminal asks for an HTTPS password, use a **GitHub personal access token**, not your account password. In GitHub choose **Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens -> Generate new token**. Give it a short expiration, select the correct personal/organization resource owner, restrict repository access to this repo, and grant **Contents: Read and write** plus **Workflows: Read and write** for the included CI file. Metadata read permission is included automatically. Organization approval or SSO authorization may be required.

Copy the token into the password prompt. Do not put it in the remote URL, a shell command, `.env`, chat, README, or a screenshot. Use an OS credential manager rather than `credential.helper store`, which writes plaintext credentials. Revoke the token after the hackathon when no longer needed. If your organization does not permit fine-grained tokens for your role, follow its approved OAuth/SSO authentication method instead of creating broader tokens to bypass policy.

### Push recovery

| Error | Safe recovery |
| --- | --- |
| `remote origin already exists` | Inspect `git remote -v`; correct it with `git remote set-url origin https://github.com/YOUR-OWNER/aegis-presence.git`. |
| `src refspec main does not match any` | Confirm the first commit exists with `git log -1`; run `git branch -M main` and push again. |
| `Repository not found` / 403 | Check spelling, owner, collaborator invitation, authenticated account, token repo permissions, and organization SSO/approval. |
| Workflow-file upload refused | Add the scoped Workflows write permission, or refresh the CLI OAuth authorization: `gh auth refresh -h github.com -s workflow`. |
| Non-fast-forward, existing shared history | Run `git fetch origin`, review differences, then `git pull --rebase origin main`; resolve conflicts and push. Never force-push `main`. |
| Unrelated histories because remote README was created | Prefer an empty new repo before teamwork starts. To preserve both histories, `git pull origin main --allow-unrelated-histories`, resolve any README conflict, commit, and push. Do not force overwrite teammates' work. |

Refresh GitHub and verify the source, README, lockfile, and CI file are visible. Check the **Actions** tab for the first workflow run.

## 5. Add teammates and use small branches

Personal repo: **Settings -> Collaborators** (under Access) **-> Add people**, enter each teammate's username, send the invite, and have them accept. Organization repo: **Settings -> Collaborators and teams / Manage access**, add the team or people with **Write** access. Organization policy may restrict invitations. Do not share GitHub passwords or tokens. [GitHub guide: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository]

Each teammate starts with:

```sh
git clone https://github.com/YOUR-OWNER/aegis-presence.git
cd aegis-presence
npm ci
git switch main
git pull --ff-only origin main
git switch -c feat/YOURNAME-small-task
```

After a focused change:

```sh
npm run typecheck
npm test
git add .
git diff --cached
git commit -m "feat: describe the focused change"
git push -u origin feat/YOURNAME-small-task
```

On GitHub choose **Compare & pull request**, target `main`, request a teammate's review, inspect the Vercel preview, and wait for **Frontend checks / validate** to pass. One release coordinator merges using **Squash and merge**. Split work by file ownership where possible: interface, landmark logic, policy/tests, and documentation. Announce shared CSS or lockfile changes before editing them.

If branch protection is available for your plan/repository, set **Settings -> Rules -> Rulesets -> New branch ruleset** for `main`: require a pull request, one approval, the validation check, and no force pushes. Otherwise enforce the same routine socially.

After a merge:

```sh
git switch main
git pull --ff-only origin main
git branch -d feat/YOURNAME-small-task
```

Delete the branch only after confirming its changes were merged. Squash merging can make `-d` refuse deletion; keep the local branch until the release coordinator confirms it is safe to remove. For a shared feature branch that is behind, `git fetch origin` then `git merge origin/main` avoids rewriting other people's history. Resolve `<<<<<<<` conflict markers, run the checks, commit, and push. Do not use force push as a conflict-resolution technique.

## 6. Deploy on Vercel: Git import, then the CLI alternative

### Recommended: GitHub integration

Open https://vercel.com and sign in with GitHub. Choose the correct personal/team workspace. Select **Add New -> Project -> Import Git Repository**. Authorize the Vercel GitHub app for this repo; your organization may need an administrator to approve that app. Click **Import** beside `aegis-presence`.

Confirm these values before **Deploy**:

| Setting | Value |
| --- | --- |
| Framework Preset | **Next.js** |
| Root Directory | Repository root (`./`) if `package.json` is at the root |
| Build Command | `npm run build` |
| Install Command | `npm ci` after committing your generated lockfile |
| Output Directory | `out` (configured in `vercel.json`; this is an intentional static export) |
| Environment Variables | None |
| Node.js Version | **24.x** |

If the import screen does not expose Node version, set it under **Project -> Settings -> Build and Deployment -> Node.js Version**, then redeploy. The project uses `output: "export"`; do not run a persistent `next start` process or invent a database configuration.

Wait until the deployment says **Ready**. Open **Visit** and copy the stable production domain, such as `https://YOUR-PROJECT.vercel.app`, from **Project -> Settings -> Domains**. Use this stable alias for the submission rather than an expiring/protected per-commit preview URL.

**Team/plan warning:** Vercel Hobby does not support private repositories owned by a GitHub organization. Commit-author access restrictions also depend on repository ownership and visibility: the private organizational-repository rule is not a blanket ban on collaborators on personal GitHub accounts, and public/fork pull requests have separate deployment-authorization behavior. Check the workspace plan and the specific Git integration rules before promising teammate auto-deploys or paying for an upgrade. Use a plan/workspace that supports your actual repository and collaborators. Do not spoof commit authors or share credentials. See https://vercel.com/docs/git; check billing before accepting any upgrade.

### Vercel CLI alternative

From the project directory, use a local ephemeral CLI install rather than requiring a global one:

```sh
npx vercel@latest login
npx vercel@latest link
npx vercel@latest
npx vercel@latest --prod
```

Complete browser login. During `link`, choose the correct account/team, choose an existing imported project or create the intended project, and use `./` as the directory. Review prompts before accepting defaults. A CLI deployment without `--prod` normally creates a preview **after a project's initial production deployment**; a brand-new project's first deployment is production. `--prod` explicitly targets production. The CLI prints the URL. The local `.vercel/` folder is ignored by Git.

**A CLI-only deployment is not proof that Git auto-deploy is connected.** In **Project -> Settings -> Git**, connect this repository and complete step 8. Avoid accidentally creating two Vercel projects, one through import and another through CLI.

### Deployment recovery

| Failure | Action |
| --- | --- |
| Repository not listed | Configure the Vercel GitHub app's selected-repository access; ask the organization administrator to approve it where required. |
| Missing `package.json` | Correct Root Directory. The repo should contain the contents of the extracted `aegis` directory, not an accidental extra nesting level. |
| Build error | Open deployment **Build Logs**; fix the first actual error locally using `npm run check`, commit the fix, and push. Do not suppress TypeScript errors to force a green deploy. |
| Model download / WASM failure | See step 2; confirm the build can reach the official model URL and installs lifecycle scripts. The required asset step must complete. |
| Dependency or Node mismatch | Use Node 24 locally and in Vercel; commit the lockfile; run `npm ci`; redeploy. Review current security advisories before updating pinned framework packages. |
| Live site 404 | Confirm `output: "export"`, `Output Directory: out`, correct root, and a successful build. Open `/`, `/verify/`, and `/admin/` directly. |
| Deployment blocked for author/plan | Verify Git email is linked to the teammate's GitHub/Vercel identity and that your plan/workspace permits this author and repository. Do not bypass organization policy. |
| Camera fails only in production | Check CSP/Permissions-Policy and model/WASM network responses. Reproduce with `npm run build` then `npm run start`. Do not remove security headers blindly. |

## 7. Check HTTPS, camera permissions, privacy, desktop, and phone

Open the deployed **HTTPS** URL directly on a desktop browser and a physical phone. Send the URL to the phone; a phone's own `localhost` is not your laptop. Do not demo inside an iframe, an in-app social browser, or an IDE preview.

Run a live session with explicit permission, then check cancel, restart, skip, no-camera, hidden-tab, and result states. The browser's camera indicator should stop when the session ends. Do not confuse a retained site permission with an actively running camera. Try Chrome on desktop/Android and Safari on iPhone; the actual device/model combination must be validated. When a browser cannot initialize landmarks, the UI must show unavailable evidence and step-up, not a pass.

In desktop DevTools **Network**, filter by Fetch/XHR and media, and verify that model/WASM requests go to your own origin and that the app is not sending video/audio uploads. In **Application**, verify the app has not written session data to localStorage/IndexedDB or introduced analytics cookies. Normal static asset requests and hosting request logs still exist.

Confirm all four attack fixtures work even when camera permission is denied. On the phone, inspect the landing page, prompts, result cards, and horizontally scrollable admin table. The optional slow colors should be skipped for anyone who could be uncomfortable; do not promise medical safety.

**When it fails:** use a top-level HTTPS URL; reset that site's Camera permission; check the phone's OS/browser permissions; close other camera apps; retry in the system browser. A browser/model failure is a known release gate. Use the labeled fixture demo as a presentation fallback, not as a claim that the webcam worked.

## 8. Confirm automatic production and preview deployments

In Vercel, **Project -> Settings -> Git** must show the intended connected GitHub repository. Then go to **Settings -> Environments -> Production -> Branch Tracking**, enter **`main`**, and **Save**. Leave production-domain auto-assignment enabled for a straightforward hackathon workflow.

Push a branch to exercise preview deployment:

```sh
git switch main
git pull --ff-only origin main
git switch -c chore/verify-preview
git commit --allow-empty -m "chore: verify preview deployment"
git push -u origin chore/verify-preview
```

Create a pull request. Check Vercel's **Deployments** page and the PR's checks/comment for a **Preview** URL. A provider may intentionally skip a build for an empty/no-effective-change commit; in that case make a small, useful documentation change and push it. If previews are protected, reviewers must have appropriate access.

After review, merge the PR into `main`; verify a new **Production** deployment becomes Ready and the stable domain serves it. Every allowed push/merge to the production branch should build production; other connected branches should create previews, subject to your plan's author/access rules. CI success and Vercel success are separate checks: require both before presenting. Source: https://vercel.com/docs/deployments/environments.

**When nothing deploys:** check the Git connection, GitHub app permissions, disabled auto-deploy or ignored-build settings, selected production branch, Vercel author/plan restrictions, and the GitHub PR checks. CLI deploys alone do not create this integration.

## 9. Put the real links in the README and submission

Edit the two placeholder lines near the top of `README.md`. Use the actual stable HTTPS production URL and actual GitHub owner/repository. Do not leave `YOUR-PROJECT` or `YOUR-OWNER` in a submission.

Use a branch, then review and merge:

```sh
git switch main
git pull --ff-only origin main
git switch -c docs/submission-links
```

After editing:

```sh
git add README.md
git commit -m "docs: add production and repository links"
git push -u origin docs/submission-links
```

Open and merge the pull request after checks pass. Paste the same URLs in the hackathon form, alongside the pitch, demo recording, and declared limitations. Suggested description: **"Aegis is a browser-only layered-presence prototype. Camera metadata and gesture/color checks are local, unvalidated heuristics; forensic-model scores, attack scenarios, and admin history are explicitly simulated."**

Record the deployed commit SHA (`git rev-parse HEAD` after pulling the merge) in your team submission notes so the demonstrated version is identifiable. Make sure the submission link is production, not a teammate-only preview.

**When a link is wrong:** update the README through another small PR and edit the submission before the deadline. Test links from a logged-out browser, not only a tab with team credentials.

## 10. Final pre-submission gate

- [ ] **Access:** the repo is public or judges have accepted explicit read access. Organization policy permits sharing. Source and README are visible without your team's personal account.
- [ ] **No secrets:** review tracked/staged files and commit history. `.env`, tokens, private keys, camera recordings, and generated private material must not be committed. `.gitignore` does not erase existing history. Revoke any exposed secret immediately and follow GitHub's history-removal procedure with the team.
- [ ] **Real build:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and the GitHub/Vercel checks pass on the exact submitted commit. `package-lock.json` is committed. Any audit findings have been reviewed.
- [ ] **Functional rehearsal:** the local production preview and deployed HTTPS site pass the desktop/phone camera, model, skip, cancellation, and result checks. Camera resources close. Unsupported browser cases are disclosed.
- [ ] **Honesty:** all fake/model/dashboard data remain labeled. No invented accuracy, certified security, verified independence, or real-time deepfake detection claim. A live step-up is expected, not hidden.
- [ ] **Judge access:** open the stable production URL in an **incognito/private window while logged out of Vercel**. It must show the product, not a Vercel login. Review **Settings -> Deployment Protection** and allow public access to this intentionally public demo's production environment, subject to team policy; keep previews protected where appropriate. See https://vercel.com/docs/deployment-protection.
- [ ] **Presentation:** README assumptions, sources, architecture, real/simulated table, setup, repository URL, and live URL are complete. Rehearse `docs/DEMO_SCRIPT.md`; have the labeled attack lab ready as a fallback. Pitch and 24-hour plan are attached or linked.
- [ ] **Freeze:** choose a release coordinator, stop risky changes before judging, note the last known-good Vercel deployment, and keep the stable URL in the form. A failed new deployment should not be "fixed" by weakening safeguards.

If a recent release is broken, use Vercel's deployment history to restore the last known-good deployment, and use a reviewed `git revert BAD-COMMIT-SHA` change to align the source with the restored behavior. Do not hard-reset or force-push a shared main branch during judging.

## Official references

Node downloads: https://nodejs.org/en/download/  
Git installation: https://git-scm.com/install/  
Next.js setup: https://nextjs.org/docs/app/getting-started/installation  
GitHub CLI login: https://cli.github.com/manual/gh_auth_login  
GitHub token permissions and authorization: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens  
GitHub sensitive-data removal: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository  
Vercel Git integration and author restrictions: https://vercel.com/docs/git  
Vercel GitHub integration: https://vercel.com/docs/git/vercel-for-github  
Vercel production branch setting: https://vercel.com/kb/guide/can-i-use-a-non-default-branch-for-production  
Vercel CLI login/deploy: https://vercel.com/docs/cli/login and https://vercel.com/docs/cli/deploy  
Camera HTTPS/localhost requirements: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
