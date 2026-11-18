# Vaulten TCG – napi árdiagram-adatok

Az ingyenes Cloudflare Worker naponta **01:13, 07:13, 13:13 és 19:13 UTC-kor** indítja ennek az adattárnak a GitHub workflow-ját az árdiagram-adatok forrásának ellenőrzésére. A visszaállítható Worker-kód, a pontos jogosultságok és a tokenmegújítás leírása a [scheduler/](scheduler/README.md) mappában található. Egyetlen ismétlődő óra működik; a GitHub natív cronja nincs bekapcsolva. Csak új forrásgeneráció esetén készül ellenőrzött adatcsomag és Cloudflare Pages-publikáció. A négy indítási lehetőség csökkenti egy kimaradó vagy késő forrásfrissítés hatását. A Shopify weboldal a publikus JSON-fájlokat olvassa. A futás nem módosít Shopify-t, és nem tartalmaz fizetős vagy minősítettkártya-adatforrást.

## Egyszeri beállítás

1. Hozz létre saját **nyilvános GitHub repositoryt**, és ennek a mappának a tartalmát töltsd a gyökerébe. A `scripts/incremental.cjs` és a teljes `seed/` mappa is szükséges. A public repo kódja és a történeti ár-adatcsomag nyilvános; semmilyen kulcsot ne adj hozzá fájlban.
2. Ingyenes Cloudflare-fiókban hozz létre egy **Pages Direct Upload** projektet. A production branch egyezzen a GitHub alapértelmezett ágával (általában `main`). Nem kell a Shopify domaint átköltöztetni: a projekt `https://<projekt>.pages.dev` címe használható.
3. GitHub → Settings → Secrets and variables → Actions:
   - **Secrets:** `CF_ACCOUNT_ID`, `CF_API_TOKEN`. A token csak a megfelelő Cloudflare-fiók **Cloudflare Pages: Edit** jogosultságát kapja.
   - **Variables:** `CF_PAGES_PROJECT` = pontos Pages-projektnév; `HISTORY_BASE_URL` = a tényleges publikus HTTPS-origin, útvonal és query nélkül. Opcionális `CF_PAGES_BRANCH` csak akkor kell, ha a Pages production branch eltér a repo alapértelmezett ágától.
4. Engedélyezd az Actions futtatását és a workflow számára a repository tartalmának írását. Branch protection esetén tedd lehetővé a bot auditmanifest-commitját; ne használj force push-t.
5. Actions → **Daily verified card-price history** → Run workflow, első alkalommal `bootstrap=true`. A seed minden fájlja SHA-256 ellenőrzést kap. Később ezt hagyd `false` értéken: a rendszer a Cloudflare-en már közzétett manifestből és shardokból folytatja.
6. Sikeres futás után a publikus `/vaulten-history-manifest.json` és az adatfájlok ellenőrzése is lefut. A `data/latest-manifest.json` commit a tényleges publikált adatgeneráció másolata. A Shopify loader adatcímét egyszer erre az originre kell beállítani; a napi futáshoz nem kell Shopify-kulcs.
7. Az automatikus indításhoz a [külön Cloudflare Worker](scheduler/README.md) szükséges. A napi négy cronhoz csak az adott repo Actions read/write jogosultságú GitHub-token kerül titkosított Worker Secretbe. Tartsd aktívan a GitHub workflow-t: a Cloudflare `workflow_dispatch` eseménnyel hívja, és ugyanaz az esemény szolgál kézi helyreállításra is.

