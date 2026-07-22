import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPOSITORY = 'https://github.com/Kacko1/kempy-chorvatsko';
const OUTPUT_DIR = path.resolve('.');
const TEMP_DIR = path.join(OUTPUT_DIR, '.map-data-tmp');

const OVERPASS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lambert.openstreetmap.de/api/interpreter',
  'https://gall.openstreetmap.de/api/interpreter'
];

const DELAY_MS = numberFromEnv('OVERPASS_DELAY_MS', 20_000);
const RETRY_MS = numberFromEnv('OVERPASS_RETRY_MS', 60_000);
const TIMEOUT_MS = numberFromEnv('OVERPASS_TIMEOUT_MS', 300_000);
const MAX_ATTEMPTS = numberFromEnv('OVERPASS_MAX_ATTEMPTS', 5);

const COUNTRIES = [
  { id:'cz', iso:'CZ', label:'Česko', file:'cesko_data.json', nameTag:'name:cs' },
  { id:'at', iso:'AT', label:'Rakousko', file:'rakousko_data.json', nameTag:'name:de' },
  { id:'si', iso:'SI', label:'Slovinsko', file:'slovinsko_data.json', nameTag:'name:sl' },
  { id:'hr', iso:'HR', label:'Chorvatsko', file:'chorvatsko_data.json', nameTag:'name:hr' },
  { id:'pl', iso:'PL', label:'Polsko', file:'polsko_data.json', nameTag:'name:pl' },
  { id:'sk', iso:'SK', label:'Slovensko', file:'slovensko_data.json', nameTag:'name:sk' },
  { id:'de', iso:'DE', label:'Německo', file:'nemecko_data.json', nameTag:'name:de' }
];

const TABS = {
  camps: { label:'Kempy' },
  sights: {
    label:'Turistická místa',
    cats:[
      {key:'historic', sel:['historic=castle','historic=fort','historic=fortress','historic=ruins','historic=city_gate','historic=tower','historic=archaeological_site','historic=monument','historic=memorial'], match:t=>['castle','fort','fortress','ruins','city_gate','tower','archaeological_site','monument','memorial'].includes(t.historic)},
      {key:'sacral', sel:['historic=monastery','historic=church'], match:t=>['monastery','church'].includes(t.historic)},
      {key:'museum', sel:['tourism=museum','tourism=gallery','tourism=artwork','tourism=aquarium'], match:t=>['museum','gallery','artwork','aquarium'].includes(t.tourism)},
      {key:'view', sel:['tourism=viewpoint'], match:t=>t.tourism==='viewpoint'},
      {key:'fun', sel:['tourism=theme_park','tourism=zoo'], match:t=>['theme_park','zoo'].includes(t.tourism)},
      {key:'attraction', sel:['tourism=attraction'], match:t=>t.tourism==='attraction'}
    ]
  },
  nature: {
    label:'Příroda',
    cats:[
      {key:'park', sel:['boundary=national_park','leisure=nature_reserve'], match:t=>t.boundary==='national_park'||t.leisure==='nature_reserve'},
      {key:'view', sel:['tourism=viewpoint'], match:t=>t.tourism==='viewpoint'},
      {key:'water', sel:['natural=waterfall','natural=spring','natural=hot_spring'], match:t=>['waterfall','spring','hot_spring'].includes(t.natural)},
      {key:'beach', sel:['natural=beach','leisure=beach_resort'], match:t=>t.natural==='beach'||t.leisure==='beach_resort'},
      {key:'peak', sel:['natural=peak'], match:t=>t.natural==='peak'},
      {key:'cave', sel:['natural=cave_entrance'], match:t=>t.natural==='cave_entrance'}
    ]
  },
  food: {
    label:'Jídlo a parkování',
    cats:[
      {key:'restaurant', sel:['amenity=restaurant'], match:t=>t.amenity==='restaurant'},
      {key:'cafe', sel:['amenity=cafe','amenity=fast_food'], match:t=>['cafe','fast_food'].includes(t.amenity)},
      {key:'parking', sel:['amenity=parking'], match:t=>t.amenity==='parking'}
    ]
  },
  services: {
    label:'Zázemí',
    cats:[
      {key:'shell', sel:[], match:t=>t.amenity==='fuel' && (/^shell$/i.test(t.brand||'') || /shell/i.test(t.name||''))},
      {key:'fuel', sel:['amenity=fuel'], match:t=>t.amenity==='fuel'},
      {key:'shop', sel:['shop=supermarket','shop=convenience'], match:t=>['supermarket','convenience'].includes(t.shop)},
      {key:'pharmacy', sel:['amenity=pharmacy'], match:t=>t.amenity==='pharmacy'},
      {key:'money', sel:['amenity=atm','amenity=bank'], match:t=>['atm','bank'].includes(t.amenity)},
      {key:'water', sel:['amenity=drinking_water'], match:t=>t.amenity==='drinking_water'},
      {key:'toilets', sel:['amenity=toilets'], match:t=>t.amenity==='toilets'},
      {key:'dump', sel:['amenity=sanitary_dump_station'], match:t=>t.amenity==='sanitary_dump_station'}
    ]
  },
  spa: {
    label:'Termály a lázně',
    cats:[
      {key:'spa', sel:['leisure=spa','amenity=spa'], match:t=>t.leisure==='spa'||t.amenity==='spa'},
      {key:'thermal', sel:['natural=hot_spring'], match:t=>t.natural==='hot_spring'},
      {key:'pool', sel:['leisure=water_park'], match:t=>t.leisure==='water_park'}
    ]
  },
  lodging: {
    label:'Ubytování',
    cats:[
      {key:'hotel', sel:['tourism=hotel'], match:t=>t.tourism==='hotel'},
      {key:'apartment', sel:['tourism=apartment'], match:t=>t.tourism==='apartment'},
      {key:'guest', sel:['tourism=guest_house'], match:t=>t.tourism==='guest_house'},
      {key:'hostel', sel:['tourism=hostel'], match:t=>t.tourism==='hostel'},
      {key:'motel', sel:['tourism=motel'], match:t=>t.tourism==='motel'},
      {key:'chalet', sel:['tourism=chalet'], match:t=>t.tourism==='chalet'}
    ]
  }
};

