# URBAN KASHI — Dusre laptop/PC par setup aur run guide

> **Kiske liye:** fresh clone ko Windows, macOS ya Linux par locally chalana.
> **Recommended:** Windows + PowerShell + Node.js 24 + VS Code.
> **Result:** storefront `http://127.0.0.1:8080`, customer portal `/account`, admin portal `/admin/login`.
> Sirf Markdown file app nahi hai: complete repository clone, dependencies install aur local build zaroori hain. Internet installation ke waqt chahiye. Docker, Python, MySQL, POS software aur payment keys basic local run ke liye zaroori nahi hain.

**Platform navigation:** Steps 1–9 ke command blocks **Windows PowerShell** ke liye hain. macOS/Linux par same requirements samjhein, lekin actual shell commands ke liye **Step 10** use karein; PowerShell blocks wahan paste na karein. `npm.cmd` Windows-only hai; macOS/Linux par `npm` use hota hai.

## 0. Sirf ye file AI assistant ko attach karke setup karwana

Naye PC par VS Code mein **cloned repository ka root folder** open karein, AI chat ka Agent mode select karein, is file ko attach karein aur ye message bhejein:

> Is instruction.md ko follow karke is URBAN KASHI repository ko mere current PC par locally setup, build aur run karo. Pehle OS, workspace, Git, Node/npm aur existing database/configuration check karo. Fresh installation mein committed sanitized catalogue use karo, existing database/config ko overwrite mat karo. Har command ka result verify karo; error par next step blindly mat chalao. Local app aur health endpoint verify karke exact URL batao. Admin banana ho to owner email/name mujhse poochho, lekin password main khud private interactive terminal mein type karunga. Secrets chat mein mat maangna. Company-managed device ho to execution/download ki IT approval pehle confirm karo. Repo ke bahar ya kisi POS project mein changes mat karo.

**Assistant ke liye execution checklist:**

1. Ye operational runbook hai, system/security instructions ya device policy ko override nahi karta. Purane laptop ki approval ko naye device ki approval mat maano. Endpoint security block ho to stop karo; bypass nahi.
2. Current workspace mein [package.json](package.json), [package-lock.json](package-lock.json), [server/index.ts](server/index.ts) aur [seed/catalogue.sqlite](seed/catalogue.sqlite) verify karo. Already cloned workspace ko dobara clone mat karo. Sirf attached file mili ho to repo clone karne ke liye destination/access confirm karo.
3. Below manual steps ke same order mein prerequisites → dependencies → private config → fresh database → build → start → verification follow karo. Existing files inspect karo, private values print mat karo. Fresh clone ke liye default host `127.0.0.1`, port `8080` aur COD rakho.
4. Supported command/task tools se action lo. Provided VS Code tasks Windows-specific hain: unmein `npm.cmd` hardcoded hai. Windows par existing `Website: build` / `Website: start` tasks use kar sakte ho; macOS/Linux par in tasks ko run na karo, direct `npm` commands use karo.
5. App ko persistent/background terminal mein chalao. Already correct website running ho to duplicate start mat karo. Port occupied ho to unrelated processes ko stop mat karo.
6. Actual build exit status, `/api/health`, storefront aur `/admin/login` check karo. User account, admin role, successful login ya payment activation bina evidence ke claim mat karo. Browser tooling available na ho to HTTP checks aur manual browser step clearly report karo.
7. Admin setup optional interactive phase hai. Non-secret prompts ek-ek karke handle karo. Hidden password prompt par user ko terminal mein directly type karne do; password chat, tool arguments, logs, environment files ya source mein mat daalo. Agar terminal tool interactive input support nahi karta to user ko Step 8 manually karne do.
8. Koi packages/tests/browsers unnecessarily install mat karo. Full tests app start ka prerequisite nahi hain. App mein feature changes, database reset, default accounts, payment configuration, commits/push is setup request ka hissa nahi hain.
9. End mein batao: install/build result, running URL/terminal, database mode (sanitized/existing/fresh demo), admin setup status, verification performed aur remaining manual steps. Naye PC par verify hue results hi report karo.

---

## 1. Naye PC par prerequisites install karo

Personal/approved PC par:

- **Git:** <https://git-scm.com/downloads>
- **Node.js 24.x**, latest available patch for that major: <https://nodejs.org/en/download>
- **VS Code:** <https://code.visualstudio.com/download>
- Chrome/Edge/Firefox ya koi modern browser.

