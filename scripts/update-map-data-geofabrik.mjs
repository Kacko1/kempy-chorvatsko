import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

const REPOSITORY = 'https://github.com/Kacko1/kempy-chorvatsko';
const OUTPUT_DIR = path.resolve('.');
const TEMP_DIR = path.join(OUTPUT_DIR, '.geofabrik-data-tmp');
const DOWNLOAD_TIMEOUT_MS = numberFromEnv('GEOFABRIK_TIMEOUT_MS', 3_600_000);
const DOWNLOAD_ATTEMPTS = numberFromEnv('GEOFABRIK_MAX_ATTEMPTS', 3);

const COUNTRIES = [
  { id:'cz', iso:'CZ', label:'Česko', file:'cesko_data.json', nameTag:'name:cs', extract:'czech-republic', bounds:[48.3,11.8,51.3,19.0] },
  { id:'hr', iso:'HR', label:'Chorvatsko', file:'chorvatsko_data.json', nameTag:'name:hr', extract:'croatia', bounds:[42.2,13.0,46.8,20.0] },
  { id:'it', iso:'IT', label:'Itálie', file:'italie_data.json', nameTag:'name:it', extract:'italy', bounds:[35.0,6.0,47.7,19.0] },
  { id:'de', iso:'DE', label:'Německo', file:'nemecko_data.json', nameTag:'name:de', extract:'germany', bounds:[47.0,5.0,55.5,16.0] },
  { id:'pl', iso:'PL', label:'Polsko', file:'polsko_data.json', nameTag:'name:pl', extract:'poland', bounds:[48.5,13.5,55.5,24.5] },
  { id:'at', iso:'AT', label:'Rakousko', file:'rakousko_data.json', nameTag:'name:de', extract:'austria', bounds:[46.0,9.0,49.5,18.0] },
  { id:'sk', iso:'SK', label:'Slovensko', file:'slovensko_data.json', nameTag:'name:sk', extract:'slovakia', bounds:[47.0,16.5,50.5,23.0] },
  { id:'si', iso:'SI', label:'Slovinsko', file:'slovinsko_data.json', nameTag:'name:sl', extract:'slovenia', bounds:[45.0,13.0,47.2,17.0] },
  { id:'ch', iso:'CH', label:'Švýcarsko', file:'svycarsko_data.json', nameTag:'name:de', extract:'switzerland', bounds:[45.5,5.5,48.2,11.0] }
].map(country=>({
  ...country,
  pbfUrl:'https://download.geofabrik.de/europe/' + country.extract + '-latest.osm.pbf'
}));

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

// Samostatná překryvná vrstva pro řidiče. Filtrujeme jen výslovně označené
// zóny a zpoplatněné úseky, ne celou silniční síť.
const ZONE_SELECTORS = [
  'boundary=low_emission_zone',
  'boundary=limited_traffic_zone',
  'type=toll',
  'toll=yes',
  'toll:motor_vehicle=yes',
  'toll:motorcar=yes'
];

const ZONE_LABELS = {
  low_emission:'Nízkoemisní zóna',
  limited_traffic:'Zóna s omezeným vjezdem',
  toll:'Zpoplatněný úsek nebo oblast',
  paid_parking:'Placené parkoviště'
};

const ZONE_RULE_KEYS = [
  'access','access:conditional','motor_vehicle','motor_vehicle:conditional',
  'motorcar','motorcar:conditional','motorhome','motorhome:conditional',
  'caravan','caravan:conditional','hgv','hgv:conditional',
  'fee','fee:amount','fee:conditional','charge','charge:conditional',
  'toll','toll:motor_vehicle','toll:motorcar','opening_hours','maxstay',
  'capacity','capacity:motorhome','capacity:caravan','parking','surface',
  'maxheight','maxwidth','maxweight','zone:traffic','emission_class',
  'description','note'
];