const FALLBACK_LABELS = {
  sights:{
    historic:'🏰 Pamětihodnosti', sacral:'⛪ Sakrální', museum:'🖼️ Muzea a umění',
    view:'🔭 Vyhlídky', fun:'🎡 Zábava', attraction:'📌 Ostatní'
  },
  nature:{
    park:'🌲 Národní a přírodní parky', view:'🌅 Vyhlídky a západy slunce',
    water:'💧 Vodopády a koupání', beach:'🏖️ Pláže', peak:'🏔️ Vrcholy', cave:'🕳️ Jeskyně'
  },
  food:{ restaurant:'🍽️ Restaurace a konoby', cafe:'☕ Kavárny a rychlé', parking:'🅿️ Parkoviště' },
  services:{
    shell:'🐚 Shell', fuel:'⛽ Čerpací stanice', shop:'🛒 Supermarkety', pharmacy:'💊 Lékárny',
    money:'🏧 Bankomaty a banky', water:'🚰 Pitná voda', toilets:'🚻 WC', dump:'🚐 Dump station'
  },
  spa:{ spa:'♨️ Lázně a spa', thermal:'🌡️ Termály', pool:'🏊 Aquaparky' },
  lodging:{
    hotel:'🏨 Hotely', apartment:'🏢 Apartmány', guest:'🛏️ Penziony a pokoje',
    hostel:'🎒 Hostely', motel:'🛣️ Motely', chalet:'🏡 Chaty a vily'
  }
};