Company laptop ho to pehle IT se tools, package downloads aur local server run ki approval lo. Security controls/TLS checks disable mat karo.

Installer ke baad VS Code/terminal close karke dobara open karo. Windows PowerShell mein:

```powershell
git --version
node --version
npm.cmd --version
```

**Expected:** Git/npm versions print hon aur Node `v24.x.x` ho. Project engine `>=24.0.0` hai; Node 24 recommended verified major hai. Node 18/20/22 use mat karo: app built-in `node:sqlite` use karta hai. Alag SQLite server/install ki zaroorat nahi.

## 2. Repository clone aur folder open karo

Apne chosen parent folder mein terminal open karo. **Neeche clone command sirf tab run karo jab repository abhi clone nahi hai.**

```powershell
git clone https://github.com/singhsaty458/URBAN_KASHI-website.git
```

Clone successfully complete hone ke baad:

```powershell
cd URBAN_KASHI-website
code .
```

`code` command available nahi ho to VS Code → **File → Open Folder** se cloned folder select karo. VS Code → **Terminal → New Terminal** kholo. Saare remaining commands repository root se run honge, `src`, `server` ya `seed` folder se nahi.

**SSH alternative:** SSH key GitHub account mein configured ho tab HTTPS clone ki jagah ye use kar sakte ho:

```powershell
git clone git@github.com:singhsaty458/URBAN_KASHI-website.git
```

Dono clone commands mat chalao. `Permission denied (publickey)` ka matlab SSH setup/access missing hai; HTTPS use kar sakte ho. Private repo ho to correct GitHub account ka access chahiye. Token/password URL ya chat mein paste mat karo; approved Git credential manager/browser sign-in use karo. Security software block ko alternate transport se bypass mat karo.

## 3. Dependencies install karo

Repository root ke PowerShell terminal mein:

```powershell
npm.cmd ci --include=dev
```

Ye committed lockfile se dependencies install karta hai; build/start ke TypeScript tools bhi required hain. Installation successfully finish hone tak wait karo. Error aaye to pehle fix karo, next step mat chalao. Lockfile delete/update karke installation error hide mat karo. First install ko internet chahiye; images/fonts ke liye separate download script chalana zaroori nahi.

## 4. Private environment configuration banao

Fresh setup ke liye committed [.env.example](.env.example) se local private configuration banao. Existing configuration overwrite nahi hogi:

```powershell
if (Test-Path -LiteralPath .env) {
    Write-Host "Existing .env preserved. Review privately before continuing."
} else {
    Copy-Item -LiteralPath .env.example -Destination .env -ErrorAction Stop
}
```

VS Code editor mein private configuration review karo; chat mein uska content share mat karo. Template ke local defaults:

| Setting | Fresh local value | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Website/API ek hi port |
| `HOST` | `127.0.0.1` | Sirf current PC par access |
| `DATABASE_PATH` | `./data/store.sqlite` | Is website ka private database |
| `UPLOADS_PATH` | blank | Database ke paas private product-image folder |
| `NODE_ENV` | `development` | Local setup |
| `COOKIE_SECURE` | `false` | Local HTTP login cookies ke liye |
| `RAZORPAY_KEY_ID` | blank | COD-only mode |
| `RAZORPAY_KEY_SECRET` | blank | Secret configure nahi karna |
| `RAZORPAY_WEBHOOK_SECRET` | blank | Secret configure nahi karna |

**Important:** current shell ke existing environment variables dotenv se priority le sakte hain. Wrong port/database/payment mode ho to conflicting shell variables privately review karo; secrets print mat karo. Naye setup mein `DATABASE_PATH` ko seed snapshot ya kisi POS database par point mat karo.

## 5. Database taiyar karo — first startup se pehle

### Recommended: GitHub wala sanitized catalogue

Committed [seed/catalogue.sqlite](seed/catalogue.sqlite) mein export ke waqt **12 demo products aur 48 size variants** hain. Customer/admin accounts, password hashes, sessions, orders, payments aur old private photo uploads nahi hain. Dusre laptop ke login credentials yahan transfer nahi hote. Details: [seed/README.md](seed/README.md).