const FALLBACK_LABELS = {
  sights:{historic:'🏛 Pamětihodnosti',sacral:'⛪ Sakrální',museum:'🖼️ Muzea a umění',view:'🔭 Vyhlídky',fun:'🎡 Zábava',attraction:'📌 Ostatní'},
  nature:{park:'🌲 Národní a přírodní parky',view:'🌅 Vyhlídky a západy slunce',water:'💧 Vodopády a koupání',beach:'🏖️ Pláže',peak:'🏔️ Vrcholy',cave:'🕳️ Jeskyně'},
  food:{restaurant:'🍽️ Restaurace a konoby',cafe:'☕ Kavárny a rychlé',parking:'🅿️ Parkoviště'},
  services:{shell:'🐚 Shell',fuel:'⛽ Čerpací stanice',shop:'🛒 Supermarkety',pharmacy:'💊 Lékárny',money:'🏧 Bankomaty a banky',water:'🚰 Pitná voda',toilets:'🚻 WC',dump:'🚐 Dump station'},
  spa:{spa:'♨️ Lázně a spa',thermal:'🌡️ Termály',pool:'🏊 Aquaparky'},
  lodging:{hotel:'🏨 Hotely',apartment:'🏢 Apartmány',guest:'🛏️ Penziony a pokoje',hostel:'🎒 Hostely',motel:'🛣️ Motely',chalet:'🏡 Chaty a vily'}
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

function sleep(ms){ return new Promise(resolve=>setTimeout(resolve, ms)); }

function argumentValue(name){
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
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
  if(countryId === 'it') return lat >= 44.5 ? 'Severní Itálie' : (lat >= 41.5 ? 'Střední Itálie' : 'Jižní Itálie a ostrovy');
  if(countryId === 'ch') return lon < 7.5 ? 'Západní Švýcarsko' : (lon < 8.8 ? 'Střední Švýcarsko' : 'Východní Švýcarsko');
  return 'Ostatní';
}

function osmRegion(country, tags, lat, lon){
  return tags['addr:state'] || tags['is_in:state'] || tags['addr:region'] || regionOf(country.id, lat, lon);
}

function classify(tags, categories){
  for(const category of categories){
    if(category.match(tags)) return category.key;
  }
  return null;
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

function bboxCenter(geometry){
  if(!geometry || !geometry.coordinates) return null;
  if(geometry.type === 'Point'){
    const [lon, lat] = geometry.coordinates;
    return validCoordinate(lat, lon) ? {lat:+lat, lon:+lon} : null;
  }
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = coordinates=>{
    if(!Array.isArray(coordinates)) return;
    if(coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number'){
      const lon = coordinates[0], lat = coordinates[1];
      if(validCoordinate(lat, lon)){
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      }
      return;
    }
    for(const item of coordinates) visit(item);
  };
  visit(geometry.coordinates);
  if(!Number.isFinite(minLon)) return null;
  return {lat:(minLat + maxLat) / 2, lon:(minLon + maxLon) / 2};
}

function validCoordinate(lat, lon){
  return Number.isFinite(+lat) && Number.isFinite(+lon) && +lat >= -90 && +lat <= 90 && +lon >= -180 && +lon <= 180;
}

function insideCountryBounds(country, lat, lon){
  const [minLat,minLon,maxLat,maxLon] = country.bounds;
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

function parseFeature(feature, country){
  const properties = {...(feature.properties || {})};
  const type = properties['@type'];
  const numericId = properties['@id'];
  delete properties['@type'];
  delete properties['@id'];
  if(!['node','way','relation'].includes(type) || numericId == null) return null;
  const center = bboxCenter(feature.geometry);
  if(!center || !insideCountryBounds(country,center.lat,center.lon)) return null;
  return {id:type + '/' + numericId, type, tags:properties, geometry:feature.geometry, ...center};
}

function paidParkingForOverlay(tags){
  if(tags.amenity !== 'parking') return false;
  const paid = tags.fee === 'yes' || !!tags.charge || !!tags['fee:amount'] || !!tags['fee:conditional'] || !!tags['charge:conditional'];
  if(!paid) return false;
  return !!(
    tags.name || tags.operator || tags.maxstay || tags.opening_hours || tags.supervised ||
    tags.motorhome || tags.caravan || tags['capacity:motorhome'] || tags['capacity:caravan']
  );
}

function zoneKind(tags){
  if(tags.boundary === 'low_emission_zone') return 'low_emission';
  if(tags.boundary === 'limited_traffic_zone') return 'limited_traffic';
  if(tags.type === 'toll' || tags.toll === 'yes' || tags['toll:motor_vehicle'] === 'yes' || tags['toll:motorcar'] === 'yes') return 'toll';
  if(paidParkingForOverlay(tags)) return 'paid_parking';
  return null;
}

function zoneFromFeature(item, country){
  const kind = zoneKind(item.tags);
  if(!kind) return null;
  const tags = item.tags;
  const rules = {};
  for(const key of ZONE_RULE_KEYS) if(tags[key] != null && tags[key] !== '') rules[key] = tags[key];
  const geometry = kind === 'paid_parking'
    ? {type:'Point',coordinates:[item.lon,item.lat]}
    : item.geometry;
  if(!geometry || !geometry.type || !geometry.coordinates) return null;
  return {
    id:item.id, kind, geometry, lat:item.lat, lon:item.lon,
    name:tags.name || tags[country.nameTag] || tags['name:en'] || tags.operator || ZONE_LABELS[kind],
    operator:tags.operator || null,
    website:tags.website || tags['contact:website'] || null,
    rules
  };
}

function campFromFeature(item, country){
  const t = item.tags;
  if(!['camp_site','caravan_site'].includes(t.tourism)) return null;
  return {
    id:item.id, lat:item.lat, lon:item.lon,
    name:t.name || t[country.nameTag] || t['name:en'] || t.operator || 'Kemp bez názvu',
    kind:t.tourism,
    stars:t.stars ? parseInt(t.stars, 10) : null,
    website:t.website || t['contact:website'] || null,
    phone:t.phone || t['contact:phone'] || null,
    email:t.email || t['contact:email'] || null,
    addr:composeAddress(t), city:t['addr:city'] || null,
    region:osmRegion(country, t, item.lat, item.lon), tags:t
  };
}

function poiFromFeature(item, country, tabId, category){
  const t = item.tags;
  return {
    id:item.id, lat:item.lat, lon:item.lon,
    name:t.name || t[country.nameTag] || t['name:en'] || FALLBACK_LABELS[tabId]?.[category] || 'Místo',
    cat:category, notable:isNotable(t),
    website:t.website || t['contact:website'] || null,
    wikipedia:t.wikipedia || null, wikidata:t.wikidata || null,
    commons:t.wikimedia_commons || null,
    image:t.image && /^https:\/\//i.test(t.image) ? t.image : null,
    addr:composeAddress(t), city:t['addr:city'] || null,
    region:osmRegion(country, t, item.lat, item.lon)
  };
}

function haversine(lat1, lon1, lat2, lon2){
  const radians = value=>value * Math.PI / 180;
  const dLat = radians(lat2-lat1), dLon = radians(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(radians(lat1))*Math.cos(radians(lat2))*Math.sin(dLon/2)**2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function mergeFilms(list){
  for(const filmSite of FILM_SITES){
    let best = null, bestDistance = Infinity;
    for(const site of list){
      const distance = haversine(filmSite.lat, filmSite.lon, site.lat, site.lon);
      if(distance < bestDistance){ bestDistance = distance; best = site; }
    }
    if(best && bestDistance <= 180){
      best.film = true; best.notable = true;
      best.films = (best.films || []).concat(filmSite.films);
    }else{
      list.push({
        id:'film/' + filmSite.name, lat:filmSite.lat, lon:filmSite.lon, name:filmSite.name,
        cat:'attraction', notable:true, website:null, wikipedia:null, wikidata:null,
        addr:null, city:null, region:regionOf('hr',filmSite.lat,filmSite.lon),
        film:true, films:filmSite.films.slice(), tags:{}
      });
    }
  }
}

function filterExpressions(){
  const selectors = [
    'tourism=camp_site','tourism=caravan_site',
    ...Object.values(TABS).flatMap(tab=>(tab.cats || []).flatMap(category=>category.sel)),
    ...ZONE_SELECTORS
  ];
  const grouped = new Map();
  for(const selector of selectors){
    const divider = selector.indexOf('=');
    const key = selector.slice(0, divider), value = selector.slice(divider + 1);
    if(!grouped.has(key)) grouped.set(key, new Set());
    grouped.get(key).add(value);
  }
  return [...grouped.entries()].map(([key,values])=>'nwr/' + key + '=' + [...values].join(','));
}

async function run(command, args){
  await new Promise((resolve,reject)=>{
    const child = spawn(command, args, {stdio:'inherit'});
    child.on('error', reject);
    child.on('exit', code=>code===0 ? resolve() : reject(new Error(command + ' skončil s kódem ' + code)));
  });
}

async function downloadFile(url, destination){
  let lastError = null;
  for(let attempt=1; attempt<=DOWNLOAD_ATTEMPTS; attempt++){
    try{
      console.log('  stahuji výřez ' + attempt + '/' + DOWNLOAD_ATTEMPTS + ': ' + url);
      const response = await fetch(url, {
        headers:{'User-Agent':'kempy-chorvatsko-data-updater/2.0 (' + REPOSITORY + ')'},
        signal:AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      });
      if(!response.ok || !response.body) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
      const size = Number(response.headers.get('content-length'));
      if(Number.isFinite(size)) console.log('  velikost výřezu: ' + Math.round(size/1024/1024) + ' MB');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      return;
    }catch(error){
      lastError = error;
      console.warn('  stažení selhalo: ' + error.message);
      await rm(destination,{force:true});
      if(attempt < DOWNLOAD_ATTEMPTS) await sleep(attempt * 30_000);
    }
  }
  throw lastError || new Error('Stažení výřezu selhalo');
}

function escapeLiteralControlsInJson(text){
  let result = '', inString = false, escaped = false;
  for(const character of text){
    if(!inString){
      result += character;
      if(character === '"') inString = true;
      continue;
    }
    if(escaped){ result += character; escaped = false; continue; }
    if(character === '\\'){ result += character; escaped = true; continue; }
    if(character === '"'){ result += character; inString = false; continue; }
    const code = character.charCodeAt(0);
    if(code < 0x20){
      if(character === '\n') result += '\\n';
      else if(character === '\r') result += '\\r';
      else if(character === '\t') result += '\\t';
      else result += '\\u' + code.toString(16).padStart(4,'0');
    }else result += character;
  }
  return result;
}

function parseGeoJsonRecord(text){
  try{ return JSON.parse(text); }
  catch(firstError){
    const repaired = escapeLiteralControlsInJson(text);
    if(repaired === text) throw firstError;
    return JSON.parse(repaired);
  }
}

async function* readGeoJsonRecords(input){
  let buffer = '';
  for await (const chunk of input){
    buffer += chunk;
    const parts = buffer.split('\x1e');
    buffer = parts.pop() || '';
    for(const part of parts){
      const text = part.trim();
      if(text) yield parseGeoJsonRecord(text);
    }
  }
  const tail = buffer.trim();
  if(tail) yield parseGeoJsonRecord(tail);
}

async function parseGeoJsonSequence(file, country){
  const maps = Object.fromEntries(Object.keys(TABS).map(tabId=>[tabId,new Map()]));
  const zones = new Map();
  let rawFeatures = 0, skipped = 0;
  const input = createReadStream(file,{encoding:'utf8'});
  for await (const feature of readGeoJsonRecords(input)){
    rawFeatures++;
    const item = parseFeature(feature,country);
    if(!item){ skipped++; continue; }
    const camp = campFromFeature(item,country);
    if(camp) maps.camps.set(camp.id,camp);
    const zone = zoneFromFeature(item,country);
    if(zone) zones.set(zone.id,zone);
    for(const [tabId,tab] of Object.entries(TABS)){
      if(tabId === 'camps') continue;
      const category = classify(item.tags,tab.cats);
      if(category) maps[tabId].set(item.id,poiFromFeature(item,country,tabId,category));
    }
  }
  const fetchedAt = Date.now();
  const bundle = {
    _meta:{
      source:'OpenStreetMap via Geofabrik',
      sourceUrl:country.pbfUrl,
      license:'ODbL 1.0',
      licenseUrl:'https://www.openstreetmap.org/copyright',
      country:country.iso,
      generatedAt:new Date(fetchedAt).toISOString(),
      coordinateMethod:'point coordinates; bounding-box center for ways and relations'
    }
  };
  for(const tabId of Object.keys(TABS)){
    const data = [...maps[tabId].values()];
    if(tabId === 'sights' && country.id === 'hr') mergeFilms(data);
    if(data.length === 0) throw new Error(country.label + ' / ' + TABS[tabId].label + ': prázdná data');
    bundle[tabId] = {fetchedAt,data};
    console.log('  ' + TABS[tabId].label + ': ' + data.length + ' objektů');
  }
  bundle.zones = {fetchedAt,data:[...zones.values()]};
  const zoneCounts = Object.fromEntries(Object.keys(ZONE_LABELS).map(kind=>[kind,0]));
  for(const zone of zones.values()) zoneCounts[zone.kind]++;
  console.log('  Zóny a omezení: ' + zones.size + ' objektů'
    + ' (emisní ' + zoneCounts.low_emission
    + ', omezený vjezd ' + zoneCounts.limited_traffic
    + ', mýto ' + zoneCounts.toll
    + ', placené parkování ' + zoneCounts.paid_parking + ')');
  console.log('  zpracováno geometrií: ' + rawFeatures + ', přeskočeno bez platné geometrie: ' + skipped);
  return bundle;
}

function countryDataStem(country){
  return country.file.replace(/_data\.json$/,'');
}

function partRelativePath(country,id){
  return path.posix.join('map-data',countryDataStem(country),id + '.json.gz');
}

function compressBundleParts(bundle,country){
  // Manifest zůstává malý. Každá záložka je samostatný binární gzip, takže
  // prohlížeč nemusí při otevření země stahovat ostatní kategorie ani Base64.
  const parts = {};
  const files = [];
  let sourceBytes = 0;
  let compressedBytes = 0;
  for(const [id,value] of Object.entries(bundle)){
    if(id === '_meta') continue;
    const source = Buffer.from(JSON.stringify(value),'utf8');
    // Nativní zlib je u velkých zemí řádově rychlejší než původní čistě
    // JavaScriptový LZ-String. Úroveň 6 dává dobrý poměr rychlosti a velikosti.
    const compressed = gzipSync(source,{level:6});
    const file = partRelativePath(country,id);
    parts[id] = {
      file,
      bytes:compressed.length,
      sourceBytes:source.length,
      count:Array.isArray(value.data) ? value.data.length : 0,
      fetchedAt:value.fetchedAt || null
    };
    files.push({id,file,compressed});
    sourceBytes += source.length;
    compressedBytes += compressed.length;
  }
  return {
    payload:JSON.stringify({
      compressed:'gzip-tab-files-v1',
      version:bundle._meta && bundle._meta.generatedAt || new Date().toISOString(),
      _meta:bundle._meta || {},
      parts
    }),
    files,
    sourceBytes,
    compressedBytes
  };
}

async function buildCountry(country){
  console.log('\n' + country.label + ' (' + country.iso + ')');
  const workDir = path.join(TEMP_DIR,'work-' + country.id);
  await mkdir(workDir,{recursive:true});
  const sourcePbf = path.join(workDir,country.extract + '.osm.pbf');
  const filteredPbf = path.join(workDir,'filtered.osm.pbf');
  const geojsonSeq = path.join(workDir,'features.geojsonseq');
  const locationIndex = path.join(workDir,'locations.idx');
  try{
    await downloadFile(country.pbfUrl,sourcePbf);
    console.log('  filtruji požadované OSM tagy…');
    await run('osmium',['tags-filter','-t','--no-progress','-O','-o',filteredPbf,sourcePbf,...filterExpressions()]);
    console.log('  sestavuji geometrie a souřadnice…');
    await run('osmium',[
      'export','--no-progress','-O','-f','geojsonseq',
      '-a','type,id','-i','sparse_file_array,' + locationIndex,'-o',geojsonSeq,filteredPbf
    ]);
    const bundle = await parseGeoJsonSequence(geojsonSeq,country);
    console.log('  komprimuji jednotlivé záložky nativním gzipem…');
    const compressed = compressBundleParts(bundle,country);
    const payload = compressed.payload;
    console.log('  komprese hotova: ' + Math.round(compressed.sourceBytes/1024/1024)
      + ' MB → ' + Math.round(compressed.compressedBytes/1024/1024) + ' MB gzip');
    for(const part of compressed.files){
      const partOutput=path.join(TEMP_DIR,part.file);
      await mkdir(path.dirname(partOutput),{recursive:true});
      await writeFile(partOutput,part.compressed);
      console.log('    ' + part.id + ': ' + Math.round(part.compressed.length/1024) + ' kB');
    }
    const output = path.join(TEMP_DIR,country.file);
    await writeFile(output,payload,'utf8');
    console.log('  připraven manifest ' + country.file + ' (' + Math.round(Buffer.byteLength(payload)/1024) + ' kB)');
  }finally{
    await rm(workDir,{recursive:true,force:true});
  }
}

async function runChecks(){
  assert.equal(COUNTRIES.length,9);
  assert.equal(Object.keys(TABS).length,7);
  assert.deepEqual(COUNTRIES.map(country=>country.file),[
    'cesko_data.json','chorvatsko_data.json','italie_data.json','nemecko_data.json',
    'polsko_data.json','rakousko_data.json','slovensko_data.json','slovinsko_data.json','svycarsko_data.json'
  ]);
  assert.ok(filterExpressions().includes('nwr/tourism=camp_site,caravan_site,museum,gallery,artwork,aquarium,viewpoint,theme_park,zoo,attraction,hotel,apartment,guest_house,hostel,motel,chalet'));
  assert.ok(filterExpressions().some(expression=>
    expression.startsWith('nwr/boundary=') &&
    expression.includes('low_emission_zone') && expression.includes('limited_traffic_zone')));
  assert.ok(filterExpressions().includes('nwr/type=toll'));
  assert.deepEqual(bboxCenter({type:'Point',coordinates:[14.25,50.1]}),{lat:50.1,lon:14.25});
  assert.deepEqual(bboxCenter({type:'Polygon',coordinates:[[[10,40],[14,40],[14,44],[10,44],[10,40]]]}),{lat:42,lon:12});
  assert.equal(parseFeature({
    type:'Feature',properties:{'@type':'node','@id':1,tourism:'camp_site'},
    geometry:{type:'Point',coordinates:[50.1,14.25]}
  },COUNTRIES[0]),null,'prohozené souřadnice musí odmítnout kontrola hranic země');
  const sample = parseFeature({
    type:'Feature',properties:{'@type':'way','@id':123,tourism:'camp_site',name:'Test'},
    geometry:{type:'LineString',coordinates:[[14,49],[16,51]]}
  },COUNTRIES[0]);
  assert.equal(sample.id,'way/123');
  assert.deepEqual({lat:sample.lat,lon:sample.lon},{lat:50,lon:15});
  assert.equal(campFromFeature(sample,COUNTRIES[0]).name,'Test');
  const zone = zoneFromFeature(parseFeature({
    type:'Feature',properties:{'@type':'relation','@id':456,boundary:'low_emission_zone',name:'Testovací zóna','motor_vehicle:conditional':'no @ (Mo-Fr 08:00-18:00)'},
    geometry:{type:'Polygon',coordinates:[[[14,49],[16,49],[16,51],[14,51],[14,49]]]}
  },COUNTRIES[0]),COUNTRIES[0]);
  assert.equal(zone.kind,'low_emission');
  assert.equal(zone.geometry.type,'Polygon');
  assert.equal(zone.rules['motor_vehicle:conditional'],'no @ (Mo-Fr 08:00-18:00)');
  assert.equal(paidParkingForOverlay({amenity:'parking',fee:'yes'}),false);
  assert.equal(paidParkingForOverlay({amenity:'parking',fee:'yes',maxstay:'2 hours'}),true);
  const compressionSample = {
    _meta:{generatedAt:'2026-01-01T00:00:00.000Z'},
    camps:{fetchedAt:1,data:[{id:'node/1',lat:50.1,lon:14.2,name:'Test'}]}
  };
  const compressedSample = compressBundleParts(compressionSample,COUNTRIES[0]);
  const compressedWrapper = JSON.parse(compressedSample.payload);
  assert.equal(compressedWrapper.compressed,'gzip-tab-files-v1');
  assert.equal(compressedWrapper.parts.camps.file,'map-data/cesko/camps.json.gz');
  assert.equal(compressedWrapper.parts.camps.count,1);
  assert.deepEqual(
    JSON.parse(gunzipSync(compressedSample.files[0].compressed).toString('utf8')),
    compressionSample.camps
  );
  const rawDescription = 'první řádek\ndruhý řádek';
  const rawRecord = '{"type":"Feature","geometry":{"type":"Point","coordinates":[14.2,50.1]},"properties":{"@type":"node","@id":7,"description":"' + rawDescription + '"}}';
  const secondRecord = JSON.stringify({type:'Feature',geometry:{type:'Point',coordinates:[14.3,50.2]},properties:{'@type':'node','@id':8}});
  const sequence = '\x1e' + rawRecord + '\n\x1e' + secondRecord + '\n';
  const records = [];
  for await (const record of readGeoJsonRecords(Readable.from([
    sequence.slice(0,73),sequence.slice(73,141),sequence.slice(141)
  ]))) records.push(record);
  assert.equal(records.length,2);
  assert.equal(records[0].properties.description,rawDescription);
  assert.equal(records[1].properties['@id'],8);
  console.log('Kontrola Geofabrik generátoru, filtrů a souřadnic: OK');
}

async function main(){
  if(process.argv.includes('--check')){ await runChecks(); return; }
  const requested = argumentValue('--countries');
  const countries = requested
    ? requested.split(',').map(id=>id.trim()).filter(Boolean).map(id=>{
        const country = COUNTRIES.find(item=>item.id===id);
        if(!country) throw new Error('Neznámý kód země: ' + id);
        return country;
      })
    : COUNTRIES;
  await run('osmium',['--version']);
  await rm(TEMP_DIR,{recursive:true,force:true});
  await mkdir(TEMP_DIR,{recursive:true});
  try{
    for(const country of countries) await buildCountry(country);
    for(const country of countries){
      const destinationDir=path.join(OUTPUT_DIR,'map-data',countryDataStem(country));
      await mkdir(destinationDir,{recursive:true});
      for(const id of [...Object.keys(TABS),'zones']){
        const relative=partRelativePath(country,id);
        await copyFile(path.join(TEMP_DIR,relative),path.join(OUTPUT_DIR,relative));
      }
      // Manifest kopíruj až po všech částech. V jednom gitovém commitu se pak
      // vždy zveřejní konzistentní sada dat dané země.
      await copyFile(path.join(TEMP_DIR,country.file),path.join(OUTPUT_DIR,country.file));
    }
    console.log('\nVšechny datové soubory byly úspěšně vytvořeny z výřezů Geofabrik.');
  }catch(error){
    console.error('\nAktualizace z Geofabriku selhala. Produkční JSON soubory zůstaly beze změny.');
    throw error;
  }finally{
    await rm(TEMP_DIR,{recursive:true,force:true});
  }
}

await main();