A működő telepítés nyilvános adatai: [Vaulten árarchívum](https://vaulten-tcg-history.pages.dev/vaulten-history-manifest.json). A futások és az indítás típusa a repository Actions lapján követhetők.

## Működés és hibakezelés

- Normál futásnál az előző publikus manifest és **minden** szükséges adatfájl méretét, csomagolt SHA-256-át és kibontott SHA-256-át ellenőrzi. A manifest csak teljes ellenőrzés után kerül a bemeneti mappába.
- Hálózathibánál, sérült adatnál vagy visszalépő forrásdátumnál leáll. Nem esik vissza automatikusan a régi seedre.
- Csak új upstream adatgenerációnál készít publikálandó kimenetet. Változatlan forrásnál nincs deploy és nincs mesterséges „életben tartó” commit.
- Kivétel a tudatos, kézi `redeploy=true`, `bootstrap=false` futás: ez az összes már publikált árfájl ellenőrzése után ugyanazokat a bájtokat telepíti újra a jelenlegi Pages Functions kóddal. Nem kér árakat a TCGCSV-től, nem módosít árakat vagy adatdátumokat, és az ütemezett futások nem kapcsolhatják be. Használd külön Functions-kódfrissítés közzétételéhez.
- A build és ellenőrzés után a teljes Pages-deployment egyben kerül publikálásra. Letöltési/build/validálási hiba esetén a korábbi webes adatcsomag marad meg. Ha a publikálás utáni HTTP-ellenőrzés hibás, nem készül auditcommit; az Actions hibát jelez, a Pages deploymentet ellenőrizni kell, és szükség esetén az előzőre visszaállítani.
- Közvetlenül a deploy előtt a Cloudflare API ellenőrzi, hogy a projekt `production_branch` értéke egyezik-e a `CF_PAGES_BRANCH` beállítással. Eltérésnél a futás leáll, és csak a tényleges és az elvárt ágnevet jelzi; nem változtat ágat vagy jogosultságot, és nem naplózza a projekt teljes API-válaszát.
- Az új csomag az előző generáció adatfájljait is tartalmazza: így az öt percig gyorsítótárazott korábbi manifest is olvasható marad. Az adatnevek hash-alapúak, hosszú immutable cache-t kapnak; a manifest cache-e 300 másodperc.
- A workflow nem indul `push` eseményre, ezért a saját adatcommitja nem okoz végtelen ciklust. Az egyidejű futások sorban állnak, a folyamatban lévő futást nem szakítják meg.
- Az ütemezés vagy a külső API-hívás csúszhat vagy kimaradhat. Tartós forráskimaradásnál emberi ellenőrzés szükséges; a valódi adatgenerációk commitjai hasznos adatnaplót adnak, mesterséges aktivitáscommit nincs.
- A Cloudflare által indított futás az Actions lapon **`workflow_dispatch`** eseményként jelenik meg. A Worker valódi `scheduled` eseményének naplójában lévő `runId` köti össze az automatikus órával. Ha nincs új futás, ellenőrizd a Cloudflare Cron Triggert és annak naplóját, a Secretet, a GitHub-token lejáratát és az aktív GitHub workflow-t. Ez nem bizonyít forráshibát. A kézi `bootstrap=false`, `redeploy=false` futás pótolja az ellenőrzést, de önmagában nem bizonyítja az automatikus indítást.
- A `seed/` csak az első indulás és tudatos helyreállítás alapja. Az elveszett repository-auditot ne pótold új bootstrap futtatással egy már működő hoston.
- Nem tölti újra naponta az archívumot: az inkrementális modul az új, teljes napi forrásgenerációt dolgozza fel. Kimaradt napon nincs kitalált ár vagy előzőérték-másolás; a hiány null marad. Utólagos kitöltéshez külön igazolt, dátumozott archívumminta kell.
- Az Actions cache a hitelesített napi forrásválaszokat és a 24 órás kérésnaplót együtt őrzi, hibás gyűjtés után is. A kulcs a forrásmarker és az egyedi futásazonosító; egy részleges mentés nem akadályozza a későbbi teljes mentést. A lockfájl nincs a cache-ben. A GitHub törölheti a cache-t: a publikus előző csomag a tartós történeti állapot, nem ez a gyorsítótár.

## Helyi ellenőrzés

Node 24 szükséges. A tesztek szintetikus adatokkal, hálózati hívások és deploy nélkül futnak:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
node scripts/validate.cjs seed
```

A `npm ci` a lockfile szerinti Wrangler **4.163.0** verziót telepíti. A GitHub Actions lépések teljes commit SHA-ra rögzítettek. A napi frissítés csak a saját számládon végzett egyszeri beállítás után működik.

## Ellenőrzött hivatalos források

- [Cloudflare Pages Direct Upload és GitHub Actions](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [Pages ingyenes statikus kiszolgálás](https://developers.cloudflare.com/pages/functions/pricing/)
- [Pages fájl- és buildkorlátok](https://developers.cloudflare.com/pages/platform/limits/)
- [Cache/CORS fejlécek](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [GitHub workflow-dispatch API és jogosultságok](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [GitHub Actions díjazás](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

A forrásadat dátuma és a build időpontja külön mező; az automatikus frissítés sem hoz létre nem létező árakat, eladásokat vagy minősítettkártya-adatokat.