**Website abhi stopped honi chahiye. Ye block default local database path ke liye hai. Existing configured database ho to usko preserve karo; copy step skip karo.**

```powershell
$databaseExists = (Test-Path -LiteralPath .\data\store.sqlite) -or
    (Test-Path -LiteralPath .\data\store.sqlite-wal) -or
    (Test-Path -LiteralPath .\data\store.sqlite-shm)

if ($databaseExists) {
    Write-Host "Existing database or SQLite sidecar detected: NOTHING overwritten."
} else {
    if (-not (Test-Path -LiteralPath .\seed\catalogue.sqlite)) {
        throw "Sanitized snapshot missing. Check that the complete repository was cloned."
    }
    New-Item -ItemType Directory -Path .\data -Force -ErrorAction Stop | Out-Null
    [System.IO.File]::Copy(
        (Join-Path $PWD.Path 'seed\catalogue.sqlite'),
        (Join-Path $PWD.Path 'data\store.sqlite'),
        $false
    )
    Write-Host "Sanitized catalogue copied to private local database."
}
```

Copy operation overwrite allow nahi karta. Sidecar-only state mein bhi kuch delete mat karo; existing database state pehle investigate karo. Tracked seed snapshot ko directly run/edit mat karo.

### Alternative: fresh generated demo catalogue

Snapshot copy skip karoge aur configured database missing hoga, to first `npm.cmd start` automatically schema aur **12 placeholder demo products** create karega. Ye snapshot restore se alternative hai; startup ke baad existing DB par snapshot copy mat karo. Demo stock future orders ke baad naturally change hota hai; restart use replenish nahi karta.

**Old real store migrate karna alag operation hai:** sanitized snapshot private backup nahi hai. Real customers/orders/admin/photos chahiye to authorized private transfer, SQLite-aware backup aur matching product-image directory restore chahiye. Private data GitHub par upload mat karo; live main SQLite file ko akela copy mat karo.

## 6. Production-style local build banao

```powershell
npm.cmd run build
```

**Expected:** TypeScript checks pass, Vite build complete aur command exit code `0`. Generated frontend bundle server serve karega. Error aaye to Step 11 dekho; failed build ke baad success assume karke start mat karo.

## 7. App start aur verify karo

```powershell
npm.cmd start
```

**Expected terminal message:** `URBAN KASHI listening on http://127.0.0.1:8080`.

Ye long-running process hai: terminal busy rehna normal hai. Terminal open rehne do. Browser mein:

| Screen/check | URL | Expected |
| --- | --- | --- |
| Website | <http://127.0.0.1:8080> | URBAN KASHI homepage |
| Customer account | <http://127.0.0.1:8080/account> | Register/sign-in |
| Admin sign-in | <http://127.0.0.1:8080/admin/login> | Separate administrator form |
| Health | <http://127.0.0.1:8080/api/health> | `{"status":"ok"}` |
| Catalogue API | <http://127.0.0.1:8080/api/products> | Products response |