const FILM_SITES = [
  {name:'Pevnost Lovrijenac (Dubrovník)', lat:42.6404, lon:18.1052, films:['Game of Thrones — Rudá bašta / King’s Landing']},
  {name:'Hradby a Staré Město Dubrovník', lat:42.6414, lon:18.1074, films:['Game of Thrones — King’s Landing','Star Wars: Poslední z Jediů — Canto Bight','Robin Hood (2018)']},
  {name:'Věž Minčeta (Dubrovník)', lat:42.6421, lon:18.1085, films:['Game of Thrones — Dům nesmrtelných']},
  {name:'Jezuitské schody (Dubrovník)', lat:42.6398, lon:18.1101, films:['Game of Thrones — Cersein pochod hanby']},
  {name:'Park Gradac (Dubrovník)', lat:42.6389, lon:18.1030, films:['Game of Thrones — Purpurová svatba']},
  {name:'Knížecí palác (Dubrovník)', lat:42.6403, lon:18.1109, films:['Game of Thrones — Qarth']},
  {name:'Ostrov Lokrum', lat:42.6247, lon:18.1181, films:['Game of Thrones — Qarth']},
  {name:'Arboretum Trsteno', lat:42.7167, lon:17.9640, films:['Game of Thrones — zahrady Rudé bašty']},
  {name:'Diokleciánův palác — sklepy (Split)', lat:42.5081, lon:16.4402, films:['Game of Thrones — trůnní sál Meereenu']},
  {name:'Pevnost Klis', lat:43.5563, lon:16.5225, films:['Game of Thrones — Meereen']},
  {name:'Žrnovnica (u Splitu)', lat:43.5230, lon:16.5490, films:['Game of Thrones — okolí Meereenu']},
  {name:'Kaštel Gomilica', lat:43.5490, lon:16.3895, films:['Game of Thrones — Braavos']},
  {name:'Katedrála sv. Jakuba (Šibenik)', lat:43.7360, lon:15.8895, films:['Game of Thrones — Železná banka Braavosu']},
  {name:'Klášter sv. Dominika (Trogir)', lat:43.5163, lon:16.2513, films:['Game of Thrones — interiéry Qarthu']},
  {name:'Komiža (ostrov Vis)', lat:43.0456, lon:16.0894, films:['Mamma Mia! Here We Go Again']},
  {name:'Město Vis', lat:43.0619, lon:16.1836, films:['Mamma Mia! Here We Go Again']},
  {name:'Zátoka Stiniva (Vis)', lat:43.0169, lon:16.1553, films:['Mamma Mia! Here We Go Again','Porco Rosso (předloha)']},
  {name:'Národní park Plitvická jezera', lat:44.8654, lon:15.5820, films:['Vinnetou']},
  {name:'Vodopády Krka (Skradinski buk)', lat:43.8074, lon:15.9714, films:['Vinnetou']},
  {name:'Kaňon Zrmanja (Obrovac)', lat:44.2044, lon:15.6825, films:['Vinnetou']},
  {name:'Národní park Paklenica', lat:44.3339, lon:15.4611, films:['Vinnetou']},
  {name:'Rovinj', lat:45.0811, lon:13.6387, films:['Hitman’s Wife’s Bodyguard']}
];

function numberFromEnv(name, fallback){
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve, ms));
}

function selectorToQuery(selector){
  let named = false;
  if(selector.endsWith('#named')){
    named = true;
    selector = selector.slice(0, -6);
  }
  const divider = selector.indexOf('=');
  const key = selector.slice(0, divider);
  const value = selector.slice(divider + 1);
  return 'nwr["' + key + '"="' + value + '"]' + (named ? '["name"]' : '') + '(area.country);';
}

function buildQuery(country, tabId){
  if(tabId === 'camps'){
    return '[out:json][timeout:120];area["ISO3166-1"="' + country.iso + '"]->.country;('
      + 'nwr["tourism"="camp_site"](area.country);'
      + 'nwr["tourism"="caravan_site"](area.country);'
      + ');out center tags;';
  }
  const selectors = TABS[tabId].cats.flatMap(category=>category.sel);
  const body = selectors.map(selectorToQuery).join('');
  return '[out:json][timeout:120];area["ISO3166-1"="' + country.iso + '"]->.country;('
    + body + ');out center tags;';
}