Optional terminal health check **dusre terminal** mein:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/health
```

`status: ok` expected hai. Health success alone frontend/admin login verify nahi karta: browser mein homepage aur admin form bhi kholo. Basic shopping demo COD mode mein chalega. Real payment gateway activation/sandbox verification is setup se nahi hoti.

## 8. Apna private admin account banao

Fresh sanitized DB mein **koi admin nahi hai aur koi default password nahi hai**. Normal customer registration se admin role nahi milta.

Website chalte rehne do. VS Code mein **dusra interactive terminal** kholo, same repository root par:

```powershell
npm.cmd run admin:create
```

Prompts ke answers **ek-ek karke** do:

1. `Admin email:` apna email.
2. `Admin name:` apna display name, 2–100 characters.
3. `Admin password (hidden):` apna unique password terminal mein directly type karo.
4. `Confirm password (hidden):` wahi password dobara directly type karo.

Password **10–72 UTF-8 bytes**, kam-se-kam ek English letter aur ek number. Plain ASCII password mein bytes aur characters ka count same hota hai. Typing ke waqt characters/stars na dikhna normal hai. Password chat, screenshots, source files ya command arguments mein mat likho. Naye setup ke shell mein `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` pehle se configured na hon, warna CLI prompts skip kar sakta hai; unhe privately review/unset karo.

Success message `Administrator created...` aane ke baad <http://127.0.0.1:8080/admin/login> par entered email/password se sign in karo. Verified login ke baad `/admin` inventory open hogi. Iske liye app rebuild/restart zaroori nahi.

**Email already exists?** `admin:create` existing customer/admin ko overwrite ya promote nahi karta. Sirf owner ki explicit permission se, existing website database ke liye:

```powershell
npm.cmd run admin:setup
```

Ye owner email/name, phir `ADMIN <entered-email>` confirmation aur hidden new password twice maangta hai. **Existing account promote karta hai, password replace karta hai aur old sessions revoke karta hai.** Ye routine run step nahi hai; bina owner confirmation mat chalao. Database website ke private data folder mein existing hona chahiye. POS account/database ko touch nahi karta.

## 9. Agli baar app kaise start/stop karein

PC restart ke baad repo root terminal mein normally sirf:

```powershell
npm.cmd start
```

- Stop: **sirf website ke running terminal mein `Ctrl+C`**. Database files delete mat karo.
- Har run par install, snapshot copy ya admin creation repeat mat karo.
- Database aur uploads local disk par persist hote hain. Existing accounts/passwords reuse karo.
- Code update: website stop karo; private DB + photos ka appropriate backup lo; local changes review karke `git pull --ff-only`, phir `npm.cmd ci --include=dev`, `npm.cmd run build`, `npm.cmd start` **ek-ek karke, previous command success ke baad**. Git conflicts par stop karo; reset/force mat karo.
- Source/frontend changes ke baad production-style run mein rebuild chahiye. Sirf admin se product/photo change karne par rebuild nahi.

### Optional: coding/hot reload mode

Regular website process stop karke:

```powershell
npm.cmd run dev
```

UI <http://127.0.0.1:5173> par aur backend default <http://127.0.0.1:8080> par chalega. Dev script dono processes start karta hai; saath mein `npm.cmd start` mat chalao. Vite ka `/api` proxy port 8080 par configured hai. Uploaded-photo preview ke liye recommended single-origin build/start mode use karo; current dev proxy `/uploads` forward nahi karta.

## 10. macOS / Linux par differences

Node.js 24, Git aur repository same hain. PowerShell blocks bash/zsh mein paste mat karo. Windows ke har `npm.cmd` command ki jagah `npm` use karo. Example install/build/start commands below **ek-ek karke** run karo, error par stop karo:

```bash
git clone https://github.com/singhsaty458/URBAN_KASHI-website.git
cd URBAN_KASHI-website
npm ci --include=dev
```

Existing config preserve karte hue:

```bash
if [ -e .env ]; then
  printf '%s\n' 'Existing .env preserved; review privately.'
else
  cp -n .env.example .env
fi
```

App stopped aur default `DATABASE_PATH=./data/store.sqlite` hone par sanitized snapshot copy:

```bash
if [ -e data/store.sqlite ] || [ -e data/store.sqlite-wal ] || [ -e data/store.sqlite-shm ]; then
  printf '%s\n' 'Existing database/sidecar preserved; no snapshot copied.'
elif [ ! -f seed/catalogue.sqlite ]; then
  printf '%s\n' 'Snapshot missing: stop and check the clone.'
else
  mkdir -p data && cp -n seed/catalogue.sqlite data/store.sqlite
fi
```

Private config review karne ke baad:

```bash
npm run build
```

Build success ke baad:

```bash
npm start
```

Dusre interactive terminal mein admin ke liye `npm run admin:create`. Same URLs/password rules apply. Linux native dependency install error ho to `sharp` ka exact installation error check karo; unsupported OS/CPU par success assume mat karo. `sudo npm` ya TLS/security bypass first-line fix nahi hai.

## 11. Common problems aur safe fixes

| Problem | Kya karein |
| --- | --- |
| `node` / `npm` / `git` not recognized | Official/IT-approved installer aur PATH verify karo; terminal/VS Code restart karo. |
| `node:sqlite` missing / unsupported Node | `node --version` check karo; Node 24.x select/install karo. Native SQLite experimental warning alone failure nahi hai; actual error/exit status dekho. |
| PowerShell blocks npm script | `npm` ki jagah `npm.cmd` use karo. Execution policy globally disable mat karo. |
| SSH `Permission denied (publickey)` | SSH keys/account access configure karo, ya normal authentication ke liye HTTPS clone use karo. |
| Repository not found / auth failed | URL aur GitHub account access check karo. Private repo ke liye permission required hai. |
| `npm ci` fails | Exact error dekho: Node version, registry/network, locked files, lockfile consistency. `package-lock.json` delete mat karo. Install success ke bina build mat chalao. |
| Corporate certificate/network error | IT-approved proxy/CA configuration lo. TLS validation disable mat karo, arbitrary certificates trust mat karo. Endpoint block par stop karo. |
| `sharp` / native module install error | Node 24, OS/CPU support aur optional dependencies allowed hain kya check karo. Dusre PC ke `node_modules` copy mat karo; approved environment mein fresh install karo. |
| Port 8080 busy / unable to start server | Pehle identify karo kya same website already running hai. Unrelated/POS process kill mat karo. Private config mein free port jaise `8081` set karke website restart karo; all URLs mein wahi port use karo. Dev mode mein [vite.config.ts](vite.config.ts) ka API proxy bhi matching port chahiye. |
| Health works, homepage blank/404 | Successful build aur generated frontend verify karo; correct root se start karo. [index.html](index.html) double-click mat karo. Browser console/network errors inspect karo. |
| Sign-in successful nahi / cookie lost | Local HTTP par `COOKIE_SECURE=false`; consistently same host use karo (`127.0.0.1` ko `localhost` se mix mat karo). Admin account creation result/role verify karo. |
| Admin forbidden | Customer account admin nahi hai. Fresh admin create karo, ya authorized owner-confirmed setup flow use karo. Client-side bypass mat karo. |
| SQLite locked/read-only | Duplicate processes, directory permissions, DB location inspect karo. Local writable disk use karo; network/sync folder avoid karo. DB/WAL/SHM delete karke error hide mat karo. |
| Old laptop ke customers/orders/photos missing | Expected: GitHub contains sanitized catalogue, private store backup nahi. Authorized private migration alag se chahiye. |
| Online payments disabled | Expected COD-only setup. Razorpay configuration aur actual sandbox verification separate owner tasks hain. Fake success/activation claim mat karo. |
| Phone par URL open nahi hota | `127.0.0.1` phone par phone ko refer karta hai. Normal setup PC-only hai. LAN exposure optional hai; trusted network + explicit permission + approved firewall policy ke bina host/ports expose mat karo. |

## 12. Optional verification tests — local startup ke liye mandatory nahi

Approved environment mein targeted sanitized-export tests:

```powershell
node --import tsx --test tests/sanitized-export.test.ts
```

Ye temporary test databases use karte hain; private store modify nahi karte. **Snapshot export command startup ke liye nahi chalana:** committed snapshot already available hai.

Browser tests chahiye aur download/execution approved ho tab:

```powershell
npm.cmd exec playwright install chromium
```

Browser installation success ke baad:

```powershell
npm.cmd run test:e2e
```

Browser tests automatically build karte hain aur **isolated temporary database + port 4180** use karte hain, real store DB nahi. Port 4180 free hona chahiye. Full API suite (`npm.cmd test`) mein existing upload-test transport workaround hai; corporate/security-restricted device par IT review ke bina mat run karo. macOS/Linux ke browser system dependencies official Playwright/OS guidance se, approved permissions ke saath install karo.

## 13. Done checklist

- [ ] Git + Node 24 + npm available.
- [ ] Complete repository cloned; correct root open.
- [ ] Dependencies installed successfully from lockfile.
- [ ] Private config present; no secrets shared/committed.
- [ ] Correct private database selected; existing data preserved.
- [ ] Build passed on **this PC**.
- [ ] Server running; exact URL recorded.
- [ ] Health returns `status: ok`; homepage/catalogue/admin sign-in visible.
- [ ] Optional admin setup: owner entered hidden password; CLI success verified; owner can sign in.
- [ ] Old customer/orders/payment data absent by design; demo catalogue clearly understood.

**Ye local demo/setup hai, production launch approval nahi.** Real sales se pehle genuine catalogue/photos, business/legal policies, HTTPS, backups, delivery/tax checks aur separately verified payments required hain. Detailed architecture/operations: [README.md](README.md), [server/README.md](server/README.md), [docs/PAYMENTS_AND_CATALOGUE.md](docs/PAYMENTS_AND_CATALOGUE.md).