async function requestOverpass(endpoint, query){
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), TIMEOUT_MS);
  try{
    const response = await fetch(endpoint, {
      method:'POST',
      headers:{
        'Accept':'application/json',
        'Content-Type':'text/plain; charset=utf-8',
        'User-Agent':'kempy-chorvatsko-data-updater/1.0 (' + REPOSITORY + ')'
      },
      body:query,
      signal:controller.signal
    });
    if(!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
    const json = await response.json();
    if(!json || !Array.isArray(json.elements)) throw new Error('Odpověď neobsahuje pole elements');
    return json;
  }finally{
    clearTimeout(timeout);
  }
}

async function fetchTab(country, tabId){
  const query = buildQuery(country, tabId);
  let lastError = null;
  for(let attempt=1; attempt<=MAX_ATTEMPTS; attempt++){
    for(const endpoint of OVERPASS){
      try{
        console.log('  ' + TABS[tabId].label + ': pokus ' + attempt + '/' + MAX_ATTEMPTS + ' přes ' + new URL(endpoint).host);
        return await requestOverpass(endpoint, query);
      }catch(error){
        lastError = error;
        console.warn('    selhalo: ' + error.message);
        await sleep(5_000);
      }
    }
    if(attempt < MAX_ATTEMPTS){
      const pause = RETRY_MS * attempt + Math.floor(Math.random() * 30_000);
      console.log('    další pokus za ' + Math.round(pause / 1000) + ' s');
      await sleep(pause);
    }
  }
  throw lastError || new Error('Stažení selhalo');
}

function classify(tags, categories){
  for(const category of categories){
    if(category.match(tags)) return category.key;
  }
  return categories[0] ? categories[0].key : 'other';
}

function composeAddress(tags){
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ');
  const parts = [street, city].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function regionOf(countryId, lat, lon){
  if(countryId === 'hr'){
    if(lon < 14.35 && lat > 44.7 && lat < 45.55) return 'Istrie';
    if(lat >= 44.15 && lat <= 45.4 && lon >= 14.2 && lon < 15.05) return 'Kvarner';
    if(lat > 45.3 && lon >= 15.0) return 'Kontinentální Chorvatsko';
    if(lat >= 44.3 && lon >= 15.0 && lon < 16.2) return 'Lika a Karlovac';
    if(lat >= 43.55 && lat < 44.35) return 'Severní Dalmácie (Zadar, Šibenik)';
    if(lat >= 43.05 && lat < 43.55) return 'Střední Dalmácie (Split, Makarska)';
    if(lat < 43.05) return 'Jižní Dalmácie (Dubrovník)';
  }
  if(countryId === 'cz') return lon < 15.3 ? 'Čechy' : (lon < 17.2 ? 'Morava' : 'Slezsko');
  if(countryId === 'at') return lon < 12.6 ? 'Západní Rakousko' : (lon < 15.2 ? 'Střední Rakousko' : 'Východní Rakousko');
  if(countryId === 'si') return lon < 14.4 ? 'Západní Slovinsko' : (lon < 15.3 ? 'Střední Slovinsko' : 'Východní Slovinsko');
  if(countryId === 'pl') return lon < 17.2 ? 'Západní Polsko' : (lon < 20.5 ? 'Střední Polsko' : 'Východní Polsko');
  if(countryId === 'sk') return lon < 18.3 ? 'Západní Slovensko' : (lon < 20.5 ? 'Střední Slovensko' : 'Východní Slovensko');
  if(countryId === 'de') return lon < 8.5 ? 'Západní Německo' : (lon < 12.5 ? 'Střední Německo' : 'Východní Německo');
  return 'Ostatní';
}

function osmRegion(country, tags, lat, lon){
  return tags['addr:state'] || tags['is_in:state'] || tags['addr:region'] || regionOf(country.id, lat, lon);
}

function parseCamps(json, country){
  const result = [];
  for(const element of json.elements){
    const tags = element.tags || {};
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if(lat == null || lon == null) continue;
    result.push({
      id:element.type + '/' + element.id,
      lat:+lat, lon:+lon,
      name:tags.name || tags[country.nameTag] || tags['name:en'] || tags.operator || 'Kemp bez názvu',
      kind:tags.tourism,
      stars:tags.stars ? parseInt(tags.stars, 10) : null,
      website:tags.website || tags['contact:website'] || null,
      phone:tags.phone || tags['contact:phone'] || null,
      email:tags.email || tags['contact:email'] || null,
      addr:composeAddress(tags),
      city:tags['addr:city'] || null,
      region:osmRegion(country, tags, +lat, +lon),
      tags
    });
  }
  return result;
}

function isNotable(tags){
  if(tags.wikidata || tags.wikipedia || tags.wikimedia_commons) return true;
  if(tags.heritage || tags['heritage:operator'] || tags['ref:whc'] || tags.whc) return true;
  if(['castle','fort','fortress','archaeological_site'].includes(tags.historic)) return true;
  if(['museum','theme_park','zoo','aquarium'].includes(tags.tourism)) return true;
  if(tags.natural === 'waterfall') return true;
  if(tags.boundary === 'national_park' || tags.leisure === 'nature_reserve') return true;
  return false;
}

function parsePoi(json, country, tabId){
  const categories = TABS[tabId].cats;
  const result = [];
  for(const element of json.elements){
    const tags = element.tags || {};
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if(lat == null || lon == null) continue;
    const category = classify(tags, categories);
    result.push({
      id:element.type + '/' + element.id,
      lat:+lat, lon:+lon,
      name:tags.name || tags[country.nameTag] || tags['name:en'] || FALLBACK_LABELS[tabId]?.[category] || 'Místo',
      cat:category,
      notable:isNotable(tags),
      website:tags.website || tags['contact:website'] || null,
      wikipedia:tags.wikipedia || null,
      wikidata:tags.wikidata || null,
      commons:tags.wikimedia_commons || null,
      image:tags.image && /^https:\/\//i.test(tags.image) ? tags.image : null,
      addr:composeAddress(tags),
      city:tags['addr:city'] || null,
      region:osmRegion(country, tags, +lat, +lon)
    });
  }
  if(tabId === 'sights' && country.id === 'hr') mergeFilms(result);
  return result;
}

function haversine(lat1, lon1, lat2, lon2){
  const radians = value=>value * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon/2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function mergeFilms(list){
  for(const filmSite of FILM_SITES){
    let best = null;
    let bestDistance = Infinity;
    for(const site of list){
      const distance = haversine(filmSite.lat, filmSite.lon, site.lat, site.lon);
      if(distance < bestDistance){
        bestDistance = distance;
        best = site;
      }
    }
    if(best && bestDistance <= 180){
      best.film = true;
      best.notable = true;
      best.films = (best.films || []).concat(filmSite.films);
    }else{
      list.push({
        id:'film/' + filmSite.name,
        lat:filmSite.lat, lon:filmSite.lon, name:filmSite.name,
        cat:'attraction', notable:true, website:null, wikipedia:null, wikidata:null,
        addr:null, city:null, region:regionOf('hr', filmSite.lat, filmSite.lon),
        film:true, films:filmSite.films.slice(), tags:{}
      });
    }
  }
}

async function compressBundle(bundle){
  const module = await import('lz-string');
  const lzString = module.default || module;
  return JSON.stringify({ compressed:true, z:lzString.compressToBase64(JSON.stringify(bundle)) });
}

async function buildCountry(country){
  console.log('\n' + country.label + ' (' + country.iso + ')');
  const bundle = {};
  const tabIds = Object.keys(TABS);
  for(let index=0; index<tabIds.length; index++){
    const tabId = tabIds[index];
    const raw = await fetchTab(country, tabId);
    const data = tabId === 'camps' ? parseCamps(raw, country) : parsePoi(raw, country, tabId);
    if(data.length === 0) throw new Error(country.label + ' / ' + TABS[tabId].label + ': server vrátil prázdná data');
    bundle[tabId] = { fetchedAt:Date.now(), data };
    console.log('    hotovo: ' + data.length + ' objektů');
    if(index < tabIds.length - 1) await sleep(DELAY_MS);
  }
  const payload = await compressBundle(bundle);
  await writeFile(path.join(TEMP_DIR, country.file), payload, 'utf8');
  console.log('  připraven ' + country.file + ' (' + Math.round(Buffer.byteLength(payload)/1024) + ' kB)');
}

function runChecks(){
  assert.equal(COUNTRIES.length, 7);
  assert.equal(Object.keys(TABS).length, 7);
  assert.deepEqual(COUNTRIES.map(country=>country.file), [
    'cesko_data.json','rakousko_data.json','slovinsko_data.json','chorvatsko_data.json',
    'polsko_data.json','slovensko_data.json','nemecko_data.json'
  ]);
  for(const country of COUNTRIES){
    for(const tabId of Object.keys(TABS)){
      const query = buildQuery(country, tabId);
      assert.match(query, new RegExp('ISO3166-1"="' + country.iso + '"'));
      assert.match(query, /out center tags;/);
    }
  }
  const sample = parseCamps({
    elements:[{type:'node', id:1, lat:49.1, lon:15.1, tags:{tourism:'camp_site', name:'Test'}}]
  }, COUNTRIES[0]);
  assert.equal(sample[0].id, 'node/1');
  assert.equal(sample[0].name, 'Test');
  console.log('Kontrola konfigurace a parseru: OK');
}

function argumentValue(name){
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function probeCountry(countryId, requestedTab){
  const country = COUNTRIES.find(item=>item.id === countryId);
  if(!country) throw new Error('Neznámý kód země pro diagnostiku: ' + countryId);
  if(requestedTab && !TABS[requestedTab]) throw new Error('Neznámá záložka pro diagnostiku: ' + requestedTab);
  console.log('Diagnostika bez zápisu souborů: ' + country.label);
  const tabIds = requestedTab ? [requestedTab] : Object.keys(TABS);
  for(const tabId of tabIds){
    const raw = await fetchTab(country, tabId);
    const data = tabId === 'camps' ? parseCamps(raw, country) : parsePoi(raw, country, tabId);
    console.log('  ' + TABS[tabId].label + ': ' + data.length + ' objektů');
    await sleep(Math.min(DELAY_MS, 5_000));
  }
}

async function main(){
  if(process.argv.includes('--check')){
    runChecks();
    return;
  }
  const probeCountryId = argumentValue('--probe-country');
  if(probeCountryId){
    await probeCountry(probeCountryId, argumentValue('--probe-tab'));
    return;
  }
  const requestedCountryIds = argumentValue('--countries');
  const countriesToBuild = requestedCountryIds
    ? requestedCountryIds.split(',').map(id=>id.trim()).filter(Boolean).map(id=>{
        const country = COUNTRIES.find(item=>item.id === id);
        if(!country) throw new Error('Neznámý kód země: ' + id);
        return country;
      })
    : COUNTRIES;
  await rm(TEMP_DIR, { recursive:true, force:true });
  await mkdir(TEMP_DIR, { recursive:true });
  try{
    for(let index=0; index<countriesToBuild.length; index++){
      await buildCountry(countriesToBuild[index]);
      if(index < countriesToBuild.length - 1) await sleep(DELAY_MS);
    }
    for(const country of countriesToBuild){
      await copyFile(path.join(TEMP_DIR, country.file), path.join(OUTPUT_DIR, country.file));
    }
    console.log('\nVšechny datové soubory byly úspěšně nahrazeny.');
  }catch(error){
    console.error('\nAktualizace selhala. Produkční JSON soubory zůstaly beze změny.');
    throw error;
  }finally{
    await rm(TEMP_DIR, { recursive:true, force:true });
  }
}

await main();
